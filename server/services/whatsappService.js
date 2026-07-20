import crypto from "node:crypto";
import { DOCTOR } from "../config/clinic.js";
import { whatsappConfigured } from "../config/validation.js";
import { models } from "../models/index.js";
import { compactText, makePublicId, maskPhone, normalizePhone } from "../utils/time.js";
import { addAuditLog } from "./auditService.js";
import { buildInteractiveContent, buildTextFallback } from "./interactiveMessageService.js";

export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

const MAX_NON_OPERATIONAL_PER_PATIENT_HOUR = 6;
const MAX_NON_OPERATIONAL_GLOBAL_PER_MINUTE = 80;
const MAX_FAILURES_BEFORE_HOLD = 3;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const OPERATIONAL_MESSAGE_TYPES = new Set([
  "appointment_confirmation",
  "appointment_reminder",
  "reschedule_confirmation",
  "cancellation_confirmation",
  "opt_out_confirmation"
]);

const OPT_OUT_MESSAGES = new Set([
  "stop",
  "unsubscribe",
  "unsub",
  "opt out",
  "cancel messages",
  "stop messages",
  "no messages",
  "do not message me",
  "dont message me",
  "band",
  "band karo",
  "band karen",
  "ruk jao",
  "mat bhejo",
  "بند",
  "پیغامات بند",
  "روک دیں",
  "روک دو",
  "ان سبسکرائب"
]);

const OPT_IN_MESSAGES = new Set([
  "start",
  "subscribe",
  "resume",
  "yes",
  "continue",
  "ok",
  "restart",
  "unstop",
  "شروع",
  "جاری رکھیں"
]);

function cleanCommand(text = "") {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ");
}

function retryLimit() {
  return Math.max(0, Math.min(Number(process.env.WHATSAPP_RETRY_ATTEMPTS || 2), 5));
}

function publicWhatsAppStatus() {
  return {
    configured: whatsappConfigured(),
    apiVersion: process.env.WHATSAPP_API_VERSION || "missing",
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ? "configured" : "missing",
    businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID ? "configured" : "missing",
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN ? "configured" : "missing",
    templates: {
      appointmentConfirmation: Boolean(process.env.WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION),
      appointmentReminder: Boolean(process.env.WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER),
      rescheduleConfirmation: Boolean(process.env.WHATSAPP_TEMPLATE_RESCHEDULE_CONFIRMATION),
      cancellationConfirmation: Boolean(process.env.WHATSAPP_TEMPLATE_CANCELLATION_CONFIRMATION)
    },
    safety: {
      officialCloudApiOnly: true,
      serviceWindowHours: 24,
      freeFormOutsideServiceWindow: false,
      bulkBroadcastsEnabled: false,
      retryLimit: retryLimit(),
      throttlingEnabled: true
    }
  };
}

export function getWhatsAppStatus() {
  return publicWhatsAppStatus();
}

export function isOptOutMessage(text = "") {
  const command = cleanCommand(text);
  return OPT_OUT_MESSAGES.has(command);
}

export function isOptInMessage(text = "") {
  const command = cleanCommand(text);
  return OPT_IN_MESSAGES.has(command);
}

export function isInsideServiceWindow(lastMessageAt, now = new Date()) {
  if (!lastMessageAt) return false;
  const last = new Date(lastMessageAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(last) || !Number.isFinite(current)) return false;
  return current >= last && current - last <= SERVICE_WINDOW_MS;
}

export function isRetryableWhatsAppStatus(status) {
  return RETRYABLE_STATUS_CODES.has(Number(status));
}

export function templateNameForMessageType(messageType = "") {
  const map = {
    appointment_confirmation: process.env.WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION,
    appointment_reminder: process.env.WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER,
    reschedule_confirmation: process.env.WHATSAPP_TEMPLATE_RESCHEDULE_CONFIRMATION,
    cancellation_confirmation: process.env.WHATSAPP_TEMPLATE_CANCELLATION_CONFIRMATION
  };
  return map[messageType] || "";
}

function templateLanguage(language = "en") {
  return language === "ur" ? "ur" : "en";
}

function textParameter(value) {
  return { type: "text", text: String(value || "-").slice(0, 1024) };
}

export function appointmentTemplateComponents(appointment, messageType = "appointment_confirmation", language = "en") {
  if (!appointment) return [];
  const contactNumber = language === "ur" && DOCTOR.contact ? `\u2066${DOCTOR.contact}\u2069` : DOCTOR.contact;
  const common = [
    appointment.doctorName || DOCTOR.nameEn,
    appointment.date,
    appointment.time,
    appointment.locationNameEn || appointment.locationNameUr,
    appointment.tokenNumber,
    appointment.appointmentId,
    contactNumber
  ];
  const cancellation = [appointment.appointmentId, appointment.date, appointment.time, contactNumber];
  const values = messageType === "cancellation_confirmation" ? cancellation : common;
  return [{ type: "body", parameters: values.map(textParameter) }];
}

export function messageBodyForLog() {
  // Message text can contain a patient's name, reason for visit, or other health data.
  // Operational logs only need delivery metadata; the conversation itself is not retained here.
  return "";
}

export function sanitizeMessageLog(log = {}) {
  const item = typeof log?.toObject === "function" ? log.toObject() : { ...log };
  return {
    ...item,
    phone: item.phone ? maskPhone(item.phone) : "",
    normalizedPhone: item.normalizedPhone ? maskPhone(item.normalizedPhone) : "",
    messageBody: "",
    rawPayload: undefined
  };
}

export async function logMessage({
  phone,
  appointmentId = "",
  messageType,
  messageBody = "",
  direction,
  status,
  providerMessageId = "",
  error = "",
  retryCount = 0,
  rawPayload: _rawPayload = null
}) {
  const normalizedPhone = phone ? normalizePhone(phone) : "";
  try {
    return await models.MessageLog.create({
      messageLogId: makePublicId("MSG"),
      phone,
      normalizedPhone,
      appointmentId,
      messageType,
      messageBody: messageBodyForLog(messageType, messageBody),
      direction,
      status,
      providerMessageId,
      error: compactText(error, 500),
      retryCount,
      rawPayload: null
    });
  } catch (err) {
    if (err.code === 11000 && providerMessageId) {
      return models.MessageLog.findOne({ providerMessageId }).lean();
    }
    throw err;
  }
}

export function inboundConsentUpdate({ phone, normalizedPhone, language = "en", source = "WhatsApp Cloud API", optIn = false, now = new Date() }) {
  return {
    $set: {
      phone,
      normalizedPhone,
      optedIn: true,
      source,
      language,
      lastMessageAt: now,
      ...(optIn ? { nonEssentialOptOut: false, lastOptInAt: now } : {})
    },
    $setOnInsert: {
      consentId: makePublicId("CNS"),
      failureCount: 0,
      ...(optIn ? {} : { lastOptInAt: now })
    }
  };
}

export async function upsertInboundConsent({ phone, language = "en", text = "", source = "WhatsApp Cloud API" }) {
  const normalizedPhone = normalizePhone(phone);
  const now = new Date();
  const optIn = isOptInMessage(text);
  return models.WhatsAppConsent.findOneAndUpdate(
    { normalizedPhone },
    inboundConsentUpdate({ phone, normalizedPhone, language, source, optIn, now }),
    { returnDocument: "after", upsert: true }
  ).lean();
}

export async function markOptOut({ phone, language = "en", source = "WhatsApp Cloud API" }) {
  const normalizedPhone = normalizePhone(phone);
  const now = new Date();
  return models.WhatsAppConsent.findOneAndUpdate(
    { normalizedPhone },
    {
      $set: {
        phone,
        normalizedPhone,
        optedIn: true,
        nonEssentialOptOut: true,
        source,
        language,
        lastOptOutAt: now,
        lastMessageAt: now
      },
      $setOnInsert: {
        consentId: makePublicId("CNS"),
        failureCount: 0
      }
    },
    { returnDocument: "after", upsert: true }
  ).lean();
}

async function recordDeliveryFailure(phone) {
  if (!phone) return;
  const normalizedPhone = normalizePhone(phone);
  await models.WhatsAppConsent.findOneAndUpdate(
    { normalizedPhone },
    {
      $inc: { failureCount: 1 },
      $set: { lastFailureAt: new Date() }
    }
  );
}

async function recordDeliverySuccess(phone) {
  if (!phone) return;
  const normalizedPhone = normalizePhone(phone);
  await models.WhatsAppConsent.findOneAndUpdate(
    { normalizedPhone },
    {
      $set: { failureCount: 0 },
      $unset: { lastFailureAt: "" }
    }
  );
}

async function recentOutgoingCount(query, since) {
  return models.MessageLog.countDocuments({
    ...query,
    direction: "Outgoing",
    createdAt: { $gte: since },
    status: { $in: ["sent", "failed"] }
  });
}

async function sendPolicy({ normalizedPhone, messageType, operational, ignoreOptOut, patientInitiated, templateName }) {
  const consent = await models.WhatsAppConsent.findOne({ normalizedPhone }).lean();
  if (!ignoreOptOut && !consent?.optedIn) {
    return { allowed: false, status: "no_consent", message: "Patient consent is required before sending WhatsApp messages." };
  }
  const needsConsent = !operational && !patientInitiated && !ignoreOptOut;
  if (needsConsent && consent?.nonEssentialOptOut) {
    return { allowed: false, status: "opted_out", message: "Patient has opted out of non-essential WhatsApp messages." };
  }
  if (!operational && !patientInitiated && Number(consent?.failureCount || 0) >= MAX_FAILURES_BEFORE_HOLD) {
    return { allowed: false, status: "delivery_hold", message: "Sending is paused after repeated WhatsApp delivery failures." };
  }

  if (!operational && !patientInitiated) {
    const now = Date.now();
    const patientCount = await recentOutgoingCount({ normalizedPhone }, new Date(now - 60 * 60 * 1000));
    if (patientCount >= MAX_NON_OPERATIONAL_PER_PATIENT_HOUR) {
      return { allowed: false, status: "throttled", message: "WhatsApp send rate is limited for this patient." };
    }

    const globalCount = await recentOutgoingCount({}, new Date(now - 60 * 1000));
    if (globalCount >= MAX_NON_OPERATIONAL_GLOBAL_PER_MINUTE) {
      return { allowed: false, status: "throttled", message: "WhatsApp send rate is limited right now." };
    }
  }

  if (isInsideServiceWindow(consent?.lastMessageAt)) {
    return { allowed: true, useTemplate: false, consent };
  }

  const approvedTemplateName = templateName || templateNameForMessageType(messageType);
  if (!approvedTemplateName) {
    return {
      allowed: false,
      status: "outside_service_window",
      message: "Approved WhatsApp template is required outside the 24-hour service window."
    };
  }
  return { allowed: true, useTemplate: true, templateName: approvedTemplateName, consent };
}

export function buildWhatsAppPayload({ normalizedPhone, text, options = [], useTemplate, templateName, templateComponents, language }) {
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalizedPhone.replace(/^\+/, "")
  };

  if (useTemplate) {
    return {
      ...base,
      type: "template",
      template: {
        name: templateName,
        language: { code: templateLanguage(language) },
        ...(templateComponents?.length ? { components: templateComponents } : {})
      }
    };
  }

  const interactive = buildInteractiveContent({ text, options, language });
  if (interactive) {
    return { ...base, type: "interactive", interactive };
  }

  return {
    ...base,
    type: "text",
    text: { preview_url: false, body: text }
  };
}

async function postToWhatsApp(payload) {
  const apiVersion = process.env.WHATSAPP_API_VERSION;
  const url = `https://graph.facebook.com/${apiVersion}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(Number(process.env.WHATSAPP_HTTP_TIMEOUT_MS || 15000))
    });
  } catch (err) {
    console.error("Meta Graph API request failed", { error: err.message });
    throw err;
  }

  const body = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    statusCode: response.status,
    body,
    providerMessageId: body?.messages?.[0]?.id || "",
    error: response.ok ? "" : body?.error?.message || `WhatsApp API returned ${response.status}`
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithRetry(payload) {
  const maxRetries = retryLimit();
  let lastResult = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      lastResult = await postToWhatsApp(payload);
    } catch (error) {
      lastResult = { ok: false, statusCode: 0, providerMessageId: "", error: error.message, body: null };
    }

    const retryable = !lastResult.ok && (lastResult.statusCode === 0 || isRetryableWhatsAppStatus(lastResult.statusCode));
    if (lastResult.ok || !retryable || attempt === maxRetries) {
      return { ...lastResult, retryCount: attempt };
    }
    await sleep(Math.min(250 * 2 ** attempt, 1000));
  }
  return { ...lastResult, retryCount: maxRetries };
}

export async function sendWhatsAppText({
  to,
  text,
  messageType = "chatbot_reply",
  appointmentId = "",
  actor = null,
  language = "en",
  templateName = "",
  templateComponents = [],
  options = [],
  operational = OPERATIONAL_MESSAGE_TYPES.has(messageType),
  ignoreOptOut = false,
  patientInitiated = false
}) {
  const normalized = normalizePhone(to);
  if (!whatsappConfigured()) {
    console.warn("WhatsApp send skipped because the service is not configured", { messageType });
    const log = await logMessage({
      phone: to,
      appointmentId,
      messageType,
      messageBody: text,
      direction: "Outgoing",
      status: "not_configured",
      error: "WhatsApp is not configured yet"
    });
    return {
      sent: false,
      status: "not_configured",
      message: "WhatsApp is not configured yet",
      logId: log.messageLogId
    };
  }

  const policy = await sendPolicy({
    normalizedPhone: normalized,
    messageType,
    operational,
    ignoreOptOut,
    patientInitiated,
    templateName
  });
  if (!policy.allowed) {
    console.warn("WhatsApp send rejected by policy", { messageType, status: policy.status });
    const log = await logMessage({
      phone: to,
      appointmentId,
      messageType,
      messageBody: text,
      direction: "Outgoing",
      status: policy.status,
      error: policy.message
    });
    return { sent: false, status: policy.status, message: policy.message, logId: log?.messageLogId };
  }

  const payload = buildWhatsAppPayload({
    normalizedPhone: normalized,
    text,
    useTemplate: policy.useTemplate,
    templateName: policy.templateName,
    templateComponents,
    options,
    language
  });

  try {
    let result = await sendWithRetry(payload);
    let usedInteractiveFallback = false;
    if (!result.ok && payload.type === "interactive") {
      const fallbackPayload = buildWhatsAppPayload({
        normalizedPhone: normalized,
        text: buildTextFallback(text, options, language),
        options: [],
        useTemplate: false,
        language
      });
      result = await sendWithRetry(fallbackPayload);
      usedInteractiveFallback = result.ok;
    }
    const status = result.ok ? "sent" : "failed";

    await logMessage({
      phone: to,
      appointmentId,
      messageType,
      messageBody: text,
      direction: "Outgoing",
      status,
      providerMessageId: result.providerMessageId,
      error: result.error,
      retryCount: result.retryCount,
      rawPayload: null
    });

    if (!result.ok) {
      await recordDeliveryFailure(to);
      await addAuditLog({ actor, action: "WhatsApp message failed", module: "WhatsApp", targetType: "Message", targetId: result.providerMessageId, metadata: { error: result.error } });
      return { sent: false, status, providerMessageId: result.providerMessageId, error: result.error, retryCount: result.retryCount };
    }

    await recordDeliverySuccess(to);
    await addAuditLog({ actor, action: "WhatsApp message sent", module: "WhatsApp", targetType: "Message", targetId: result.providerMessageId });
    return {
      sent: true,
      status,
      providerMessageId: result.providerMessageId,
      retryCount: result.retryCount,
      usedTemplate: Boolean(policy.useTemplate),
      usedInteractiveFallback,
      templateName: policy.useTemplate ? policy.templateName : ""
    };
  } catch (error) {
    console.error("WhatsApp send failed", { messageType, error: error.message });
    await logMessage({
      phone: to,
      appointmentId,
      messageType,
      messageBody: text,
      direction: "Outgoing",
      status: "failed",
      error: error.message
    });
    await recordDeliveryFailure(to);
    await addAuditLog({ actor, action: "WhatsApp message failed", module: "WhatsApp", metadata: { error: error.message } });
    return { sent: false, status: "failed", error: error.message };
  }
}

export async function sendAppointmentWhatsApp({ appointment, text, messageType, actor = null, language = "en" }) {
  return sendWhatsAppText({
    to: appointment.normalizedPhone || appointment.phone,
    text,
    messageType,
    appointmentId: appointment.appointmentId,
    actor,
    language,
    operational: true,
    templateName: templateNameForMessageType(messageType),
    templateComponents: appointmentTemplateComponents(appointment, messageType, language)
  });
}

export function verifyMetaSignature(req) {
  const secret = process.env.META_APP_SECRET;
  if (!secret) return false;
  const signature = req.headers["x-hub-signature-256"];
  if (!signature || !req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export async function recordWebhookEvent(providerEventId, eventType) {
  if (!providerEventId) return { inserted: false, duplicate: false };
  try {
    await models.WebhookEvent.create({
      eventId: makePublicId("EVT"),
      provider: "WhatsApp",
      providerEventId,
      eventType
    });
    return { inserted: true, duplicate: false };
  } catch (error) {
    if (error.code === 11000) return { inserted: false, duplicate: true };
    throw error;
  }
}

export async function listMessageLogs(limit = 300) {
  const logs = await models.MessageLog.find({}).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 300, 1000)).lean();
  return logs.map(sanitizeMessageLog);
}

export async function updateMessageStatus(providerMessageId, status) {
  if (!providerMessageId) return null;
  const log = await models.MessageLog.findOneAndUpdate(
    { providerMessageId },
    { status, rawPayload: null },
    { returnDocument: "after" }
  ).lean();
  if (log?.normalizedPhone && status === "failed") await recordDeliveryFailure(log.normalizedPhone);
  if (log?.normalizedPhone && ["sent", "delivered", "read"].includes(status)) await recordDeliverySuccess(log.normalizedPhone);
  return log;
}

export async function getWhatsAppQualitySnapshot() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [totalOutgoing, failedOutgoing, heldOutgoing] = await Promise.all([
    models.MessageLog.countDocuments({ direction: "Outgoing", createdAt: { $gte: since } }),
    models.MessageLog.countDocuments({ direction: "Outgoing", status: "failed", createdAt: { $gte: since } }),
    models.MessageLog.countDocuments({ direction: "Outgoing", status: { $in: ["delivery_hold", "throttled", "outside_service_window", "opted_out", "no_consent"] }, createdAt: { $gte: since } })
  ]);
  const failureRate = totalOutgoing ? Number((failedOutgoing / totalOutgoing).toFixed(3)) : 0;
  return {
    window: "24h",
    totalOutgoing,
    failedOutgoing,
    heldOutgoing,
    failureRate,
    warning:
      totalOutgoing >= 5 && failureRate >= 0.2
        ? "WhatsApp failure rate is elevated. Check Meta WhatsApp Manager quality rating and pause non-essential sends."
        : ""
  };
}
