import test from "node:test";
import assert from "node:assert/strict";
import { models } from "../server/models/index.js";
import {
  appointmentTemplateComponents,
  claimWebhookEventForRetry,
  processDueWebhookEvents,
  recordWebhookEvent,
  sendAppointmentWhatsApp,
  sendWhatsAppText,
  updateMessageStatus
} from "../server/services/whatsappService.js";

const originalFetch = global.fetch;
const originalWarn = console.warn;
const originalEnvironment = { ...process.env };
const originals = {
  MessageLog: {
    create: models.MessageLog.create,
    findOne: models.MessageLog.findOne,
    findOneAndUpdate: models.MessageLog.findOneAndUpdate,
    updateOne: models.MessageLog.updateOne
  },
  WhatsAppConsent: {
    findOne: models.WhatsAppConsent.findOne,
    findOneAndUpdate: models.WhatsAppConsent.findOneAndUpdate
  },
  AuditLog: { create: models.AuditLog.create },
  WebhookEvent: {
    create: models.WebhookEvent.create,
    find: models.WebhookEvent.find,
    findOne: models.WebhookEvent.findOne,
    findOneAndUpdate: models.WebhookEvent.findOneAndUpdate
  }
};

let consent;
let capturedLog;
let capturedRequest;

test.before(() => {
  Object.assign(process.env, {
    WHATSAPP_API_VERSION: "v25.0",
    WHATSAPP_ACCESS_TOKEN: "qa-access-token",
    WHATSAPP_PHONE_NUMBER_ID: "123456789",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "987654321",
    WHATSAPP_VERIFY_TOKEN: "qa-verify-token",
    META_APP_SECRET: "s".repeat(32),
    WHATSAPP_RETRY_ATTEMPTS: "0",
    WHATSAPP_HTTP_TIMEOUT_MS: "5000"
  });
  consent = { optedIn: true, nonEssentialOptOut: false, failureCount: 0, lastMessageAt: new Date() };
  models.WhatsAppConsent.findOne = () => ({ lean: async () => consent });
  models.WhatsAppConsent.findOneAndUpdate = async () => consent;
  models.MessageLog.create = async (data) => {
    capturedLog = data;
    return data;
  };
  models.MessageLog.findOne = () => ({ lean: async () => capturedLog });
  models.AuditLog.create = async (data) => data;
});

test.after(() => {
  global.fetch = originalFetch;
  console.warn = originalWarn;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  Object.assign(process.env, originalEnvironment);
  for (const [modelName, methods] of Object.entries(originals)) Object.assign(models[modelName], methods);
});

test("a mocked in-window WhatsApp send uses the configured API version and stores only redacted metadata", async () => {
  capturedLog = undefined;
  capturedRequest = undefined;
  global.fetch = async (url, options) => {
    capturedRequest = { url, options };
    return new Response(JSON.stringify({ messages: [{ id: "wamid.qa-success" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const result = await sendWhatsAppText({
    to: "+923001234567",
    text: "Private patient conversation",
    messageType: "chatbot_reply",
    patientInitiated: true
  });

  assert.equal(result.sent, true);
  assert.match(capturedRequest.url, /graph\.facebook\.com\/v25\.0\/123456789\/messages/);
  assert.equal(JSON.parse(capturedRequest.options.body).type, "text");
  assert.equal(capturedLog.messageBody, "");
  assert.equal(capturedLog.rawPayload, null);
});

test("an interactive rejection falls back once to a numbered text menu", async () => {
  consent = { optedIn: true, nonEssentialOptOut: false, failureCount: 0, lastMessageAt: new Date() };
  const payloads = [];
  global.fetch = async (_url, options) => {
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (payload.type === "interactive") {
      return new Response(JSON.stringify({ error: { message: "Interactive message rejected" } }), { status: 400, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ messages: [{ id: "wamid.qa-fallback" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const result = await sendWhatsAppText({
    to: "+923001234567",
    text: "How may we help you today?",
    options: [
      { label: "Book Appointment", value: "menu_book_appointment" },
      { label: "Check Appointment", value: "menu_check_appointment" }
    ],
    patientInitiated: true
  });

  assert.equal(result.sent, true);
  assert.equal(result.usedInteractiveFallback, true);
  assert.deepEqual(payloads.map((item) => item.type), ["interactive", "text"]);
  assert.doesNotMatch(payloads[0].interactive.body.text, /1\. Book Appointment/);
  assert.match(payloads[1].text.body, /1\. Book Appointment/);
});

test("a mocked Meta failure is returned safely without persisting the response payload", async () => {
  capturedLog = undefined;
  global.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Temporary provider failure", private_detail: "not for logs" } }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });

  const result = await sendWhatsAppText({
    to: "+923001234567",
    text: "Sensitive reason for visit",
    messageType: "chatbot_reply",
    patientInitiated: true
  });

  assert.equal(result.sent, false);
  assert.equal(result.status, "failed");
  assert.equal(capturedLog.messageBody, "");
  assert.equal(capturedLog.rawPayload, null);
  assert.equal(JSON.stringify(capturedLog).includes("private_detail"), false);
});

test("outside-window operational messages use an approved template and opt-outs block manual messages", async () => {
  process.env.WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION = "appointment_confirmation_v1";
  consent = { optedIn: true, nonEssentialOptOut: false, failureCount: 0, lastMessageAt: new Date(Date.now() - 25 * 60 * 60 * 1000) };
  global.fetch = async (_url, options) => {
    capturedRequest = options;
    return new Response(JSON.stringify({ messages: [{ id: "wamid.qa-template" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const appointment = {
    doctorName: "Dr. Khurrum Mansoor",
    date: "2026-07-20",
    time: "09:00",
    locationNameEn: "Nighat Medical Complex",
    tokenNumber: 1,
    appointmentId: "KHR-20260720-QA1234"
  };
  const templated = await sendWhatsAppText({
    to: "+923001234567",
    text: "Appointment confirmed",
    messageType: "appointment_confirmation",
    operational: true,
    templateComponents: appointmentTemplateComponents(appointment)
  });
  assert.equal(templated.sent, true);
  assert.equal(JSON.parse(capturedRequest.body).type, "template");

  let fetchCalled = false;
  let policyWarning = "";
  console.warn = (...values) => {
    policyWarning = values.map(String).join(" ");
  };
  consent = { ...consent, nonEssentialOptOut: true };
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("should not send");
  };
  const blocked = await sendWhatsAppText({
    to: "+923001234567",
    text: "Non-essential update",
    messageType: "manual_message"
  });
  assert.equal(blocked.status, "opted_out");
  assert.equal(fetchCalled, false);
  assert.match(policyWarning, /WhatsApp send rejected by policy/);
  console.warn = originalWarn;
});

test("duplicate Meta event IDs are treated as already processed", async () => {
  models.WebhookEvent.create = async () => {
    const error = new Error("duplicate event");
    error.code = 11000;
    throw error;
  };
  assert.deepEqual(await recordWebhookEvent("wamid.duplicate", "text"), { inserted: false, duplicate: true, accepted: false });
  assert.deepEqual(await recordWebhookEvent("", "text"), { inserted: false, duplicate: false, accepted: false });
});

test("a successful Meta acceptance stays successful when audit persistence fails", async () => {
  consent = { optedIn: true, nonEssentialOptOut: false, failureCount: 0, lastMessageAt: new Date() };
  global.fetch = async () =>
    new Response(JSON.stringify({ messages: [{ id: "wamid.audit-safe" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  models.AuditLog.create = async () => {
    throw new Error("audit database unavailable");
  };
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await sendWhatsAppText({
      to: "+923001234567",
      text: "Appointment accepted",
      messageType: "chatbot_reply",
      patientInitiated: true
    });
    assert.equal(result.sent, true);
    assert.equal(result.status, "sent");
    assert.equal(result.providerMessageId, "wamid.audit-safe");
  } finally {
    console.error = originalError;
    models.AuditLog.create = async (data) => data;
  }
});

test("delivery callbacks advance monotonically and duplicate callbacks have no side effects", async () => {
  let currentStatus = "sent";
  let consentUpdates = 0;
  models.MessageLog.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      if (!filter.status.$in.includes(currentStatus)) return null;
      currentStatus = update.$set.status;
      return { providerMessageId: "wamid.delivery", normalizedPhone: "+923001234567", status: currentStatus };
    }
  });
  models.WhatsAppConsent.findOneAndUpdate = async () => {
    consentUpdates += 1;
    return consent;
  };

  assert.equal((await updateMessageStatus("wamid.delivery", "delivered")).status, "delivered");
  assert.equal(await updateMessageStatus("wamid.delivery", "delivered"), null);
  assert.equal((await updateMessageStatus("wamid.delivery", "read")).status, "read");
  assert.equal(await updateMessageStatus("wamid.delivery", "sent"), null);
  assert.equal(await updateMessageStatus("wamid.delivery", "failed"), null);
  assert.equal(currentStatus, "read");
  assert.equal(consentUpdates, 2);
});

test("webhook retry claims enforce due/stale state and increment attempts atomically", async () => {
  let capturedFilter;
  let capturedUpdate;
  const claimed = { providerEventId: "wamid.retry", status: "retrying", attempts: 2 };
  models.WebhookEvent.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      capturedFilter = filter;
      capturedUpdate = update;
      return claimed;
    }
  });
  const now = new Date("2026-07-20T12:00:00.000Z");
  assert.equal(await claimWebhookEventForRetry("wamid.retry", { now }), claimed);
  assert.equal(capturedFilter.providerEventId, "wamid.retry");
  assert.deepEqual(capturedFilter.attempts, { $lt: 5 });
  assert.ok(capturedFilter.$or.some((branch) => branch.status === "processing"));
  assert.ok(capturedFilter.$or.some((branch) => branch.status?.$in?.includes("failed")));
  assert.deepEqual(capturedUpdate.$inc, { attempts: 1 });
  assert.equal(capturedUpdate.$set.lockedAt, now);
});

test("bounded webhook retry processing claims each candidate and completes through an injected handler", async () => {
  const candidate = { providerEventId: "wamid.worker", status: "failed", attempts: 1 };
  models.WebhookEvent.find = () => ({
    sort: () => ({
      limit: () => ({ lean: async () => [candidate] })
    })
  });
  models.WebhookEvent.findOneAndUpdate = (filter, update) => ({
    lean: async () => {
      if (update.$inc?.attempts) return { ...candidate, status: "retrying", attempts: 2 };
      if (update.$set?.status === "completed") return { ...candidate, status: "completed" };
      return null;
    }
  });
  const handled = [];
  const result = await processDueWebhookEvents({
    now: new Date("2026-07-20T12:00:00.000Z"),
    limit: 500,
    handler: async (event) => handled.push(event.providerEventId)
  });
  assert.deepEqual(handled, ["wamid.worker"]);
  assert.deepEqual(result, [{ providerEventId: "wamid.worker", status: "completed" }]);
  await assert.rejects(() => processDueWebhookEvents(), /handler is required/i);
});

test("appointment confirmations reserve an idempotency key before sending", async () => {
  consent = { optedIn: true, nonEssentialOptOut: false, failureCount: 0, lastMessageAt: new Date() };
  let reservation;
  let fetchCalls = 0;
  models.MessageLog.create = async (data) => {
    if (data.idempotencyKey) {
      if (reservation) {
        const error = new Error("duplicate reservation");
        error.code = 11000;
        throw error;
      }
      reservation = { ...data, updatedAt: new Date() };
      return reservation;
    }
    return data;
  };
  models.MessageLog.findOne = (filter) => ({ lean: async () => (filter.idempotencyKey ? reservation : null) });
  models.MessageLog.updateOne = async (filter, update) => {
    if (filter.idempotencyKey === reservation.idempotencyKey) Object.assign(reservation, update.$set);
    return { modifiedCount: 1 };
  };
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ messages: [{ id: "wamid.confirm-once" }] }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const appointment = {
    appointmentId: "KHR-20260720-ONCE01",
    normalizedPhone: "+923001234567",
    doctorName: "Dr. Khurrum Mansoor",
    locationNameEn: "Nighat Medical Complex",
    tokenNumber: 1,
    date: "2026-07-20",
    time: "09:00",
    status: "Booked"
  };
  const first = await sendAppointmentWhatsApp({ appointment, text: "Confirmed", messageType: "appointment_confirmation" });
  const duplicate = await sendAppointmentWhatsApp({ appointment, text: "Confirmed", messageType: "appointment_confirmation" });
  assert.equal(first.sent, true);
  assert.equal(duplicate.sent, true);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(fetchCalls, 1);
  assert.match(reservation.idempotencyKey, /^wa:[a-f0-9]{64}$/);
  assert.equal(reservation.status, "sent");
});
