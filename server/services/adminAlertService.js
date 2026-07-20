import { DOCTOR } from "../config/clinic.js";
import { models } from "../models/index.js";
import { compactText, displayDate, displayTime, makePublicId } from "../utils/time.js";
import { sendTemplateMessage } from "./whatsappService.js";

export const ADMIN_ALERT_TYPE = "ADMIN_NEW_APPOINTMENT_ALERT";
export const ADMIN_ALERT_TEMPLATE = "apointment_book_system_";
export const ADMIN_ALERT_MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const LOCK_MS = 2 * 60_000;
const TERMINAL_SUCCESS = ["sent", "delivered", "read"];

export function adminAlertConfig(env = process.env) {
  return {
    enabled: String(env.WHATSAPP_ADMIN_ALERT_ENABLED || "false").trim().toLowerCase() === "true",
    recipientPhone: String(env.WHATSAPP_ADMIN_ALERT_NUMBER || "").trim(),
    templateName: String(env.WHATSAPP_ADMIN_ALERT_TEMPLATE || ADMIN_ALERT_TEMPLATE).trim(),
    templateLanguage: String(env.WHATSAPP_ADMIN_ALERT_LANGUAGE || "en").trim()
  };
}

export function validateAdminAlertConfig(config = adminAlertConfig()) {
  if (!config.enabled) return { ok: true, enabled: false };
  if (!/^\d{10,15}$/.test(config.recipientPhone)) return { ok: false, enabled: true, code: "INVALID_RECIPIENT" };
  if (config.templateName !== ADMIN_ALERT_TEMPLATE) return { ok: false, enabled: true, code: "INVALID_TEMPLATE" };
  if (!/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(config.templateLanguage)) return { ok: false, enabled: true, code: "INVALID_LANGUAGE" };
  return { ok: true, enabled: true };
}

export function buildAdminAlertParameters(appointment) {
  const values = [
    appointment?.patientName,
    appointment?.doctorName || DOCTOR.nameEn,
    appointment?.date ? displayDate(appointment.date, "en") : "",
    appointment?.time ? displayTime(appointment.time, "en") : "",
    appointment?.tokenNumber === undefined || appointment?.tokenNumber === null ? "" : String(appointment.tokenNumber),
    appointment?.appointmentId
  ].map((value) => compactText(value, 1024));
  if (values.some((value) => !value || /^(?:undefined|null|\[object Object\])$/i.test(value))) return null;
  return values;
}

export async function queueAdminAppointmentAlert(appointment, { session = null } = {}) {
  const config = adminAlertConfig();
  const validation = validateAdminAlertConfig(config);
  if (!validation.enabled) return { queued: false, status: "disabled" };
  if (!validation.ok) return { queued: false, status: "invalid_configuration", code: validation.code };
  if (!appointment?.appointmentId || !["Booked", "Rescheduled"].includes(appointment.status)) {
    return { queued: false, status: "invalid_appointment" };
  }
  const templateParameters = buildAdminAlertParameters(appointment);
  if (!templateParameters) return { queued: false, status: "invalid_parameters" };

  const filter = {
    appointmentId: appointment.appointmentId,
    notificationType: ADMIN_ALERT_TYPE,
    recipientPhone: config.recipientPhone
  };
  await models.NotificationOutbox.updateOne(
    filter,
    {
      $setOnInsert: {
        notificationId: makePublicId("NTF"),
        ...filter,
        templateName: config.templateName,
        templateLanguage: config.templateLanguage,
        templateParameters,
        status: "queued",
        attemptCount: 0,
        nextRetryAt: new Date(),
        failureCode: "",
        failureMessageSafe: ""
      }
    },
    { upsert: true, ...(session ? { session } : {}) }
  );
  return { queued: true, status: "queued" };
}

function claimFilter(now, appointmentId = "") {
  return {
    ...(appointmentId ? { appointmentId } : {}),
    notificationType: ADMIN_ALERT_TYPE,
    $or: [
      { status: "queued", nextRetryAt: { $lte: now } },
      { status: "failed", nextRetryAt: { $lte: now } },
      { status: "sending", lockExpiresAt: { $lte: now } }
    ]
  };
}

export async function claimAdminAlert({ appointmentId = "", now = new Date() } = {}) {
  return models.NotificationOutbox.findOneAndUpdate(
    claimFilter(now, appointmentId),
    {
      $set: {
        status: "sending",
        lockedAt: now,
        lockExpiresAt: new Date(now.getTime() + LOCK_MS),
        lastAttemptAt: now,
        failureCode: "",
        failureMessageSafe: ""
      },
      $inc: { attemptCount: 1 }
    },
    { returnDocument: "after", sort: { nextRetryAt: 1, createdAt: 1 } }
  ).lean();
}

async function finishFailedAlert(notification, result, now) {
  const attempts = Number(notification.attemptCount || 0);
  const retryDelay = result.temporary && attempts < ADMIN_ALERT_MAX_ATTEMPTS ? RETRY_DELAYS_MS[attempts - 1] : null;
  const status = result.temporary && attempts >= ADMIN_ALERT_MAX_ATTEMPTS ? "dead_letter" : "failed";
  return models.NotificationOutbox.findOneAndUpdate(
    { notificationId: notification.notificationId, status: "sending" },
    {
      $set: {
        status,
        failedAt: now,
        failureCode: compactText(result.failureCode || "SEND_FAILED", 80),
        failureMessageSafe: compactText(result.failureMessageSafe || "The alert could not be sent.", 200),
        nextRetryAt: retryDelay ? new Date(now.getTime() + retryDelay) : null
      },
      $unset: { lockedAt: "", lockExpiresAt: "" }
    },
    { returnDocument: "after" }
  ).lean();
}

export async function processOneAdminAlert({ appointmentId = "", now = new Date() } = {}) {
  const notification = await claimAdminAlert({ appointmentId, now });
  if (!notification) return null;
  const appointment = await models.Appointment.findOne({ appointmentId: notification.appointmentId }).lean();
  if (!appointment || !["Booked", "Rescheduled"].includes(appointment.status)) {
    return finishFailedAlert(notification, {
      temporary: false,
      failureCode: "APPOINTMENT_NOT_ACTIVE",
      failureMessageSafe: "The confirmed appointment is unavailable."
    }, now);
  }
  const parameters = buildAdminAlertParameters(appointment);
  if (!parameters || parameters.some((value, index) => value !== notification.templateParameters[index])) {
    return finishFailedAlert(notification, {
      temporary: false,
      failureCode: "PARAMETER_MISMATCH",
      failureMessageSafe: "The alert parameters no longer match the appointment."
    }, now);
  }

  const result = await sendTemplateMessage({
    to: notification.recipientPhone,
    templateName: notification.templateName,
    languageCode: notification.templateLanguage,
    parameters: notification.templateParameters
  });
  if (!result.sent || !result.providerMessageId) return finishFailedAlert(notification, result, now);
  return models.NotificationOutbox.findOneAndUpdate(
    { notificationId: notification.notificationId, status: "sending" },
    {
      $set: {
        status: "sent",
        providerMessageId: result.providerMessageId,
        sentAt: now,
        nextRetryAt: null,
        failureCode: "",
        failureMessageSafe: ""
      },
      $unset: { lockedAt: "", lockExpiresAt: "", failedAt: "" }
    },
    { returnDocument: "after" }
  ).lean();
}

export async function processDueAdminAlerts({ limit = 20, now = new Date() } = {}) {
  const results = [];
  for (let index = 0; index < Math.max(1, Math.min(Number(limit) || 20, 100)); index += 1) {
    const result = await processOneAdminAlert({ now });
    if (!result) break;
    results.push(result);
  }
  return results;
}

export function scheduleAdminAlertProcessing(appointmentId) {
  setTimeout(() => {
    processOneAdminAlert({ appointmentId }).catch((error) => {
      console.error("Admin alert processing failed", { errorCode: compactText(error?.code || error?.name || "PROCESSING_ERROR", 80) });
    });
  }, 0).unref?.();
}

export async function retryAdminAppointmentAlert(appointmentId, { schedule = true } = {}) {
  const notification = await models.NotificationOutbox.findOneAndUpdate(
    {
      appointmentId,
      notificationType: ADMIN_ALERT_TYPE,
      status: { $in: ["failed", "dead_letter"] }
    },
    {
      $set: {
        status: "queued",
        attemptCount: 0,
        nextRetryAt: new Date(),
        providerMessageId: "",
        failureCode: "",
        failureMessageSafe: ""
      },
      $unset: { lockedAt: "", lockExpiresAt: "", failedAt: "" }
    },
    { returnDocument: "after" }
  ).lean();
  if (notification) {
    if (schedule) scheduleAdminAlertProcessing(appointmentId);
    return publicAdminAlert(notification);
  }
  const existing = await models.NotificationOutbox.findOne({ appointmentId, notificationType: ADMIN_ALERT_TYPE }).lean();
  if (!existing) {
    const error = new Error("Personal appointment alert was not found.");
    error.status = 404;
    throw error;
  }
  if (TERMINAL_SUCCESS.includes(existing.status) || ["queued", "sending"].includes(existing.status)) return publicAdminAlert(existing);
  const error = new Error("Personal appointment alert cannot be retried in its current state.");
  error.status = 409;
  throw error;
}

const DELIVERY_RANK = { sent: 1, delivered: 2, read: 3 };

export async function updateAdminAlertDeliveryStatus(providerMessageId, status, failureCode = "") {
  if (!providerMessageId || !["sent", "delivered", "read", "failed"].includes(status)) return null;
  const current = await models.NotificationOutbox.findOne({ providerMessageId }).lean();
  if (!current) return null;
  if (current.status === "failed") return publicAdminAlert(current);
  if (status !== "failed" && (DELIVERY_RANK[current.status] || 0) >= DELIVERY_RANK[status]) return publicAdminAlert(current);
  if (status === "failed" && ["delivered", "read"].includes(current.status)) return publicAdminAlert(current);
  const now = new Date();
  const set = { status };
  if (status === "sent") set.sentAt = current.sentAt || now;
  if (status === "delivered") set.deliveredAt = now;
  if (status === "read") set.readAt = now;
  if (status === "failed") {
    set.failedAt = now;
    set.nextRetryAt = null;
    set.failureCode = compactText(failureCode || "META_DELIVERY_FAILED", 80);
    set.failureMessageSafe = "Meta reported that the personal alert failed.";
  }
  const updated = await models.NotificationOutbox.findOneAndUpdate(
    { notificationId: current.notificationId, status: current.status },
    { $set: set },
    { returnDocument: "after" }
  ).lean();
  return publicAdminAlert(updated || current);
}

export function publicAdminAlert(notification) {
  if (!notification) return null;
  return {
    status: notification.status,
    attemptCount: Number(notification.attemptCount || 0),
    sentAt: notification.sentAt || null,
    deliveredAt: notification.deliveredAt || null,
    readAt: notification.readAt || null,
    failedAt: notification.failedAt || null,
    failureCode: notification.failureCode || ""
  };
}

export async function adminAlertsForAppointments(appointmentIds = []) {
  const ids = [...new Set(appointmentIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const notifications = await models.NotificationOutbox.find({
    appointmentId: { $in: ids },
    notificationType: ADMIN_ALERT_TYPE
  }).lean();
  return new Map(notifications.map((notification) => [notification.appointmentId, publicAdminAlert(notification)]));
}

let workerTimer = null;
let workerRunning = false;

export function startAdminAlertWorker({ intervalMs = 15_000 } = {}) {
  if (workerTimer) return workerTimer;
  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      await processDueAdminAlerts();
    } catch (error) {
      console.error("Admin alert worker failed", { errorCode: compactText(error?.code || error?.name || "WORKER_ERROR", 80) });
    } finally {
      workerRunning = false;
    }
  };
  workerTimer = setInterval(tick, Math.max(1_000, Number(intervalMs) || 15_000));
  workerTimer.unref?.();
  setTimeout(tick, 0).unref?.();
  return workerTimer;
}

export function stopAdminAlertWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  workerRunning = false;
}
