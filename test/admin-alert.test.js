import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { models, NotificationOutboxSchema } from "../server/models/index.js";
import { validateEnvironment } from "../server/config/validation.js";
import {
  ADMIN_ALERT_TEMPLATE,
  adminAlertConfig,
  buildAdminAlertParameters,
  claimAdminAlert,
  processOneAdminAlert,
  queueAdminAppointmentAlert,
  retryAdminAppointmentAlert,
  updateAdminAlertDeliveryStatus,
  validateAdminAlertConfig
} from "../server/services/adminAlertService.js";
import { sendTemplateMessage } from "../server/services/whatsappService.js";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

function configuredEnv() {
  Object.assign(process.env, {
    WHATSAPP_ADMIN_ALERT_ENABLED: "true",
    WHATSAPP_ADMIN_ALERT_NUMBER: "923001234567",
    WHATSAPP_ADMIN_ALERT_TEMPLATE: "apointment_book_system_",
    WHATSAPP_ADMIN_ALERT_LANGUAGE: "en",
    WHATSAPP_API_VERSION: "v25.0",
    WHATSAPP_ACCESS_TOKEN: "qa-access-token",
    WHATSAPP_PHONE_NUMBER_ID: "123456789",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "987654321",
    WHATSAPP_VERIFY_TOKEN: "qa-verify-token",
    META_APP_SECRET: "m".repeat(64)
  });
}

function appointment(overrides = {}) {
  return {
    appointmentId: "KHR-20260725-QA001",
    patientName: "Ayesha Khan",
    doctorName: "Dr. Khurrum Mansoor",
    date: "2026-07-25",
    time: "10:30",
    tokenNumber: 10,
    status: "Booked",
    reasonForVisit: "private medical reason",
    ...overrides
  };
}

function query(value) {
  return { lean: async () => value };
}

test.afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  global.fetch = originalFetch;
});

test("admin alert uses the exact reviewed template and six values in the required order", () => {
  configuredEnv();
  assert.equal(ADMIN_ALERT_TEMPLATE, "apointment_book_system_");
  assert.deepEqual(buildAdminAlertParameters(appointment()), [
    "Ayesha Khan",
    "Dr. Khurrum Mansoor",
    "25 July 2026",
    "10:30 AM",
    "10",
    "KHR-20260725-QA001"
  ]);
  assert.deepEqual(adminAlertConfig(), {
    enabled: true,
    recipientPhone: "923001234567",
    templateName: "apointment_book_system_",
    templateLanguage: "en"
  });
});

test("admin alert configuration is disabled by default and rejects invalid private numbers", () => {
  delete process.env.WHATSAPP_ADMIN_ALERT_ENABLED;
  assert.deepEqual(validateAdminAlertConfig(adminAlertConfig()), { ok: true, enabled: false });
  configuredEnv();
  process.env.WHATSAPP_ADMIN_ALERT_NUMBER = "+92 300-1234567";
  assert.equal(validateAdminAlertConfig(adminAlertConfig()).code, "INVALID_RECIPIENT");
});

test("confirmed appointment queues one unique outbox record while disabled mode queues nothing", async () => {
  const original = models.NotificationOutbox.updateOne;
  let calls = 0;
  let captured;
  models.NotificationOutbox.updateOne = async (...args) => { calls += 1; captured = args; return { upsertedCount: 1 }; };
  try {
    process.env.WHATSAPP_ADMIN_ALERT_ENABLED = "false";
    assert.equal((await queueAdminAppointmentAlert(appointment())).status, "disabled");
    assert.equal(calls, 0);
    configuredEnv();
    assert.equal((await queueAdminAppointmentAlert(appointment())).queued, true);
    assert.equal(calls, 1);
    assert.deepEqual(captured[0], {
      appointmentId: "KHR-20260725-QA001",
      notificationType: "ADMIN_NEW_APPOINTMENT_ALERT",
      recipientPhone: "923001234567"
    });
    assert.deepEqual(captured[1].$setOnInsert.templateParameters, buildAdminAlertParameters(appointment()));
    assert.equal(captured[2].upsert, true);
  } finally {
    models.NotificationOutbox.updateOne = original;
  }
});

test("outbox schema enforces one recipient alert per appointment", () => {
  const unique = NotificationOutboxSchema.indexes().find(([fields, options]) =>
    fields.appointmentId === 1 && fields.notificationType === 1 && fields.recipientPhone === 1 && options.unique
  );
  assert.ok(unique);
  assert.deepEqual(NotificationOutboxSchema.path("status").enumValues, ["queued", "sending", "sent", "delivered", "read", "failed", "dead_letter"]);
});

test("existing WhatsApp transport sends the exact template payload without medical data", async () => {
  configuredEnv();
  let payload;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return new Response(JSON.stringify({ messages: [{ id: "wamid.admin-alert" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const parameters = buildAdminAlertParameters(appointment());
  const result = await sendTemplateMessage({
    to: "923001234567",
    templateName: ADMIN_ALERT_TEMPLATE,
    languageCode: "en",
    parameters
  });
  assert.equal(result.providerMessageId, "wamid.admin-alert");
  assert.equal(payload.template.name, "apointment_book_system_");
  assert.equal(payload.template.language.code, "en");
  assert.deepEqual(payload.template.components[0].parameters.map((item) => item.text), parameters);
  assert.doesNotMatch(JSON.stringify(payload), /private medical reason|reasonForVisit|symptom/i);
});

test("template sender safely classifies temporary and permanent Meta failures", async () => {
  configuredEnv();
  global.fetch = async () => new Response(JSON.stringify({ error: { code: 4, message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } });
  const temporary = await sendTemplateMessage({ to: "923001234567", templateName: ADMIN_ALERT_TEMPLATE, languageCode: "en", parameters: buildAdminAlertParameters(appointment()) });
  assert.equal(temporary.temporary, true);
  assert.equal(temporary.failureCode, "META_4");
  global.fetch = async () => new Response(JSON.stringify({ error: { code: 132001, message: "template not approved" } }), { status: 400, headers: { "content-type": "application/json" } });
  const permanent = await sendTemplateMessage({ to: "923001234567", templateName: ADMIN_ALERT_TEMPLATE, languageCode: "en", parameters: buildAdminAlertParameters(appointment()) });
  assert.equal(permanent.temporary, false);
  assert.equal(permanent.failureCode, "META_132001");
  assert.doesNotMatch(permanent.failureMessageSafe, /not approved/i);
});

test("temporary failures schedule a bounded retry and stale sending jobs are reclaimable", async () => {
  configuredEnv();
  const originalOutbox = models.NotificationOutbox.findOneAndUpdate;
  const originalAppointment = models.Appointment.findOne;
  const updates = [];
  let call = 0;
  const now = new Date("2026-07-20T12:00:00.000Z");
  const notification = {
    notificationId: "NTF-QA",
    appointmentId: appointment().appointmentId,
    notificationType: "ADMIN_NEW_APPOINTMENT_ALERT",
    recipientPhone: "923001234567",
    templateName: ADMIN_ALERT_TEMPLATE,
    templateLanguage: "en",
    templateParameters: buildAdminAlertParameters(appointment()),
    status: "sending",
    attemptCount: 1
  };
  models.NotificationOutbox.findOneAndUpdate = (filter, update) => {
    updates.push({ filter, update });
    call += 1;
    return query(call === 1 ? notification : { ...notification, status: "failed" });
  };
  models.Appointment.findOne = () => query(appointment());
  global.fetch = async () => new Response("{}", { status: 503, headers: { "content-type": "application/json" } });
  try {
    const failed = await processOneAdminAlert({ now });
    assert.equal(failed.status, "failed");
    assert.equal(updates[1].update.$set.nextRetryAt.toISOString(), "2026-07-20T12:01:00.000Z");
    assert.ok(updates[0].filter.$or.some((item) => item.status === "sending" && item.lockExpiresAt));
  } finally {
    models.NotificationOutbox.findOneAndUpdate = originalOutbox;
    models.Appointment.findOne = originalAppointment;
  }
});

test("successful processing stores the Meta provider ID and does not alter the appointment", async () => {
  configuredEnv();
  const originalOutbox = models.NotificationOutbox.findOneAndUpdate;
  const originalAppointment = models.Appointment.findOne;
  let call = 0;
  let finalUpdate;
  const notification = {
    notificationId: "NTF-SUCCESS",
    appointmentId: appointment().appointmentId,
    recipientPhone: "923001234567",
    templateName: ADMIN_ALERT_TEMPLATE,
    templateLanguage: "en",
    templateParameters: buildAdminAlertParameters(appointment()),
    status: "sending",
    attemptCount: 1
  };
  models.NotificationOutbox.findOneAndUpdate = (_filter, update) => {
    call += 1;
    if (call === 2) finalUpdate = update;
    return query(call === 1 ? notification : { ...notification, status: "sent", providerMessageId: "wamid.saved" });
  };
  models.Appointment.findOne = () => query(appointment());
  global.fetch = async () => new Response(JSON.stringify({ messages: [{ id: "wamid.saved" }] }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const sent = await processOneAdminAlert({ now: new Date("2026-07-20T12:00:00.000Z") });
    assert.equal(sent.providerMessageId, "wamid.saved");
    assert.equal(finalUpdate.$set.status, "sent");
    assert.equal(finalUpdate.$set.providerMessageId, "wamid.saved");
  } finally {
    models.NotificationOutbox.findOneAndUpdate = originalOutbox;
    models.Appointment.findOne = originalAppointment;
  }
});

test("delivery webhooks advance monotonically and duplicate updates are idempotent", async () => {
  const originalFind = models.NotificationOutbox.findOne;
  const originalUpdate = models.NotificationOutbox.findOneAndUpdate;
  let current = { notificationId: "NTF-WEBHOOK", providerMessageId: "wamid.webhook", status: "sent", attemptCount: 1 };
  let writes = 0;
  models.NotificationOutbox.findOne = () => query(current);
  models.NotificationOutbox.findOneAndUpdate = (_filter, update) => {
    writes += 1;
    current = { ...current, ...update.$set };
    return query(current);
  };
  try {
    assert.equal((await updateAdminAlertDeliveryStatus("wamid.webhook", "delivered")).status, "delivered");
    assert.equal((await updateAdminAlertDeliveryStatus("wamid.webhook", "delivered")).status, "delivered");
    assert.equal((await updateAdminAlertDeliveryStatus("wamid.webhook", "read")).status, "read");
    assert.equal((await updateAdminAlertDeliveryStatus("wamid.webhook", "failed", "131000")).status, "read");
    assert.equal(writes, 2);
    current = { ...current, status: "failed" };
    assert.equal((await updateAdminAlertDeliveryStatus("wamid.webhook", "failed", "131000")).status, "failed");
    assert.equal(writes, 2);
  } finally {
    models.NotificationOutbox.findOne = originalFind;
    models.NotificationOutbox.findOneAndUpdate = originalUpdate;
  }
});

test("manual retry resets only a failed alert and never touches appointment creation", async () => {
  const originalUpdate = models.NotificationOutbox.findOneAndUpdate;
  let update;
  models.NotificationOutbox.findOneAndUpdate = (_filter, value) => {
    update = value;
    return query({ appointmentId: appointment().appointmentId, status: "queued", attemptCount: 0 });
  };
  try {
    const result = await retryAdminAppointmentAlert(appointment().appointmentId, { schedule: false });
    assert.equal(result.status, "queued");
    assert.equal(update.$set.providerMessageId, "");
    assert.equal(update.$set.attemptCount, 0);
  } finally {
    models.NotificationOutbox.findOneAndUpdate = originalUpdate;
  }
});

test("environment validation and the existing UI guard the reviewed alert configuration", () => {
  const env = {
    ...originalEnv,
    NODE_ENV: "development",
    MONGODB_URI: "mongodb://localhost/qa_test",
    JWT_ACCESS_SECRET: "a".repeat(64),
    JWT_REFRESH_SECRET: "b".repeat(64),
    COOKIE_SECRET: "c".repeat(64),
    ADMIN_BOOTSTRAP_TOKEN: "d".repeat(64),
    DEFAULT_TIMEZONE: "Asia/Karachi",
    WHATSAPP_ADMIN_ALERT_ENABLED: "true",
    WHATSAPP_ADMIN_ALERT_NUMBER: "923001234567",
    WHATSAPP_ADMIN_ALERT_TEMPLATE: "apointment_book_system_",
    WHATSAPP_ADMIN_ALERT_LANGUAGE: "en",
    WHATSAPP_API_VERSION: "v25.0",
    WHATSAPP_ACCESS_TOKEN: "token",
    WHATSAPP_PHONE_NUMBER_ID: "phone-id",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "business-id",
    WHATSAPP_VERIFY_TOKEN: "verify-token",
    META_APP_SECRET: "e".repeat(64)
  };
  assert.equal(validateEnvironment(env).ok, true);
  env.WHATSAPP_ADMIN_ALERT_NUMBER = "+923001234567";
  assert.equal(validateEnvironment(env).ok, false);
  const ui = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(ui, /Personal alert:/);
  assert.match(ui, /Retry Alert/);
  assert.match(ui, /admin-alert\/retry/);
});
