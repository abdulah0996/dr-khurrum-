import "dotenv/config";
// This check is intentionally separate from the fast, database-free unit suite.
import assert from "node:assert/strict";
import { connectDatabase, disconnectDatabase } from "../server/db/connection.js";
import { models } from "../server/models/index.js";
import { VERIFIED_CLINIC } from "../server/config/clinic.js";
import { cancelAppointment, createAppointment, rescheduleAppointment } from "../server/services/appointmentService.js";
import { handleChatMessage, resumeChatSession } from "../server/services/chatbotService.js";
import { getAvailability } from "../server/services/slotService.js";
import { addDaysIso, dayName, todayIso } from "../server/utils/time.js";
import { setupClinic } from "./setup-clinic.js";

function safeTestDatabaseName(uri) {
  const match = String(uri || "").match(/\.net\/([^?]+)/i);
  return match?.[1] || "";
}

async function run() {
  const uri = process.env.TEST_MONGODB_URI;
  const databaseName = safeTestDatabaseName(uri);
  if (!uri || !/_test$/i.test(databaseName)) {
    throw new Error("TEST_MONGODB_URI must target a database whose name ends with _test. No data was changed.");
  }

  process.env.MONGODB_URI = uri;
  process.env.NODE_ENV = "test";
  await connectDatabase();
  assert.equal(models.Appointment.db.name, databaseName);
  await Promise.all(Object.values(models).map((model) => model.init()));

  const runId = `QA-${Date.now().toString(36).toUpperCase()}`;
  const actor = { userId: runId, role: "Receptionist" };
  const locationId = `${runId}-LOC`;
  const ruleId = `${runId}-SCH`;
  let testDate = addDaysIso(todayIso("Asia/Karachi"), 2);
  while (["Saturday", "Sunday"].includes(dayName(testDate))) testDate = addDaysIso(testDate, 1);
  const rangeDate = addDaysIso(testDate, 1);
  const chatPhone = "+923000009999";

  try {
    await setupClinic();
    await setupClinic();
    const verifiedClinic = await models.ClinicLocation.findOne({ slug: VERIFIED_CLINIC.slug }).lean();
    assert.ok(verifiedClinic?.locationId);
    assert.equal(await models.ClinicLocation.countDocuments({ slug: VERIFIED_CLINIC.slug }), 1);
    assert.equal(await models.ScheduleRule.countDocuments({ locationId: verifiedClinic.locationId }), 1);
    assert.equal(await models.DoctorProfile.countDocuments({ profileKey: "primary" }), 1);
    await Promise.all([
      models.ScheduleRule.deleteMany({ locationId: verifiedClinic.locationId }),
      models.ClinicLocation.deleteMany({ locationId: verifiedClinic.locationId }),
      models.DoctorProfile.deleteMany({ profileKey: "primary" })
    ]);

    await models.DoctorProfile.create({
      doctorProfileId: `${runId}-DOC`,
      profileKey: runId,
      nameEn: "QA Doctor",
      nameUr: "کیو اے ڈاکٹر",
      qualificationsEn: "QA verified",
      qualificationsUr: "تصدیق شدہ",
      specialtyEn: "Integration testing",
      specialtyUr: "ٹیسٹنگ",
      receptionPhone: "+923001234567",
      pendingQualifications: ["QA pending"],
      languages: ["English", "Urdu"],
      services: [{ serviceId: "qa-service", titleEn: "QA service", titleUr: "کیو اے سروس" }],
      active: true
    });
    const persistedDoctor = await models.DoctorProfile.findOne({ profileKey: runId }).lean();
    assert.deepEqual(persistedDoctor.languages, ["English", "Urdu"]);

    await models.ClinicLocation.create({
      locationId,
      slug: `${runId.toLowerCase()}-clinic`,
      nameEn: `${runId} Integration Clinic`,
      nameUr: "کیو اے کلینک",
      addressEn: "Controlled test database",
      addressUr: "کنٹرولڈ ٹیسٹ ڈیٹابیس",
      city: "Jhang",
      country: "Pakistan",
      phone: "+923001234567",
      consultationMode: "Test only",
      active: true
    });

    const rule = {
      ruleId,
      locationId,
      workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      openingTime: "09:00",
      closingTime: "12:00",
      breakStart: "10:30",
      breakEnd: "11:00",
      slotDurationMinutes: 30,
      dailyLimit: 5,
      timezone: "Asia/Karachi",
      dayRules: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => ({
        day,
        working: true,
        openingTime: "09:00",
        closingTime: "12:00",
        slotDurationMinutes: 30,
        dailyLimit: 4,
        breaks: [
          { breakId: `${day}-one`, startTime: "10:00", endTime: "10:30", labelEn: "First break", labelUr: "پہلا وقفہ" },
          { breakId: `${day}-two`, startTime: "11:00", endTime: "11:30", labelEn: "Second break", labelUr: "دوسرا وقفہ" }
        ]
      })),
      active: true
    };
    await models.ScheduleRule.create(rule);
    const persistedRule = await models.ScheduleRule.findOne({ ruleId }).lean();
    assert.equal(persistedRule.dailyLimit, 5);
    assert.equal(persistedRule.dayRules[0].breaks.length, 2);

    const chatSession = await models.ChatSession.create({
      chatSessionId: `${runId}-CHAT`,
      normalizedPhone: chatPhone,
      language: "en",
      step: "book_consent",
      draft: {},
      lastMessageAt: new Date()
    });
    const consentRequest = {
      phone: chatPhone,
      message: "consent_accept",
      actionId: "consent_accept",
      interactionId: `${runId}-CONSENT`,
      messageType: "poll_selection",
      language: "en"
    };
    const consentReply = await handleChatMessage(consentRequest);
    const duplicateConsentReply = await handleChatMessage(consentRequest);
    assert.deepEqual(duplicateConsentReply, consentReply);
    let reloadedSession = await models.ChatSession.findOne({ normalizedPhone: chatPhone }).lean();
    assert.equal(reloadedSession.step, "book_name");
    assert.equal(reloadedSession.draft.consentAccepted, true);
    assert.ok(reloadedSession.draft.consentAcceptedAt instanceof Date);
    assert.equal(reloadedSession.processedInteractions.length, 1);
    assert.equal((await resumeChatSession({ phone: chatPhone })).input.placeholder, "Enter patient’s full name…");

    const nameReply = await handleChatMessage({
      phone: chatPhone,
      message: "Ahmed Khan",
      interactionId: `${runId}-NAME`,
      messageType: "text",
      language: "en"
    });
    assert.equal(nameReply.nextStep, "book_phone");
    reloadedSession = await models.ChatSession.findOne({ normalizedPhone: chatPhone }).lean();
    assert.equal(reloadedSession.step, "book_phone");
    assert.equal(reloadedSession.draft.fullName, "Ahmed Khan");
    assert.equal((await resumeChatSession({ phone: chatPhone })).nextStep, "book_phone");

    await models.SpecialSchedule.create({
      specialScheduleId: `${runId}-SPC`,
      locationId,
      date: testDate,
      working: true,
      openingTime: "10:00",
      closingTime: "12:00",
      slotDurationMinutes: 30,
      dailyLimit: 4,
      breaks: [{ breakId: "qa-break", startTime: "11:00", endTime: "11:30", labelEn: "QA break", labelUr: "وقفہ" }],
      active: true,
      createdBy: runId
    });
    const overridden = await getAvailability({ locationId, date: testDate });
    assert.deepEqual(overridden.slots.map((slot) => slot.time), ["10:00", "10:30", "11:30"]);
    assert.equal(overridden.effectiveSchedule.specialScheduleId, `${runId}-SPC`);
    await models.SpecialSchedule.updateOne({ specialScheduleId: `${runId}-SPC` }, { $set: { openingTime: "10:30" } });
    assert.equal((await getAvailability({ locationId, date: testDate })).slots.some((slot) => slot.time === "10:00"), false);
    await models.SpecialSchedule.updateOne({ specialScheduleId: `${runId}-SPC` }, { $set: { openingTime: "10:00" } });
    assert.equal((await getAvailability({ locationId, date: testDate })).slots.some((slot) => slot.time === "10:00"), true);

    await models.BlockedSlot.create({
      blockedSlotId: `${runId}-BLK`,
      locationId,
      date: rangeDate,
      dateEnd: addDaysIso(rangeDate, 1),
      fullDay: true,
      reason: "Controlled range test",
      leaveType: "Leave",
      createdBy: runId,
      active: true
    });
    const rangedBlock = await getAvailability({ locationId, date: rangeDate });
    assert.equal(rangedBlock.availableSlots.length, 0);
    assert.equal(rangedBlock.closed, true);

    const payload = (phone, name) => ({
      fullName: name,
      phone,
      age: 30,
      gender: "Female",
      city: "Jhang",
      reasonForVisit: "Controlled integration test",
      locationId,
      date: testDate,
      time: "10:00",
      language: "en",
      source: "Reception",
      consentAccepted: true
    });
    const race = await Promise.allSettled([
      createAppointment(payload("+923000000101", "QA Patient One"), actor),
      createAppointment(payload("+923000000102", "QA Patient Two"), actor)
    ]);
    assert.equal(race.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(race.filter((item) => item.status === "rejected").length, 1);
    assert.equal(race.find((item) => item.status === "rejected").reason.status, 409);

    const booked = await models.Appointment.find({ locationId, date: testDate, time: "10:00", status: { $in: ["Booked", "Rescheduled"] } }).lean();
    assert.equal(booked.length, 1);
    assert.equal(booked[0].tokenNumber, 1);
    const winner = race.find((item) => item.status === "fulfilled").value;
    const rescheduled = await rescheduleAppointment({
      appointmentId: winner.appointmentId,
      phone: winner.normalizedPhone,
      locationId,
      date: testDate,
      time: "10:30",
      language: "en"
    }, actor);
    assert.equal(rescheduled.status, "Rescheduled");
    assert.equal(rescheduled.tokenNumber, 2);
    assert.equal(rescheduled.rescheduleHistory.length, 1);
    let afterChange = await getAvailability({ locationId, date: testDate });
    assert.equal(afterChange.slots.find((slot) => slot.time === "10:00").available, true);
    assert.equal(afterChange.slots.find((slot) => slot.time === "10:30").available, false);

    const cancelled = await cancelAppointment({ appointmentId: winner.appointmentId, phone: winner.normalizedPhone, reason: "Controlled integration cancellation", language: "en" }, actor);
    assert.equal(cancelled.status, "Cancelled");
    const cancelledAgain = await cancelAppointment({ appointmentId: winner.appointmentId, phone: winner.normalizedPhone, reason: "Duplicate cancellation", language: "en" }, actor);
    assert.equal(cancelledAgain.status, "Cancelled");
    afterChange = await getAvailability({ locationId, date: testDate });
    assert.equal(afterChange.slots.find((slot) => slot.time === "10:30").available, true);
    console.log("Dedicated MongoDB integration checks passed", {
      database: databaseName,
      setupIdempotency: true,
      doctorPersistence: true,
      configurationPersistence: true,
      multipleBreakPersistence: true,
      chatSessionReload: true,
      consentAndNamePersistence: true,
      interactionIdempotency: true,
      sessionResume: true,
      specialScheduleOverride: true,
      immediateScheduleRefresh: true,
      dateRangeBlocking: true,
      simultaneousBookingProtection: true,
      reschedulingAndCancellation: true
    });
  } finally {
    const configuredClinic = await models.ClinicLocation.findOne({ slug: VERIFIED_CLINIC.slug }).select("locationId").lean();
    const patients = await models.Patient.find({ fullName: /^QA Patient/ }).select("patientId normalizedPhone").lean();
    const patientIds = patients.map((item) => item.patientId);
    const phones = patients.map((item) => item.normalizedPhone);
    await Promise.all([
      models.Appointment.deleteMany({ locationId }),
      models.Patient.deleteMany({ patientId: { $in: patientIds } }),
      models.WhatsAppConsent.deleteMany({ normalizedPhone: { $in: phones } }),
      models.SpecialSchedule.deleteMany({ locationId }),
      models.BlockedSlot.deleteMany({ locationId }),
      models.ScheduleRule.deleteMany({ locationId }),
      models.ClinicLocation.deleteMany({ locationId }),
      models.DoctorProfile.deleteMany({ profileKey: runId }),
      models.ChatSession.deleteMany({ normalizedPhone: chatPhone }),
      models.AuditLog.deleteMany({ actorUserId: runId })
    ]);
    if (configuredClinic?.locationId) {
      await models.ScheduleRule.deleteMany({ locationId: configuredClinic.locationId });
      await models.ClinicLocation.deleteMany({ locationId: configuredClinic.locationId });
    }
    await models.DoctorProfile.deleteMany({ profileKey: "primary" });
    assert.equal(await models.Appointment.countDocuments({ locationId }), 0);
    await disconnectDatabase();
  }
}

run().catch(async (error) => {
  console.error("Dedicated MongoDB integration checks failed:", error.message);
  await disconnectDatabase().catch(() => {});
  process.exitCode = 1;
});
