import { models } from "../models/index.js";

const RETENTION_POLICIES = [
  { key: "RETENTION_WEBHOOK_EVENT_DAYS", model: "WebhookEvent", field: "updatedAt", index: "retention_webhook_updated" },
  { key: "RETENTION_MESSAGE_LOG_DAYS", model: "MessageLog", field: "createdAt", index: "retention_message_created" },
  { key: "RETENTION_CHAT_SESSION_DAYS", model: "ChatSession", field: "lastMessageAt", index: "retention_chat_session_last_message" },
  { key: "RETENTION_AUDIT_LOG_DAYS", model: "AuditLog", field: "createdAt", index: "retention_audit_created" }
];

export function configuredRetention(env = process.env) {
  return RETENTION_POLICIES.map((policy) => ({ ...policy, days: Number(env[policy.key] || 0) }))
    .filter((policy) => Number.isInteger(policy.days) && policy.days > 0);
}

export async function ensureConfiguredRetention(env = process.env) {
  const enabled = configuredRetention(env);
  for (const policy of enabled) {
    await models[policy.model].collection.createIndex(
      { [policy.field]: 1 },
      { name: policy.index, expireAfterSeconds: policy.days * 86400 }
    );
  }
  return enabled.map(({ key, model, field, days }) => ({ key, model, field, days }));
}
