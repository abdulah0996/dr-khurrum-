import test from "node:test";
import assert from "node:assert/strict";
import { VERIFIED_GENERAL_SCHEDULE } from "../server/config/clinic.js";
import { ensureRuntimeDefaults, PRODUCTION_ORIGIN } from "../server/config/runtime.js";
import { validateEnvironment } from "../server/config/validation.js";
import { sanitizeDatabaseError } from "../server/db/connection.js";
import { extractIncomingText } from "../server/routes/whatsapp.js";
import { generateScheduleSlots, isWithinAdvanceWindow } from "../server/services/slotService.js";
import { messageBodyForLog, sanitizeMessageLog } from "../server/services/whatsappService.js";
import { getMetricsSnapshot, recordMetric, resetMetrics } from "../server/services/monitoringService.js";
import { toMinutes } from "../server/utils/time.js";
import { adminStatusSchema, appointmentBulkDeleteSchema, blockedSlotSchema, dateSchema, isValidPatientName, scheduleSchema, timeSchema } from "../server/utils/validation.js";

function completeProductionEnvironment(overrides = {}) {
  return {
    NODE_ENV: "production",
    PORT: "4000",
    MONGODB_URI: "mongodb://localhost:27017/clinic",
    JWT_ACCESS_SECRET: "a".repeat(32),
    JWT_REFRESH_SECRET: "b".repeat(32),
    COOKIE_SECRET: "c".repeat(32),
    ADMIN_BOOTSTRAP_TOKEN: "d".repeat(32),
    WHATSAPP_API_VERSION: "v25.0",
    WHATSAPP_ACCESS_TOKEN: "access-token",
    WHATSAPP_PHONE_NUMBER_ID: "123456789",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "987654321",
    WHATSAPP_VERIFY_TOKEN: "verify-token",
    META_APP_SECRET: "e".repeat(32),
    APP_BASE_URL: "https://api.example.com",
    CLIENT_BASE_URL: "https://clinic.example.com",
    API_BASE_URL: "https://api.example.com/api",
    CORS_ALLOWED_ORIGINS: "https://clinic.example.com",
    DEFAULT_TIMEZONE: "Asia/Karachi",
    MONGODB_MIN_POOL_SIZE: "1",
    MONGODB_MAX_POOL_SIZE: "10",
    ...overrides
  };
}

test("date, time, and patient-name validation rejects malformed boundary input", () => {
  assert.equal(dateSchema.safeParse("2026-02-29").success, false);
  assert.equal(dateSchema.safeParse("2026-07-15").success, true);
  assert.equal(timeSchema.safeParse("24:00").success, false);
  assert.equal(timeSchema.safeParse("09:60").success, false);
  assert.equal(timeSchema.safeParse("09:15").success, true);
  assert.equal(toMinutes("99:99"), null);
  assert.equal(isValidPatientName("Ali😀"), false);
  assert.equal(isValidPatientName("<script>alert(1)</script>"), false);
  assert.equal(isValidPatientName("O'Connor"), true);
});

test("schedule validation rejects reversed, unpaired, misaligned, and excessive configurations", () => {
  const { timezone: _timezone, ...validSchedule } = VERIFIED_GENERAL_SCHEDULE;
  assert.equal(scheduleSchema.safeParse(validSchedule).success, true);
  assert.equal(scheduleSchema.safeParse({ ...validSchedule, closingTime: "08:00" }).success, false);
  assert.equal(scheduleSchema.safeParse({ ...validSchedule, breakStart: "13:00", breakEnd: "" }).success, false);
  assert.equal(scheduleSchema.safeParse({ ...validSchedule, breakStart: "13:05" }).success, false);
  assert.equal(scheduleSchema.safeParse({ ...validSchedule, dailyLimit: 31 }).success, false);
  assert.equal(scheduleSchema.safeParse({ ...validSchedule, workingDays: ["Monday", "Monday"] }).success, false);
  assert.deepEqual(generateScheduleSlots({ ...VERIFIED_GENERAL_SCHEDULE, openingTime: "bad" }, "2026-06-29"), []);
});

test("No-Show status validation requires a meaningful verification note", () => {
  assert.equal(adminStatusSchema.safeParse({ status: "No-Show" }).success, false);
  assert.equal(adminStatusSchema.safeParse({ status: "No-Show", reason: "  " }).success, false);
  assert.equal(adminStatusSchema.safeParse({ status: "No-Show", reason: "Patient did not arrive" }).success, true);
  assert.equal(adminStatusSchema.safeParse({ status: "Visited" }).success, true);
});

test("partial-day blocks require ordered start and end times", () => {
  const base = { locationId: "LOC-1", date: "2026-07-16", reason: "Doctor unavailable" };
  assert.equal(blockedSlotSchema.safeParse({ ...base, fullDay: true }).success, true);
  assert.equal(blockedSlotSchema.safeParse({ ...base, fullDay: false, startTime: "10:00" }).success, false);
  assert.equal(blockedSlotSchema.safeParse({ ...base, fullDay: false, startTime: "11:00", endTime: "10:00" }).success, false);
  assert.equal(blockedSlotSchema.safeParse({ ...base, fullDay: false, startTime: "10:00", endTime: "11:00" }).success, true);
});

test("advance-window comparisons reject invalid dates instead of relying on string ordering", () => {
  assert.equal(isWithinAdvanceWindow("not-a-date", "2026-07-15"), false);
  assert.equal(isWithinAdvanceWindow("2026-07-14", "2026-07-15"), false);
  assert.equal(isWithinAdvanceWindow("2026-08-14", "2026-07-15"), true);
});

test("production environment validation accepts a complete configuration and rejects unsafe values", () => {
  assert.equal(validateEnvironment(completeProductionEnvironment()).ok, true);
  assert.match(validateEnvironment(completeProductionEnvironment({ PORT: "70000" })).errors.join(" "), /PORT/);
  assert.match(validateEnvironment(completeProductionEnvironment({ APP_BASE_URL: "http:\/\/api.example.com" })).errors.join(" "), /APP_BASE_URL/);
  assert.equal(validateEnvironment(completeProductionEnvironment({ CORS_ALLOWED_ORIGINS: "https:\/\/clinic.example.com\/" })).ok, true);
  assert.match(validateEnvironment(completeProductionEnvironment({ CORS_ALLOWED_ORIGINS: "https:\/\/clinic.example.com\/path" })).errors.join(" "), /CORS_ALLOWED_ORIGINS/);
  assert.match(validateEnvironment(completeProductionEnvironment({ MONGODB_MIN_POOL_SIZE: "20", MONGODB_MAX_POOL_SIZE: "10" })).errors.join(" "), /must not exceed/);
  assert.equal(validateEnvironment(completeProductionEnvironment({ TRUST_PROXY: "loopback, 10.0.0.0/8" })).ok, true);
  assert.match(validateEnvironment(completeProductionEnvironment({ TRUST_PROXY: "true" })).errors.join(" "), /TRUST_PROXY/);
  assert.match(validateEnvironment(completeProductionEnvironment({ JWT_REFRESH_EXPIRES_IN: "forever" })).errors.join(" "), /JWT_REFRESH_EXPIRES_IN/);
  assert.match(validateEnvironment(completeProductionEnvironment({ RUN_PATIENT_IDENTITY_MIGRATION: "maybe" })).errors.join(" "), /RUN_PATIENT_IDENTITY_MIGRATION/);
});

test("production can launch web booking before Meta setup while strict WhatsApp mode fails closed", () => {
  const webOnlyEnvironment = completeProductionEnvironment({
    WHATSAPP_REQUIRED: "false",
    WHATSAPP_ACCESS_TOKEN: "",
    WHATSAPP_PHONE_NUMBER_ID: "",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "",
    WHATSAPP_VERIFY_TOKEN: "",
    META_APP_SECRET: ""
  });
  const webOnlyResult = validateEnvironment(webOnlyEnvironment);
  assert.equal(webOnlyResult.ok, true);
  assert.equal(webOnlyResult.whatsappConfigured, false);
  assert.equal(webOnlyResult.whatsappRequired, false);
  assert.match(webOnlyResult.warnings.join(" "), /Web booking remains available/);

  const strictResult = validateEnvironment({ ...webOnlyEnvironment, WHATSAPP_REQUIRED: "true" });
  assert.equal(strictResult.ok, false);
  assert.equal(strictResult.whatsappRequired, true);
  assert.match(strictResult.errors.join(" "), /WHATSAPP_ACCESS_TOKEN/);
  assert.match(validateEnvironment({ ...webOnlyEnvironment, WHATSAPP_REQUIRED: "later" }).errors.join(" "), /must be true or false/);
});

test("Hostinger production runtime supplies domain defaults but never generates production secrets", () => {
  const environment = {
    NODE_ENV: "production",
    MONGODB_URI: "mongodb://localhost:27017/clinic"
  };
  ensureRuntimeDefaults(environment);

  assert.equal(environment.APP_BASE_URL, PRODUCTION_ORIGIN);
  assert.equal(environment.CLIENT_BASE_URL, PRODUCTION_ORIGIN);
  assert.equal(environment.API_BASE_URL, `${PRODUCTION_ORIGIN}/api`);
  assert.equal(environment.CORS_ALLOWED_ORIGINS, PRODUCTION_ORIGIN);
  assert.equal(environment.DEFAULT_TIMEZONE, "Asia/Karachi");
  assert.equal(environment.WHATSAPP_REQUIRED, "false");
  assert.equal(environment.JWT_ACCESS_SECRET, undefined);
  assert.equal(environment.JWT_REFRESH_SECRET, undefined);
  assert.equal(environment.COOKIE_SECRET, undefined);
  assert.equal(environment.ADMIN_BOOTSTRAP_TOKEN, undefined);
  const validation = validateEnvironment(environment);
  assert.equal(validation.ok, false);
  assert.match(validation.errors.join(" "), /JWT_ACCESS_SECRET/);
});

test("bulk appointment deletion requires a bounded unique ID selection", () => {
  assert.equal(appointmentBulkDeleteSchema.safeParse({ appointmentIds: [] }).success, false);
  assert.equal(appointmentBulkDeleteSchema.safeParse({ appointmentIds: ["short"] }).success, false);
  assert.equal(appointmentBulkDeleteSchema.safeParse({ appointmentIds: Array.from({ length: 101 }, (_, index) => `KHR-20260720-${String(index).padStart(6, "0")}`) }).success, false);
  assert.deepEqual(
    appointmentBulkDeleteSchema.parse({ appointmentIds: ["KHR-20260720-ABC123", "KHR-20260720-ABC123"] }),
    { appointmentIds: ["KHR-20260720-ABC123"] }
  );
});

test("Hostinger production runtime pins the verified public origin", () => {
  const environment = {
    NODE_ENV: "production",
    APP_BASE_URL: "http://stale.invalid/path",
    CLIENT_BASE_URL: "*",
    API_BASE_URL: "not-a-url",
    CORS_ALLOWED_ORIGINS: "*"
  };

  ensureRuntimeDefaults(environment);

  assert.equal(environment.APP_BASE_URL, PRODUCTION_ORIGIN);
  assert.equal(environment.CLIENT_BASE_URL, PRODUCTION_ORIGIN);
  assert.equal(environment.API_BASE_URL, `${PRODUCTION_ORIGIN}/api`);
  assert.equal(environment.CORS_ALLOWED_ORIGINS, PRODUCTION_ORIGIN);
});

test("WhatsApp interactive replies are extracted and operational logs redact patient content", () => {
  assert.equal(extractIncomingText({ interactive: { button_reply: { title: "Book Appointment", id: "menu_book_appointment" } } }), "menu_book_appointment");
  assert.equal(extractIncomingText({ interactive: { list_reply: { title: "10:30 AM", id: "time:10:30" } } }), "time:10:30");
  assert.equal(extractIncomingText({ button: { payload: "menu" } }), "menu");
  assert.equal(messageBodyForLog("patient_message", "Patient Name has severe pain"), "");
  const safe = sanitizeMessageLog({
    phone: "+923357504478",
    normalizedPhone: "+923357504478",
    messageBody: "private reason",
    rawPayload: { recipient_id: "923357504478" },
    status: "delivered"
  });
  assert.equal(safe.phone, "+923****478");
  assert.equal(safe.normalizedPhone, "+923****478");
  assert.equal(safe.messageBody, "");
  assert.equal(JSON.stringify(safe).includes("recipient_id"), false);
});

test("database errors and in-memory metrics avoid credentials and request query data", () => {
  const credentialUri = ["mongodb", "+srv://", "admin", ":", "secret", "@", "example.mongodb.net/clinic?token=abc"].join("");
  const safeError = sanitizeDatabaseError(new Error(`failed ${credentialUri}`));
  assert.doesNotMatch(safeError, /admin|secret|token=abc|example\.mongodb\.net/);
  resetMetrics();
  recordMetric("apiErrors", { method: "GET", path: "/api/patients?phone=+923357504478", status: 500, durationMs: 25 });
  const metrics = getMetricsSnapshot();
  assert.equal(metrics.apiErrors.count, 1);
  assert.equal(metrics.apiErrors.lastMetadata.path, "/api/patients");
});
