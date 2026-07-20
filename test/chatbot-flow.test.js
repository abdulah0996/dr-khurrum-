import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { VERIFIED_CLINIC, VERIFIED_GENERAL_SCHEDULE } from "../server/config/clinic.js";
import { models } from "../server/models/index.js";
import { handleChatMessage, resumeChatSession } from "../server/services/chatbotService.js";
import { addDaysIso, dayName, todayIso } from "../server/utils/time.js";

const originals = {
  startSession: mongoose.startSession,
  ChatSession: {
    findOne: models.ChatSession.findOne,
    create: models.ChatSession.create
  },
  ClinicLocation: {
    find: models.ClinicLocation.find,
    findOne: models.ClinicLocation.findOne
  },
  ScheduleRule: { findOne: models.ScheduleRule.findOne },
  BlockedSlot: { find: models.BlockedSlot.find },
  Appointment: {
    find: models.Appointment.find,
    findOne: models.Appointment.findOne,
    create: models.Appointment.create
  },
  Patient: {
    findOne: models.Patient.findOne,
    findOneAndUpdate: models.Patient.findOneAndUpdate,
    create: models.Patient.create
  },
  WhatsAppConsent: { findOneAndUpdate: models.WhatsAppConsent.findOneAndUpdate },
  AuditLog: { create: models.AuditLog.create }
};

const clinic = { ...VERIFIED_CLINIC, locationId: "LOC-VERIFIED" };
const schedule = { ...VERIFIED_GENERAL_SCHEDULE, ruleId: "SCH-VERIFIED", locationId: clinic.locationId };
let session;
let createdAppointment;

function query(value) {
  return { lean: async () => value };
}

function awaitableQuery(value) {
  return {
    lean: async () => value,
    then(resolve, reject) {
      return Promise.resolve(value).then(resolve, reject);
    }
  };
}

function nextWorkingDate(start = todayIso()) {
  let date = addDaysIso(start, 1);
  while (!VERIFIED_GENERAL_SCHEDULE.workingDays.includes(dayName(date))) date = addDaysIso(date, 1);
  return date;
}

function newSession(data) {
  return {
    ...data,
    markModified() {},
    async save() {
      return this;
    }
  };
}

test.before(() => {
  models.ChatSession.findOne = async ({ normalizedPhone }) =>
    session?.normalizedPhone === normalizedPhone ? session : null;
  models.ChatSession.create = async (data) => {
    session = newSession(data);
    return session;
  };

  models.ClinicLocation.find = () => ({ sort: () => query([clinic]) });
  models.ClinicLocation.findOne = () => query(clinic);
  models.ScheduleRule.findOne = () => query(schedule);
  models.BlockedSlot.find = () => query([]);
  models.Appointment.find = () => query([]);
  models.Appointment.findOne = () => query(null);
  models.Patient.findOne = () => ({ session: async () => null });
  models.Patient.create = async () => [{ patientId: "PAT-QA-1" }];
  models.Patient.findOneAndUpdate = async () => ({ patientId: "PAT-QA-1" });
  models.WhatsAppConsent.findOneAndUpdate = async () => ({ optedIn: true });
  models.AuditLog.create = async (data) => data;
  models.Appointment.create = async ([data]) => {
    createdAppointment = {
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
      toObject() {
        const { toObject: _toObject, ...plain } = this;
        return plain;
      }
    };
    return [createdAppointment];
  };
  mongoose.startSession = async () => ({
    async withTransaction(callback) {
      await callback();
    },
    async endSession() {}
  });
});

test.after(() => {
  mongoose.startSession = originals.startSession;
  for (const [modelName, methods] of Object.entries(originals)) {
    if (modelName === "startSession") continue;
    Object.assign(models[modelName], methods);
  }
});

async function chat(message, language) {
  return handleChatMessage({ phone: "+92 300 1234567", message, ...(language ? { language } : {}) });
}

test("a mocked end-to-end booking flow validates consent, guardian notice, clinic, date, slot, and token", async () => {
  session = undefined;
  createdAppointment = undefined;

  assert.match((await chat("hello")).text, /Dr\. Khurrum Mansoor/);
  const menu = await chat("1");
  assert.ok(menu.options.some((item) => item.value === "menu_book_appointment"));
  assert.doesNotMatch(menu.text, /1\.\s*Book Appointment/);
  assert.match((await chat("1")).text, /consent|save your name/i);
  assert.match((await chat("yes")).text, /full name/i);
  assert.match((await chat("Patient Name")).text, /phone number/i);
  assert.match((await chat("03001234567")).text, /patient age/i);

  const underage = await chat("17");
  assert.match(underage.text, /parent or legal guardian/i);
  assert.match((await chat("2")).text, /city/i);
  assert.match((await chat("Jhang")).text, /reason for visit/i);

  const locationReply = await chat("Routine consultation");
  assert.ok(locationReply.options.some((item) => item.label.includes("Nighat Medical Complex")));
  const dateReply = await chat("1");
  assert.match(dateReply.text, /available date/i);
  const timeReply = await chat("1");
  assert.match(timeReply.text, /available time/i);
  const confirmation = await chat("1");
  assert.match(confirmation.text, /Please confirm appointment/i);
  assert.match(confirmation.text, /Token:\s*1/);

  const booked = await chat("1");
  assert.equal(booked.appointment.status, "Booked");
  assert.equal(booked.appointment.locationId, clinic.locationId);
  assert.equal(booked.appointment.patientName, "Patient Name");
  assert.ok(Number.isInteger(booked.appointment.tokenNumber));
  assert.equal(Object.hasOwn(booked.appointment, "normalizedPhone"), false);
  assert.equal(Object.hasOwn(booked.appointment, "reasonForVisit"), false);
  assert.match(booked.text, /Token Number:/);
  assert.match(booked.text, new RegExp(`Appointment ID: ${booked.appointment.appointmentId}`));
  assert.match(booked.text, /Save this ID/);
  assert.equal(session.step, "menu");
});

test("an emergency message interrupts an in-progress booking and clears the draft", async () => {
  session = newSession({
    chatSessionId: "CHT-QA-2",
    normalizedPhone: "+923001234567",
    language: "en",
    step: "book_phone",
    draft: { consentAccepted: true, fullName: "Patient Name" }
  });

  const reply = await chat("heavy vaginal bleeding");
  assert.match(reply.text, /nearest hospital emergency department/i);
  assert.equal(session.step, "menu");
  assert.deepEqual(session.draft, {});
});

test("FEVER is saved as a routine reason and continues to clickable clinic and date selection", async () => {
  session = newSession({
    chatSessionId: "CHT-QA-FEVER",
    normalizedPhone: "+923001234567",
    language: "en",
    step: "book_reason",
    draft: {
      consentAccepted: true,
      fullName: "Patient Name",
      phone: "+923001234567",
      age: 30,
      gender: "Female",
      city: "Jhang"
    }
  });

  const reasonReply = await chat("FEVER");
  assert.equal(session.step, "book_location");
  assert.equal(session.draft.reasonForVisit, "FEVER");
  assert.equal(session.draft.reason, "FEVER");
  assert.match(reasonReply.text, /Reason Recorded/);
  assert.doesNotMatch(reasonReply.text, /emergency|medicine|medication|diagnos|treatment/i);
  assert.ok(reasonReply.options.some((item) => item.value.startsWith("clinic_")));

  const dateReply = await chat(reasonReply.options[0].value);
  assert.equal(session.step, "book_date");
  assert.ok(dateReply.options.some((item) => item.value.startsWith("date_")));
  assert.equal(session.draft.reasonForVisit, "FEVER");
});

test("booking Back navigation preserves the draft and long slot lists are paginated", async () => {
  const date = nextWorkingDate();
  session = newSession({
    chatSessionId: "CHT-QA-NAV",
    normalizedPhone: "+923001234567",
    language: "en",
    step: "book_time",
    draft: {
      consentAccepted: true,
      fullName: "Patient Name",
      phone: "+923001234567",
      age: 30,
      gender: "Female",
      city: "Jhang",
      reasonForVisit: "FEVER",
      reason: "FEVER",
      locationId: clinic.locationId,
      locationNameEn: clinic.nameEn,
      locationNameUr: clinic.nameUr,
      date,
      slotPage: 0
    }
  });

  const more = await chat("slots_more");
  assert.equal(session.step, "book_time");
  assert.equal(session.draft.slotPage, 1);
  assert.match(more.text, /Page 2 of/);
  assert.ok(more.options.some((item) => item.value === "slots_previous"));
  assert.ok(more.options.some((item) => item.value === "navigation_back"));
  assert.ok(more.options.some((item) => item.value === "main_menu"));
  assert.ok(more.options.length <= 10);

  const previous = await chat("slots_previous");
  assert.equal(session.draft.slotPage, 0);
  assert.match(previous.text, /Page 1 of/);

  const back = await chat("navigation_back");
  assert.equal(session.step, "book_date");
  assert.equal(session.draft.reasonForVisit, "FEVER");
  assert.ok(back.options.some((item) => item.value.startsWith("date_")));
});

test("invalid language and menu input remain recoverable without changing patient data", async () => {
  session = undefined;
  const language = await chat("not a language");
  assert.ok(language.options.some((item) => item.value === "language_english"));
  assert.doesNotMatch(language.text, /1\. English/);
  await chat("1");
  const reply = await chat("something unrelated");
  assert.match(reply.text, /choose one option/i);
  assert.equal(session.step, "menu");
});

test("fixed consent, gender, and language questions remain clickable after invalid input", async () => {
  session = newSession({ normalizedPhone: "+923001234567", language: "en", step: "book_consent", draft: {} });
  const consent = await chat("maybe");
  assert.ok(consent.options.some((item) => item.value === "consent_accept"));
  assert.ok(consent.options.some((item) => item.value === "consent_reject"));

  session.step = "book_gender";
  session.draft = { consentAccepted: true, fullName: "Patient Name", phone: "+923001234567", age: 30 };
  const gender = await chat("invalid choice");
  assert.deepEqual(gender.options.filter((item) => item.value.startsWith("gender_")).map((item) => item.value), ["gender_male", "gender_female", "gender_other"]);

  session.step = "menu";
  const language = await chat("9");
  assert.ok(language.options.some((item) => item.value === "language_english"));
  assert.ok(language.options.some((item) => item.value === "language_urdu"));
});

test("consent acceptance persists once and immediately enables the conversational patient-name step", async () => {
  session = newSession({
    chatSessionId: "CHT-CONSENT-QA",
    normalizedPhone: "+923001234567",
    language: "en",
    step: "book_consent",
    draft: {},
    processedInteractions: []
  });
  const request = {
    phone: "+92 300 1234567",
    message: "consent_accept",
    actionId: "consent_accept",
    interactionId: "consent-qa-0001",
    messageType: "poll_selection",
    language: "en"
  };

  const first = await handleChatMessage(request);
  const duplicate = await handleChatMessage(request);

  assert.equal(session.step, "book_name");
  assert.equal(session.draft.consentAccepted, true);
  assert.ok(session.draft.consentAcceptedAt instanceof Date);
  assert.equal(session.draft.fullName, undefined);
  assert.equal(session.processedInteractions.length, 1);
  assert.deepEqual(duplicate, first);
  assert.equal(first.nextStep, "book_name");
  assert.equal(first.input.mode, "text");
  assert.equal(first.input.placeholder, "Enter patient’s full name…");
  assert.match(first.text, /What is the patient’s full name/);

  const resumed = await resumeChatSession({ phone: "+92 300 1234567" });
  assert.equal(resumed.nextStep, "book_name");
  assert.equal(resumed.input.placeholder, "Enter patient’s full name…");
  assert.match(resumed.text, /Ahmed Khan/);
});

test("consent rejection stops collection and returns only safe exit choices", async () => {
  session = newSession({
    chatSessionId: "CHT-REJECT-QA",
    normalizedPhone: "+923001234567",
    language: "en",
    step: "book_consent",
    draft: {}
  });

  const reply = await handleChatMessage({
    phone: "+92 300 1234567",
    message: "consent_reject",
    actionId: "consent_reject",
    interactionId: "consent-qa-0002",
    messageType: "poll_selection"
  });

  assert.equal(session.step, "menu");
  assert.equal(session.draft.consentAccepted, false);
  assert.ok(session.draft.consentRejectedAt instanceof Date);
  assert.equal(reply.consentRejected, true);
  assert.doesNotMatch(reply.text, /full name|phone number/i);
  assert.deepEqual(reply.options.map((item) => item.value), ["main_menu", "menu_reception_contact"]);
});

test("patient names validate English and Urdu input, reject unsafe values, persist, and advance to phone", async () => {
  for (const invalid of ["1", "12345", "<script>alert(1)</script>", "$gt"]) {
    session = newSession({
      chatSessionId: `CHT-NAME-${invalid.length}`,
      normalizedPhone: "+923001234567",
      language: "en",
      step: "book_name",
      draft: { consentAccepted: true, consentAcceptedAt: new Date() }
    });
    const reply = await chat(invalid);
    assert.equal(session.step, "book_name");
    assert.match(reply.text, /complete name/i);
  }

  for (const name of ["Ahmed Khan", "علی احمد"]) {
    session = newSession({
      chatSessionId: `CHT-NAME-${name}`,
      normalizedPhone: "+923001234567",
      language: /[\u0600-\u06ff]/u.test(name) ? "ur" : "en",
      step: "book_name",
      draft: { consentAccepted: true, consentAcceptedAt: new Date() }
    });
    const reply = await chat(name);
    assert.equal(session.step, "book_phone");
    assert.equal(session.draft.fullName, name);
    assert.equal(reply.nextStep, "book_phone");
    assert.equal(reply.input.mode, "text");
    assert.match(reply.text, /phone|فون/u);
  }
});

test("appointment lookup and cancellation verify both ID and phone before changing status", async () => {
  const current = {
    appointmentId: "KHR-20260720-QA1234",
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
    source: "WhatsApp"
  };
  models.Appointment.findOne = () => awaitableQuery(current);
  models.Appointment.findOneAndUpdate = (_filter, update) => awaitableQuery({ ...current, ...update });

  session = newSession({ normalizedPhone: current.normalizedPhone, language: "en", step: "menu", draft: {} });
  assert.match((await chat("2")).text, /appointment ID/i);
  assert.match((await chat(current.appointmentId)).text, /phone number/i);
  const lookup = await chat(current.phone);
  assert.match(lookup.text, new RegExp(`Appointment ID: ${current.appointmentId}`));
  assert.match(lookup.text, /Nighat Medical Complex/);
  assert.match(lookup.text, /Token Number: 1/);

  assert.match((await chat("4")).text, /appointment ID/i);
  await chat(current.appointmentId);
  assert.match((await chat(current.phone)).text, /cancellation reason/i);
  assert.match((await chat("Schedule conflict")).text, /sure you want to cancel/i);
  const cancelled = await chat("1");
  assert.equal(cancelled.appointment.status, "Cancelled");
  assert.equal(Object.hasOwn(cancelled.appointment, "cancelledReason"), false);
  assert.match(cancelled.text, /cancelled/i);
});

test("chatbot rescheduling preserves the original until the replacement slot succeeds", async () => {
  const current = {
    appointmentId: "KHR-20260721-QA5678",
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
    source: "WhatsApp"
  };
  let capturedUpdate;
  models.Appointment.findOne = (filter) =>
    filter.appointmentId?.$ne !== undefined ? awaitableQuery(null) : awaitableQuery(current);
  models.Appointment.findOneAndUpdate = (_filter, update) => {
    capturedUpdate = update;
    return awaitableQuery({
      ...current,
      locationId: update.locationId,
      locationNameEn: update.locationNameEn,
      locationNameUr: update.locationNameUr,
      date: update.date,
      time: update.time,
      tokenNumber: update.tokenNumber,
      status: update.status,
      toObject() {
        const { toObject: _toObject, ...plain } = this;
        return plain;
      }
    });
  };

  session = newSession({ normalizedPhone: current.normalizedPhone, language: "en", step: "menu", draft: {} });
  await chat("3");
  await chat(current.appointmentId);
  const locations = await chat(current.phone);
  assert.ok(locations.options.some((item) => item.label.includes("Nighat Medical Complex")));
  await chat("1");
  await chat("1");
  const confirmation = await chat("1");
  assert.match(confirmation.text, /Confirm new appointment time/i);
  const changed = await chat("1");
  assert.equal(changed.appointment.status, "Rescheduled");
  assert.equal(capturedUpdate.$push.rescheduleHistory.fromDate, current.date);
  assert.equal(capturedUpdate.$push.rescheduleHistory.toDate, changed.appointment.date);
  assert.match(changed.text, /rescheduled/i);
});
