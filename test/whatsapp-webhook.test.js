import test from "node:test";
import assert from "node:assert/strict";
import { models } from "../server/models/index.js";
import { processWebhookPayload } from "../server/routes/whatsapp.js";

const originalFetch = global.fetch;
const originalEnvironment = { ...process.env };

test("a failed WhatsApp reply marks the event retryable instead of acknowledging it as processed", async (t) => {
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

  const originals = {
    WebhookEvent: {
      create: models.WebhookEvent.create,
      findOne: models.WebhookEvent.findOne,
      findOneAndUpdate: models.WebhookEvent.findOneAndUpdate
    },
    MessageLog: { create: models.MessageLog.create, findOne: models.MessageLog.findOne },
    WhatsAppConsent: {
      findOne: models.WhatsAppConsent.findOne,
      findOneAndUpdate: models.WhatsAppConsent.findOneAndUpdate
    },
    ChatSession: { findOne: models.ChatSession.findOne, create: models.ChatSession.create },
    AuditLog: { create: models.AuditLog.create }
  };

  t.after(() => {
    global.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
    for (const [modelName, methods] of Object.entries(originals)) Object.assign(models[modelName], methods);
  });

  let webhookEvent;
  models.WebhookEvent.create = async (data) => {
    webhookEvent = { _id: "event-1", ...data };
    return webhookEvent;
  };
  models.WebhookEvent.findOne = () => ({ lean: async () => webhookEvent });
  models.WebhookEvent.findOneAndUpdate = (_filter, update) => ({
    lean: async () => {
      webhookEvent = { ...webhookEvent, ...update.$set };
      return webhookEvent;
    }
  });

  models.MessageLog.create = async (data) => data;
  models.MessageLog.findOne = () => ({ lean: async () => null });
  const consent = { optedIn: true, nonEssentialOptOut: false, failureCount: 0, lastMessageAt: new Date() };
  models.WhatsAppConsent.findOne = () => ({ lean: async () => consent });
  models.WhatsAppConsent.findOneAndUpdate = () => ({ lean: async () => consent });
  models.AuditLog.create = async (data) => data;

  let session;
  models.ChatSession.findOne = async () => null;
  models.ChatSession.create = async (data) => {
    session = {
      ...data,
      processedInteractions: [],
      markModified() {},
      async save() {}
    };
    return session;
  };

  global.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "Temporary provider failure" } }), {
      status: 500,
      headers: { "content-type": "application/json" }
    });

  const payload = {
    entry: [{
      changes: [{
        value: {
          messages: [{ id: "wamid.retryable", from: "923001234567", type: "text", text: { body: "hello" } }]
        }
      }]
    }]
  };

  await assert.rejects(() => processWebhookPayload(payload), /Temporary provider failure/);
  assert.equal(webhookEvent.status, "failed");
  assert.equal(webhookEvent.attempts, 1);
  assert.ok(webhookEvent.nextRetryAt instanceof Date);
  assert.equal(session.processedInteractions[0].interactionId, "wamid.retryable");
});
