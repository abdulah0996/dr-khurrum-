import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { VERIFIED_CLINIC, VERIFIED_GENERAL_SCHEDULE } from "../server/config/clinic.js";
import { models } from "../server/models/index.js";
import { cancelAppointment, createAppointment, deleteAppointments, rescheduleAppointment, toPublicAppointment, updateAppointmentStatus } from "../server/services/appointmentService.js";
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
    create: models.Appointment.create,
    deleteMany: models.Appointment.deleteMany
  },
  Patient: {
    findOne: models.Patient.findOne,
    findOneAndUpdate: models.Patient.findOneAndUpdate,
    create: models.Patient.create
  },
  WhatsAppConsent: { findOneAndUpdate: models.WhatsAppConsent.findOneAndUpdate },
  NotificationOutbox: { deleteMany: models.NotificationOutbox.deleteMany },
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
  models.Patient.findOneAndUpdate = async () => ({ patientId: "PAT-QA-1" });
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

test("a future appointment cannot be accidentally marked No-Show", async () => {
  const future = appointment({ date: nextWorkingDate(), time: "09:00" });
  let updateCalls = 0;
  models.Appointment.findOne = () => query(future);
  models.Appointment.findOneAndUpdate = () => {
    updateCalls += 1;
    return query({ ...future, status: "No-Show" });
  };

  await assert.rejects(
    updateAppointmentStatus(future.appointmentId, "No-Show", { role: "Super Admin", userId: "USR-QA" }, null, "Patient did not arrive"),
    (error) => error.status === 409 && /cannot be marked No-Show until/i.test(error.message)
  );
  assert.equal(updateCalls, 0);
});

test("No-Show requires a verification note and concurrent status changes cannot overwrite one another", async () => {
  const past = appointment({ date: addDaysIso(todayIso(), -1), time: "09:00" });
  await assert.rejects(
    updateAppointmentStatus(past.appointmentId, "No-Show", { role: "Receptionist", userId: "USR-QA" }),
    (error) => error.status === 422 && /verification note/i.test(error.message)
  );

  let reads = 0;
  let atomicFilter;
  models.Appointment.findOne = () => query(reads++ === 0 ? past : { ...past, status: "Visited" });
  models.Appointment.findOneAndUpdate = (filter) => {
    atomicFilter = filter;
    return query(null);
  };
  await assert.rejects(
    updateAppointmentStatus(past.appointmentId, "No-Show", { role: "Receptionist", userId: "USR-QA" }, null, "Patient did not arrive"),
    (error) => error.status === 409 && /changed to Visited/i.test(error.message)
  );
  assert.deepEqual(atomicFilter, { appointmentId: past.appointmentId, status: "Booked" });
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
  models.Patient.findOne = () => query({ patientId: existing.patientId, normalizedPhone: existing.normalizedPhone });
  models.Patient.findOneAndUpdate = async () => ({ patientId: existing.patientId, normalizedPhone: existing.normalizedPhone });
  models.WhatsAppConsent.findOneAndUpdate = async () => ({ optedIn: true });
  models.Appointment.create = async () => {
    const error = new Error("duplicate slot");
    error.code = 11000;
    error.keyPattern = { locationId: 1, date: 1, time: 1 };
    throw error;
  };

  const result = await createAppointment(
    {
      patientId: existing.patientId,
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

test("new registrations sharing the same contact and demographics receive distinct patient identities", async () => {
  const createdPatientIds = [];
  models.Appointment.find = () => query([]);
  models.Appointment.findOne = () => query(null);
  models.Patient.create = async ([record]) => {
    createdPatientIds.push(record.patientId);
    return [{ ...record }];
  };
  models.Appointment.create = async ([record]) => [appointment(record)];
  models.WhatsAppConsent.findOneAndUpdate = async () => ({ optedIn: true });
  const date = nextWorkingDate();
  const common = {
    fullName: "Shared Family Name",
    phone: "+923001234567",
    age: 12,
    gender: "Female",
    city: "Jhang",
    reasonForVisit: "Routine consultation",
    locationId: clinic.locationId,
    date,
    language: "en",
    source: "Reception",
    consentAccepted: true
  };

  const first = await createAppointment({ ...common, time: "09:00" }, { role: "Receptionist", userId: "USR-QA" });
  const second = await createAppointment({ ...common, time: "09:10" }, { role: "Receptionist", userId: "USR-QA" });
  assert.notEqual(first.patientId, second.patientId);
  assert.equal(new Set(createdPatientIds).size, 2);
});

test("an explicit patientId reuses only a patient belonging to the same normalized contact", async () => {
  const known = { patientId: "PAT-EXPLICIT-QA", phone: "+92 300 1234567", normalizedPhone: "+923001234567" };
  let updateFilter;
  models.Patient.findOne = () => query(known);
  models.Patient.findOneAndUpdate = (filter, update) => {
    updateFilter = filter;
    return Promise.resolve({ ...known, ...update.$set });
  };
  models.Appointment.find = () => query([]);
  models.Appointment.create = async ([record]) => [appointment(record)];
  models.WhatsAppConsent.findOneAndUpdate = async () => ({ optedIn: true });
  const result = await createAppointment({
    patientId: known.patientId,
    fullName: "Repeat Patient",
    phone: "+92 300 1234567",
    age: 30,
    gender: "Female",
    city: "Jhang",
    reasonForVisit: "Follow-up visit",
    locationId: clinic.locationId,
    date: nextWorkingDate(),
    time: "09:00",
    source: "Reception",
    consentAccepted: true
  }, { role: "Receptionist", userId: "USR-QA" });
  assert.equal(result.patientId, known.patientId);
  assert.deepEqual(updateFilter, { patientId: known.patientId, normalizedPhone: known.normalizedPhone });

  models.Patient.findOne = () => query({ ...known, normalizedPhone: "+923009999999" });
  await assert.rejects(
    createAppointment({
      patientId: known.patientId,
      fullName: "Wrong Contact",
      phone: "+923001234567",
      age: 30,
      gender: "Female",
      city: "Jhang",
      reasonForVisit: "Routine consultation",
      locationId: clinic.locationId,
      date: nextWorkingDate(),
      time: "09:10",
      source: "Reception",
      consentAccepted: true
    }),
    (error) => error.status === 409 && /does not belong/i.test(error.message)
  );
});

test("bulk deletion removes only selected appointments and their pending admin alerts", async () => {
  const selected = ["KHR-20260720-ONE001", "KHR-20260720-TWO002"];
  let appointmentDeleteFilter;
  let alertDeleteFilter;
  models.Appointment.find = () => ({
    select() { return this; },
    session() { return this; },
    async lean() { return selected.map((appointmentId) => ({ appointmentId })); }
  });
  models.Appointment.deleteMany = async (filter) => {
    appointmentDeleteFilter = filter;
    return { deletedCount: 2 };
  };
  models.NotificationOutbox.deleteMany = async (filter) => {
    alertDeleteFilter = filter;
    return { deletedCount: 1 };
  };

  const result = await deleteAppointments(selected, { role: "Super Admin", userId: "USR-QA" });

  assert.deepEqual(appointmentDeleteFilter, { appointmentId: { $in: selected } });
  assert.deepEqual(alertDeleteFilter, { appointmentId: { $in: selected } });
  assert.deepEqual(result, { requestedCount: 2, deletedCount: 2, missingCount: 0 });
});
