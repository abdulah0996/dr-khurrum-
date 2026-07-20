import test from "node:test";
import assert from "node:assert/strict";
import { models } from "../server/models/index.js";
import { appointmentTemplateComponents, recordWebhookEvent, sendWhatsAppText } from "../server/services/whatsappService.js";

const originalFetch = global.fetch;
const originalWarn = console.warn;
const originalEnvironment = { ...process.env };
const originals = {
  MessageLog: {
    create: models.MessageLog.create,
    findOne: models.MessageLog.findOne
  },
  WhatsAppConsent: {
    findOne: models.WhatsAppConsent.findOne,
    findOneAndUpdate: models.WhatsAppConsent.findOneAndUpdate
  },
  AuditLog: { create: models.AuditLog.create },
  WebhookEvent: { create: models.WebhookEvent.create }
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
  assert.deepEqual(await recordWebhookEvent("wamid.duplicate", "text"), { inserted: false, duplicate: true });
  assert.deepEqual(await recordWebhookEvent("", "text"), { inserted: false, duplicate: false });
});
