import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { VERIFIED_CLINIC, VERIFIED_GENERAL_SCHEDULE } from "../server/config/clinic.js";
import { models } from "../server/models/index.js";
import { cancelAppointment, createAppointment, rescheduleAppointment, toPublicAppointment } from "../server/services/appointmentService.js";
import { addDaysIso, dayName, todayIso } from "../server/utils/time.js";

const originals = {
  startSession: mongoose.startSession,
  ClinicLocation: { findOne: models.ClinicLocation.findOne },
  ScheduleRule: { findOne: models.ScheduleRule.findOne },
  BlockedSlot: { find: models.BlockedSlot.find },
  Appointment: {
    find: models.Appointment.find,
    findOne: models.Appointment.findOne,
    findOneAndUpdate: models.Appointment.findOneAndUpdate,
    create: models.Appointment.create
  },
  Patient: {
    findOne: models.Patient.findOne,
    create: models.Patient.create
  },
  WhatsAppConsent: { findOneAndUpdate: models.WhatsAppConsent.findOneAndUpdate },
  AuditLog: { create: models.AuditLog.create }
};

const clinic = { ...VERIFIED_CLINIC, locationId: "LOC-SERVICE-QA" };
const schedule = { ...VERIFIED_GENERAL_SCHEDULE, locationId: clinic.locationId, ruleId: "SCH-SERVICE-QA" };

function query(value) {
  return { lean: async () => value };
}

function nextWorkingDate(start = todayIso()) {
  let date = addDaysIso(start, 1);
  while (!VERIFIED_GENERAL_SCHEDULE.workingDays.includes(dayName(date))) date = addDaysIso(date, 1);
  return date;
}

function appointment(overrides = {}) {
  const item = {
    appointmentId: "KHR-20260716-QA1234",
    patientId: "PAT-QA-1",
    patientName: "Patient Name",
    phone: "+923001234567",
    normalizedPhone: "+923001234567",
    age: 30,
    gender: "Female",
    city: "Jhang",
    locationId: clinic.locationId,
    locationNameEn: clinic.nameEn,
    locationNameUr: clinic.nameUr,
    doctorName: "Dr. Khurrum Mansoor",
    date: nextWorkingDate(),
    time: "09:00",
    tokenNumber: 1,
    status: "Booked",
    source: "WhatsApp",
    ...overrides
  };
  item.toObject = function toObject() {
    const { toObject: _toObject, ...plain } = this;
    return plain;
  };
  return item;
}

test.before(() => {
  models.ClinicLocation.findOne = () => query(clinic);
  models.ScheduleRule.findOne = () => query(schedule);
  models.BlockedSlot.find = () => query([]);
  models.Appointment.find = () => query([]);
  models.AuditLog.create = async (data) => data;
  mongoose.startSession = async () => ({
    ended: false,
    async withTransaction(callback) {
      await callback();
    },
    async endSession() {
      this.ended = true;
    }
  });
});

test.after(() => {
  mongoose.startSession = originals.startSession;
  for (const [modelName, methods] of Object.entries(originals)) {
    if (modelName === "startSession") continue;
    Object.assign(models[modelName], methods);
  }
});

test("public appointment output masks phone numbers and omits the reason for visit", () => {
  const result = toPublicAppointment(appointment({ reasonForVisit: "private health details" }));
  assert.equal(result.maskedPhone, "+923****567");
  assert.equal(Object.hasOwn(result, "reasonForVisit"), false);
  assert.equal(Object.hasOwn(result, "normalizedPhone"), false);
});

test("cancellation is idempotent and an active cancellation records its source", async () => {
  const alreadyCancelled = appointment({ status: "Cancelled" });
  let updateCalls = 0;
  models.Appointment.findOne = () => query(alreadyCancelled);
  models.Appointment.findOneAndUpdate = () => {
    updateCalls += 1;
    return query(null);
  };

  const unchanged = await cancelAppointment(
    { appointmentId: alreadyCancelled.appointmentId, phone: alreadyCancelled.phone, reason: "No longer needed" },
    { role: "Patient", userId: "Patient" }
  );
  assert.equal(unchanged.status, "Cancelled");
  assert.equal(updateCalls, 0);

  const active = appointment();
  let capturedUpdate;
  models.Appointment.findOne = () => query(active);
  models.Appointment.findOneAndUpdate = (_filter, update) => {
    updateCalls += 1;
    capturedUpdate = update;
    return query({ ...active, ...update });
  };
  const cancelled = await cancelAppointment(
    { appointmentId: active.appointmentId, phone: active.phone, reason: "Schedule conflict" },
    { role: "Receptionist", userId: "USR-QA" }
  );
  assert.equal(cancelled.status, "Cancelled");
  assert.equal(cancelled.cancelledSource, "Admin");
  assert.equal(capturedUpdate.cancelledReason, "Schedule conflict");
  assert.equal(capturedUpdate.requiresReschedule, false);
  assert.equal(capturedUpdate.rescheduleReason, "");
  assert.equal(updateCalls, 1);
});

test("patient cancellation and rescheduling are blocked inside the two-hour cutoff", async () => {
  const imminent = appointment({ date: todayIso(), time: "00:00" });
  models.Appointment.findOne = () => query(imminent);
  await assert.rejects(
    cancelAppointment(
      { appointmentId: imminent.appointmentId, phone: imminent.phone, reason: "Cannot attend", language: "en" },
      { role: "Patient", userId: "Patient" }
    ),
    (error) => error.status === 409 && error.patientSafe === true && /within two hours/i.test(error.message)
  );

  models.Appointment.findOne = async () => imminent;
  await assert.rejects(
    rescheduleAppointment(
      {
        appointmentId: imminent.appointmentId,
        phone: imminent.phone,
        locationId: clinic.locationId,
        date: nextWorkingDate(),
        time: "10:00",
        language: "en"
      },
      { role: "Patient", userId: "Patient" }
    ),
    (error) => error.status === 409 && error.patientSafe === true && /within two hours/i.test(error.message)
  );
});

test("rescheduling validates and atomically records the old and new slot", async () => {
  const current = appointment();
  const newDate = nextWorkingDate(addDaysIso(current.date, 1));
  let capturedUpdate;
  models.Appointment.findOne = (filter) =>
    typeof filter.appointmentId === "string" ? Promise.resolve(current) : query(null);
  models.Appointment.findOneAndUpdate = (_filter, update) => {
    capturedUpdate = update;
    return appointment({ ...current, ...update, date: newDate, time: "10:00", tokenNumber: 5, status: "Rescheduled" });
  };

  const result = await rescheduleAppointment(
    {
      appointmentId: current.appointmentId,
      phone: current.phone,
      locationId: clinic.locationId,
      date: newDate,
      time: "10:00",
      language: "en"
    },
    { role: "Receptionist", userId: "USR-QA" }
  );

  assert.equal(result.status, "Rescheduled");
  assert.equal(result.date, newDate);
  assert.equal(capturedUpdate.$push.rescheduleHistory.fromDate, current.date);
  assert.equal(capturedUpdate.$push.rescheduleHistory.toDate, newDate);
  assert.equal(capturedUpdate.$push.rescheduleHistory.changedBy, "USR-QA");
});

test("a duplicate-key booking race returns the already-created matching appointment", async () => {
  const date = nextWorkingDate();
  const existing = appointment({ date, time: "09:00", tokenNumber: 1 });
  let duplicateChecks = 0;

  models.Appointment.findOne = (filter) => {
    if (filter.appointmentId?.$ne !== undefined) {
      duplicateChecks += 1;
      return query(null);
    }
    return query(existing);
  };
  models.Patient.findOne = () => ({ session: async () => null });
  models.Patient.create = async () => [{ patientId: "PAT-QA-RACE" }];
  models.WhatsAppConsent.findOneAndUpdate = async () => ({ optedIn: true });
  models.Appointment.create = async () => {
    const error = new Error("duplicate slot");
    error.code = 11000;
    error.keyPattern = { locationId: 1, date: 1, time: 1 };
    throw error;
  };

  const result = await createAppointment(
    {
      fullName: "Patient Name",
      phone: "+923001234567",
      age: 30,
      gender: "Female",
      city: "Jhang",
      reasonForVisit: "Routine consultation",
      locationId: clinic.locationId,
      date,
      time: "09:00",
      language: "en",
      source: "WhatsApp",
      consentAccepted: true
    },
    { role: "Patient", userId: "Patient" }
  );

  assert.equal(result.appointmentId, existing.appointmentId);
  assert.equal(result.tokenNumber, 1);
  assert.equal(duplicateChecks, 1);
});
