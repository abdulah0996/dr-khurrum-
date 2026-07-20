import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { APPOINTMENT_STATUS_TRANSITIONS } from "../server/services/appointmentService.js";
import { configuredRetention } from "../server/services/retentionService.js";
import { removesSuperAdminAccess } from "../server/services/adminInvariantService.js";
import { AppointmentSchema, PatientSchema, WebhookEventSchema } from "../server/models/index.js";
import { patientIdentityKey } from "../server/utils/time.js";
import { appointmentCreateSchema, blockedSlotSchema, locationSchema, scheduleSchema, strictBooleanSchema } from "../server/utils/validation.js";

test("shared contact numbers produce independent stable patient identities", () => {
  const parent = patientIdentityKey({ phone: "0300 1234567", fullName: "Ayesha Khan", gender: "Female" });
  const child = patientIdentityKey({ phone: "+92 300 1234567", fullName: "Hamza Khan", gender: "Male" });
  const repeat = patientIdentityKey({ phone: "+923001234567", fullName: "  AYESHA   KHAN ", gender: "Female" });
  assert.notEqual(parent, child);
  assert.equal(parent, repeat);
  const patientIndexes = PatientSchema.indexes();
  const appointmentIndexes = AppointmentSchema.indexes();
  assert.ok(patientIndexes.some(([keys, options]) => keys.identityKey === 1 && options.unique));
  assert.ok(appointmentIndexes.some(([keys, options]) => keys.patientId === 1 && keys.date === 1 && options.unique));
  assert.equal(appointmentIndexes.some(([keys, options]) => keys.normalizedPhone === 1 && keys.date === 1 && options.unique), false);
});

test("strict booleans accept only explicit true and false values", () => {
  assert.equal(strictBooleanSchema.parse("false"), false);
  assert.equal(strictBooleanSchema.parse("true"), true);
  assert.equal(strictBooleanSchema.parse(false), false);
  for (const invalid of ["yes", "0", 0, 1, null]) assert.equal(strictBooleanSchema.safeParse(invalid).success, false);
  assert.equal(locationSchema.parse({ nameEn: "Clinic", nameUr: "Clinic", addressEn: "Address", addressUr: "Address", city: "Jhang", active: "false" }).active, false);
  assert.equal(blockedSlotSchema.parse({ locationId: "LOC", date: "2026-08-01", fullDay: "true", reason: "Holiday" }).fullDay, true);
  const appointment = { fullName: "Ayesha Khan", phone: "+923001234567", age: 30, gender: "Female", city: "Jhang", reasonForVisit: "Routine visit", locationId: "LOC", date: "2026-08-01", time: "09:00" };
  assert.equal(appointmentCreateSchema.safeParse({ ...appointment, consentAccepted: "false" }).success, false);
  assert.equal(appointmentCreateSchema.safeParse({ ...appointment, consentAccepted: "yes" }).success, false);
});

test("appointment status matrix closes every terminal state", () => {
  assert.deepEqual(APPOINTMENT_STATUS_TRANSITIONS.Booked, ["Visited", "No-Show", "Cancelled"]);
  assert.deepEqual(APPOINTMENT_STATUS_TRANSITIONS.Rescheduled, ["Visited", "No-Show", "Cancelled"]);
  for (const status of ["Visited", "No-Show", "Cancelled"]) assert.deepEqual(APPOINTMENT_STATUS_TRANSITIONS[status], []);
});

test("last active Super Admin detection covers demotion and disable", () => {
  const admin = { role: "Super Admin", status: "Active" };
  assert.equal(removesSuperAdminAccess(admin, { role: "Receptionist" }), true);
  assert.equal(removesSuperAdminAccess(admin, { status: "Inactive" }), true);
  assert.equal(removesSuperAdminAccess(admin, { name: "Updated" }), false);
  assert.equal(removesSuperAdminAccess({ role: "Receptionist", status: "Active" }, { status: "Inactive" }), false);
});

test("webhook processing schema supports retry and terminal states without raw payload storage", () => {
  const status = WebhookEventSchema.path("status");
  assert.deepEqual(status.enumValues, ["received", "processing", "completed", "failed", "retrying", "dead_letter"]);
  assert.equal(WebhookEventSchema.path("rawPayload"), undefined);
  assert.ok(WebhookEventSchema.indexes().some(([keys, options]) => keys.provider === 1 && keys.providerEventId === 1 && options.unique));
});

test("retention is disabled by default and only enables explicitly approved operational collections", () => {
  assert.deepEqual(configuredRetention({}), []);
  assert.deepEqual(configuredRetention({ RETENTION_WEBHOOK_EVENT_DAYS: "30" }).map(({ model, days }) => ({ model, days })), [{ model: "WebhookEvent", days: 30 }]);
  assert.deepEqual(configuredRetention({ RETENTION_MESSAGE_LOG_DAYS: "0", RETENTION_AUDIT_LOG_DAYS: "-1" }), []);
  assert.equal(configuredRetention({ RETENTION_WEBHOOK_EVENT_DAYS: "30" }).some(({ model }) => ["Patient", "Appointment"].includes(model)), false);
});

test("day-specific unavailable intervals must align with unchanged slot boundaries", () => {
  const base = {
    workingDays: ["Monday"], openingTime: "09:00", closingTime: "12:00", slotDurationMinutes: 30, dailyLimit: 6,
    dayRules: [{ day: "Monday", working: true, openingTime: "09:00", closingTime: "12:00", slotDurationMinutes: 30, dailyLimit: 5, breaks: [{ breakId: "B1", startTime: "10:10", endTime: "10:40" }] }]
  };
  assert.equal(scheduleSchema.safeParse(base).success, false);
  base.dayRules[0].breaks[0] = { breakId: "B1", startTime: "10:00", endTime: "10:30" };
  assert.equal(scheduleSchema.safeParse(base).success, true);
});

test("frontend preserves section data, paginates appointments, and rotates refresh credentials", async () => {
  const source = await fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(source, /Promise\.allSettled/);
  assert.match(source, /appointments: current\.appointments/);
  assert.match(source, /appointmentPagination/);
  assert.match(source, />Previous<.*>Next</s);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /requestRef\.current\.sequence/);
  assert.match(source, /loadAllToday/);
  assert.match(source, /\/api\/auth\/refresh/);
  assert.match(source, /credentials: "include"/);
  assert.match(source, /refreshExcluded/);
});

test("request monitoring is registered before API routes and records safe paths", async () => {
  const source = await fs.readFile(new URL("../server/index.js", import.meta.url), "utf8");
  assert.ok(source.indexOf("app.use(requestId)") < source.indexOf('app.use("/api/auth"'));
  assert.ok(source.indexOf("app.use(accessLogger)") < source.indexOf('app.use("/api/auth"'));
  assert.ok(source.indexOf("app.use(requestTimeout())") < source.indexOf('app.use("/api/auth"'));
  const observability = await fs.readFile(new URL("../server/middleware/observability.js", import.meta.url), "utf8");
  assert.doesNotMatch(observability, /req\.body|authorization|cookie/i);
});
