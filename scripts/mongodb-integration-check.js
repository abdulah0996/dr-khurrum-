import "dotenv/config";
// This check is intentionally separate from the fast, database-free unit suite.
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../server/db/connection.js";
import { models } from "../server/models/index.js";
import { VERIFIED_CLINIC } from "../server/config/clinic.js";
import { cancelAppointment, createAppointment, rescheduleAppointment } from "../server/services/appointmentService.js";
import { handleChatMessage, resumeChatSession } from "../server/services/chatbotService.js";
import { getAvailability } from "../server/services/slotService.js";
import { addDaysIso, dayName, todayIso } from "../server/utils/time.js";
import { setupClinic } from "./setup-clinic.js";
import { acquireDisposableTestMongo } from "./lib/test-mongodb.js";
import { runSafeMigrations } from "../server/db/migrations.js";
import { issueAuthSession, rotateAuthSession } from "../server/services/authSessionService.js";
import { acquireInvariantLock } from "../server/services/adminInvariantService.js";
import { buildAdminAlertParameters, queueAdminAppointmentAlert } from "../server/services/adminAlertService.js";
import { updateDoctorProfile } from "../server/services/clinicConfigService.js";

async function attemptSuperAdminDemotion(userId) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => {
      await acquireInvariantLock("active-super-admin-invariant", session);
      const others = await models.User.countDocuments({
        userId: { $ne: userId },
        role: "Super Admin",
        status: "Active"
      }).session(session);
      if (others === 0) throw new Error("final active Super Admin");
      await models.User.updateOne({ userId }, { $set: { role: "Receptionist" } }, { session });
      return userId;
    });
  } finally {
    await session.endSession();
  }
}

async function run() {
  disposableMongo = await acquireDisposableTestMongo({ databaseName: "khurrum_integration_test" });
  const { uri, databaseName } = disposableMongo;

  process.env.MONGODB_URI = uri;
  process.env.NODE_ENV = "test";
  process.env.RUN_PATIENT_IDENTITY_MIGRATION = "true";
  process.env.JWT_ACCESS_SECRET ||= "x".repeat(64);
  process.env.JWT_REFRESH_SECRET ||= "y".repeat(64);
  process.env.COOKIE_SECRET ||= "z".repeat(64);
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
  const originalFetch = global.fetch;
  const originalAdminAlertEnv = Object.fromEntries([
    "WHATSAPP_ADMIN_ALERT_ENABLED", "WHATSAPP_ADMIN_ALERT_NUMBER", "WHATSAPP_ADMIN_ALERT_TEMPLATE", "WHATSAPP_ADMIN_ALERT_LANGUAGE",
    "WHATSAPP_API_VERSION", "WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID", "WHATSAPP_VERIFY_TOKEN", "META_APP_SECRET"
  ].map((key) => [key, process.env[key]]));

  try {
    await setupClinic();
    await setupClinic();
    const verifiedClinic = await models.ClinicLocation.findOne({ slug: VERIFIED_CLINIC.slug }).lean();
    assert.ok(verifiedClinic?.locationId);
    assert.equal(await models.ClinicLocation.countDocuments({ slug: VERIFIED_CLINIC.slug }), 1);
    assert.equal(await models.ScheduleRule.countDocuments({ locationId: verifiedClinic.locationId }), 1);
    assert.equal(await models.DoctorProfile.countDocuments({ profileKey: "primary" }), 1);
    const updatedDoctor = await updateDoctorProfile({
      nameEn: "Dr. Khurrum Mansoor",
      nameUr: "ڈاکٹر خرم منصور",
      qualificationsEn: "MBBS",
      qualificationsUr: "ایم بی بی ایس",
      specialtyEn: "Consultant Gynecologist",
      specialtyUr: "ماہر امراض نسواں",
      biographyEn: "Verified integration profile.",
      biographyUr: "تصدیق شدہ پروفائل۔",
      receptionPhone: "+923001234567",
      pendingQualifications: ["FCPS"],
      languages: ["English", "Urdu"],
      services: [],
      profileImage: "",
      active: true
    });
    assert.equal(updatedDoctor.receptionPhone, "+923001234567");
    assert.deepEqual(updatedDoctor.pendingQualifications, ["FCPS"]);
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

    Object.assign(process.env, {
      WHATSAPP_ADMIN_ALERT_ENABLED: "true",
      WHATSAPP_ADMIN_ALERT_NUMBER: "923001234567",
      WHATSAPP_ADMIN_ALERT_TEMPLATE: "apointment_book_system_",
      WHATSAPP_ADMIN_ALERT_LANGUAGE: "en",
      WHATSAPP_API_VERSION: "v25.0",
      WHATSAPP_ACCESS_TOKEN: "controlled-integration-token",
      WHATSAPP_PHONE_NUMBER_ID: "123456789",
      WHATSAPP_BUSINESS_ACCOUNT_ID: "987654321",
      WHATSAPP_VERIFY_TOKEN: "controlled-integration-verify",
      META_APP_SECRET: "m".repeat(64)
    });
    let adminAlertPayload;
    global.fetch = async (_url, options) => {
      adminAlertPayload = JSON.parse(options.body);
      return new Response(JSON.stringify({ messages: [{ id: `wamid.${runId}.admin` }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    await assert.rejects(createAppointment({ ...payload("+923000000104", "QA Patient Failed"), time: "08:00" }, actor));
    assert.equal(await models.NotificationOutbox.countDocuments({ notificationType: "ADMIN_NEW_APPOINTMENT_ALERT" }), 0);
    const alertAppointment = await createAppointment(payload("+923000000103", "QA Patient Alert"), actor);
    const deadline = Date.now() + 3000;
    let adminAlert;
    while (Date.now() < deadline) {
      adminAlert = await models.NotificationOutbox.findOne({ appointmentId: alertAppointment.appointmentId }).lean();
      if (adminAlert?.status === "sent") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(adminAlert?.status, "sent");
    assert.equal(adminAlert.providerMessageId, `wamid.${runId}.admin`);
    assert.deepEqual(adminAlert.templateParameters, buildAdminAlertParameters(alertAppointment));
    assert.deepEqual(adminAlertPayload.template.components[0].parameters.map((item) => item.text), buildAdminAlertParameters(alertAppointment));
    await queueAdminAppointmentAlert(alertAppointment);
    assert.equal(await models.NotificationOutbox.countDocuments({ appointmentId: alertAppointment.appointmentId }), 1);
    assert.equal((await models.Appointment.findOne({ appointmentId: alertAppointment.appointmentId }).lean()).status, "Booked");

    global.fetch = async () => new Response(JSON.stringify({ error: { code: 2, message: "controlled temporary failure" } }), {
      status: 503,
      headers: { "content-type": "application/json" }
    });
    const alertFailureAppointment = await createAppointment({
      ...payload("+923000000105", "QA Patient Alert Failure"),
      time: "10:30"
    }, actor);
    const failureDeadline = Date.now() + 3000;
    let failedAdminAlert;
    while (Date.now() < failureDeadline) {
      failedAdminAlert = await models.NotificationOutbox.findOne({ appointmentId: alertFailureAppointment.appointmentId }).lean();
      if (failedAdminAlert?.status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(failedAdminAlert?.status, "failed");
    assert.ok(failedAdminAlert.nextRetryAt instanceof Date);
    assert.equal((await models.Appointment.findOne({ appointmentId: alertFailureAppointment.appointmentId }).lean()).status, "Booked");
    assert.equal(await models.NotificationOutbox.countDocuments({ appointmentId: alertFailureAppointment.appointmentId }), 1);
    global.fetch = originalFetch;

    const legacyPatient = await models.Patient.create({
      patientId: `${runId}-LEGACY-PAT`,
      fullName: "Legacy Family Patient",
      phone: "+923000008888",
      normalizedPhone: "+923000008888",
      age: 20,
      gender: "Female",
      city: "Jhang",
      reasonForVisit: "Migration verification",
      consentAccepted: false
    });
    await models.Appointment.create({
      appointmentId: `${runId}-LEGACY-APT`,
      patientId: legacyPatient.patientId,
      patientName: legacyPatient.fullName,
      phone: legacyPatient.phone,
      normalizedPhone: legacyPatient.normalizedPhone,
      age: legacyPatient.age,
      gender: legacyPatient.gender,
      city: legacyPatient.city,
      reasonForVisit: legacyPatient.reasonForVisit,
      locationId,
      locationNameEn: "Integration Clinic",
      locationNameUr: "Integration Clinic",
      doctorName: "QA Doctor",
      date: addDaysIso(testDate, 10),
      time: "09:00",
      tokenNumber: 1,
      status: "Booked",
      source: "Reception"
    });
    const firstMigration = await runSafeMigrations();
    const secondMigration = await runSafeMigrations();
    assert.equal(firstMigration.patientIdentities.alreadyApplied, undefined);
    assert.equal(secondMigration.patientIdentities.alreadyApplied, true);
    assert.ok((await models.Patient.findOne({ patientId: legacyPatient.patientId }).lean()).identityKey);

    const authUser = await models.User.create({
      userId: `${runId}-AUTH`,
      name: "Integration Admin",
      email: `${runId.toLowerCase()}@example.invalid`,
      passwordHash: await bcrypt.hash("Integration-Password-42!", 4),
      role: "Super Admin",
      status: "Active"
    });
    const firstCookie = {};
    await issueAuthSession(authUser, { cookie: (_name, value) => { firstCookie.value = value; } });
    const rotatedCookie = {};
    const rotated = await rotateAuthSession(
      { headers: { cookie: `khurrum_refresh=${encodeURIComponent(firstCookie.value)}` } },
      { cookie: (_name, value) => { rotatedCookie.value = value; } }
    );
    assert.ok(rotated?.token);
    assert.notEqual(rotatedCookie.value, firstCookie.value);
    assert.equal(await models.AuthSession.countDocuments({ userId: authUser.userId, revokedAt: null }), 1);
    const tamperedCookie = `${rotatedCookie.value.slice(0, -1)}${rotatedCookie.value.endsWith("a") ? "b" : "a"}`;
    assert.equal(await rotateAuthSession(
      { headers: { cookie: `khurrum_refresh=${encodeURIComponent(tamperedCookie)}` } },
      { cookie: () => {} }
    ), null);
    assert.equal(await models.AuthSession.countDocuments({ userId: authUser.userId, revokedAt: null }), 1);
    assert.equal(await rotateAuthSession(
      { headers: { cookie: `khurrum_refresh=${encodeURIComponent(firstCookie.value)}` } },
      { cookie: () => {} }
    ), null);
    assert.equal(await models.AuthSession.countDocuments({ userId: authUser.userId, revokedAt: null }), 0);

    const concurrentAdmins = await models.User.create([
      {
        userId: `${runId}-ADMIN-A`, name: "Concurrency Admin A", email: `${runId.toLowerCase()}-a@example.invalid`,
        passwordHash: authUser.passwordHash, role: "Super Admin", status: "Active"
      },
      {
        userId: `${runId}-ADMIN-B`, name: "Concurrency Admin B", email: `${runId.toLowerCase()}-b@example.invalid`,
        passwordHash: authUser.passwordHash, role: "Super Admin", status: "Active"
      }
    ]);
    await models.User.updateOne({ userId: authUser.userId }, { $set: { role: "Receptionist" } });
    const demotions = await Promise.allSettled(concurrentAdmins.map((admin) => attemptSuperAdminDemotion(admin.userId)));
    assert.equal(demotions.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(demotions.filter((result) => result.status === "rejected").length, 1);
    assert.equal(await models.User.countDocuments({ role: "Super Admin", status: "Active" }), 1);
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
      reschedulingAndCancellation: true,
      patientMigrationIdempotency: true,
      refreshRotationAndReuseRevocation: true,
      lastSuperAdminConcurrency: true,
      adminAppointmentAlertOutbox: true
    });
  } finally {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalAdminAlertEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const configuredClinic = await models.ClinicLocation.findOne({ slug: VERIFIED_CLINIC.slug }).select("locationId").lean();
    const patients = await models.Patient.find({ fullName: /^QA Patient/ }).select("patientId normalizedPhone").lean();
    const testAppointments = await models.Appointment.find({ locationId }).select("appointmentId").lean();
    const patientIds = patients.map((item) => item.patientId);
    const phones = patients.map((item) => item.normalizedPhone);
    await Promise.all([
      models.Appointment.deleteMany({ locationId }),
      models.NotificationOutbox.deleteMany({ appointmentId: { $in: testAppointments.map((item) => item.appointmentId) } }),
      models.Patient.deleteMany({ patientId: { $in: patientIds } }),
      models.WhatsAppConsent.deleteMany({ normalizedPhone: { $in: phones } }),
      models.SpecialSchedule.deleteMany({ locationId }),
      models.BlockedSlot.deleteMany({ locationId }),
      models.ScheduleRule.deleteMany({ locationId }),
      models.ClinicLocation.deleteMany({ locationId }),
      models.DoctorProfile.deleteMany({ profileKey: runId }),
      models.ChatSession.deleteMany({ normalizedPhone: chatPhone }),
      models.AuditLog.deleteMany({ actorUserId: runId }),
      models.AuthSession.deleteMany({ userId: `${runId}-AUTH` }),
      models.User.deleteMany({ userId: { $in: [`${runId}-AUTH`, `${runId}-ADMIN-A`, `${runId}-ADMIN-B`] } })
    ]);
    if (configuredClinic?.locationId) {
      await models.ScheduleRule.deleteMany({ locationId: configuredClinic.locationId });
      await models.ClinicLocation.deleteMany({ locationId: configuredClinic.locationId });
    }
    await models.DoctorProfile.deleteMany({ profileKey: "primary" });
    assert.equal(await models.Appointment.countDocuments({ locationId }), 0);
    await disconnectDatabase();
    await disposableMongo.stop();
  }
}

let disposableMongo;
run().catch(async (error) => {
  console.error("Dedicated MongoDB integration checks failed:", error.message);
  await disconnectDatabase().catch(() => {});
  await disposableMongo?.stop().catch(() => {});
  process.exitCode = 1;
});
