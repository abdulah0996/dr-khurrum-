import nodemailer from "nodemailer";
import { DOCTOR, VERIFIED_CLINIC } from "../config/clinic.js";
import { models } from "../models/index.js";
import { compactText, displayDate, displayTime, makePublicId } from "../utils/time.js";

const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const MAX_ATTEMPTS = 5;
const LOCK_MS = 2 * 60_000;
let transportOverride;
let transport;
let workerTimer;
let workerRunning = false;

function booleanValue(value, fallback = false) {
  if (value === undefined || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320 ? email : "";
}

export function appointmentEmailConfig(env = process.env) {
  return {
    enabled: booleanValue(env.EMAIL_APPOINTMENT_ALERT_ENABLED),
    to: normalizeEmail(env.EMAIL_APPOINTMENT_ALERT_TO),
    fromName: compactText(env.EMAIL_FROM_NAME || VERIFIED_CLINIC.nameEn, 120),
    fromAddress: normalizeEmail(env.EMAIL_FROM_ADDRESS),
    provider: String(env.EMAIL_PROVIDER || "smtp").trim().toLowerCase(),
    adminPanelUrl: String(env.ADMIN_PANEL_URL || "https://admin.nighatmedicalcomplex.com").trim(),
    smtp: {
      host: String(env.SMTP_HOST || "").trim(),
      port: Number(env.SMTP_PORT || 587),
      secure: booleanValue(env.SMTP_SECURE),
      user: String(env.SMTP_USER || "").trim(),
      password: String(env.SMTP_PASSWORD || "").replace(/\s+/g, "")
    }
  };
}

export function validateAppointmentEmailConfig(config = appointmentEmailConfig()) {
  if (!config.enabled) return { ok: true, enabled: false };
  if (config.provider !== "smtp") return { ok: false, enabled: true, code: "EMAIL_PROVIDER_INVALID" };
  if (!config.to) return { ok: false, enabled: true, code: "EMAIL_RECIPIENT_INVALID" };
  if (!config.fromAddress || !config.smtp.host || !config.smtp.user || !config.smtp.password) {
    return { ok: false, enabled: true, code: "EMAIL_CONFIGURATION_MISSING" };
  }
  if (!Number.isInteger(config.smtp.port) || config.smtp.port < 1 || config.smtp.port > 65535) {
    return { ok: false, enabled: true, code: "EMAIL_SMTP_PORT_INVALID" };
  }
  return { ok: true, enabled: true };
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

export function buildAppointmentEmail(appointment, config = appointmentEmailConfig()) {
  const fields = [
    ["Patient", appointment?.patientName],
    ["Patient Phone", appointment?.normalizedPhone || appointment?.phone],
    ["Doctor", appointment?.doctorName || DOCTOR.nameEn],
    ["Clinic", appointment?.locationNameEn || VERIFIED_CLINIC.nameEn],
    ["Date", appointment?.date ? displayDate(appointment.date, "en") : ""],
    ["Time", appointment?.time ? displayTime(appointment.time, "en") : ""],
    ["Token", appointment?.tokenNumber],
    ["Appointment ID", appointment?.appointmentId],
    ["Source", appointment?.source || "Unknown"],
    ["Reception", DOCTOR.contact]
  ].map(([label, value]) => [label, compactText(value, 300)]);
  if (fields.some(([, value]) => !value)) return null;
  const subject = `New appointment: ${fields[0][1]} - ${fields[3][1]} ${fields[4][1]}`;
  const text = ["A new appointment has been confirmed.", "", ...fields.map(([label, value]) => `${label}: ${value}`), "", `Open admin panel: ${config.adminPanelUrl}`].join("\n");
  const rows = fields.map(([label, value]) => `<tr><th align="left" style="padding:6px 12px 6px 0">${escapeHtml(label)}</th><td style="padding:6px 0">${escapeHtml(value)}</td></tr>`).join("");
  const html = `<h2>New appointment confirmed</h2><table>${rows}</table><p><a href="${escapeHtml(config.adminPanelUrl)}">Open admin panel</a></p>`;
  return { subject, text, html };
}

function getTransport(config) {
  if (transportOverride) return transportOverride;
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.password },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000
    });
  }
  return transport;
}

function safeFailure(error) {
  const code = String(error?.code || "").toUpperCase();
  const responseCode = Number(error?.responseCode || 0);
  const temporary = ["ETIMEDOUT", "ECONNECTION", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND", "ESOCKET"].includes(code)
    || (responseCode >= 400 && responseCode < 500);
  return {
    temporary,
    code: temporary ? "EMAIL_TEMPORARY_FAILURE" : "EMAIL_PERMANENT_FAILURE",
    message: temporary ? "The email provider is temporarily unavailable." : "The email provider rejected the notification."
  };
}

export async function queueAppointmentEmail(appointment, { session = null } = {}) {
  const config = appointmentEmailConfig();
  const validation = validateAppointmentEmailConfig(config);
  if (!validation.enabled) return { queued: false, status: "disabled" };
  if (!validation.ok) return { queued: false, status: "invalid_configuration", code: validation.code };
  if (!appointment?.appointmentId || !["Booked", "Rescheduled"].includes(appointment.status) || !buildAppointmentEmail(appointment, config)) {
    return { queued: false, status: "invalid_appointment" };
  }
  await models.EmailNotificationOutbox.updateOne(
    { appointmentId: appointment.appointmentId, recipientEmail: config.to },
    { $setOnInsert: { notificationId: makePublicId("EML"), status: "queued", attemptCount: 0, nextRetryAt: new Date() } },
    { upsert: true, ...(session ? { session } : {}) }
  );
  return { queued: true, status: "queued" };
}

async function claimEmail(appointmentId = "", now = new Date()) {
  return models.EmailNotificationOutbox.findOneAndUpdate(
    {
      ...(appointmentId ? { appointmentId } : {}),
      $or: [
        { status: "queued", nextRetryAt: { $lte: now } },
        { status: "sending", lockExpiresAt: { $lte: now } }
      ]
    },
    { $set: { status: "sending", lockedAt: now, lockExpiresAt: new Date(now.getTime() + LOCK_MS), lastAttemptAt: now }, $inc: { attemptCount: 1 } },
    { returnDocument: "after", sort: { nextRetryAt: 1, createdAt: 1 } }
  ).lean();
}

export async function processOneAppointmentEmail({ appointmentId = "", now = new Date() } = {}) {
  const job = await claimEmail(appointmentId, now);
  if (!job) return null;
  const config = appointmentEmailConfig();
  try {
    const validation = validateAppointmentEmailConfig(config);
    if (!validation.ok || !validation.enabled) throw Object.assign(new Error(validation.code || "EMAIL_FEATURE_DISABLED"), { permanent: true });
    const appointment = await models.Appointment.findOne({ appointmentId: job.appointmentId }).lean();
    const message = appointment && ["Booked", "Rescheduled"].includes(appointment.status) ? buildAppointmentEmail(appointment, config) : null;
    if (!message) throw Object.assign(new Error("EMAIL_APPOINTMENT_INVALID"), { permanent: true });
    const result = await getTransport(config).sendMail({
      from: { name: config.fromName, address: config.fromAddress },
      to: job.recipientEmail,
      ...message,
      messageId: `<${job.notificationId}@${config.fromAddress.split("@")[1]}>`
    });
    return models.EmailNotificationOutbox.findOneAndUpdate(
      { notificationId: job.notificationId, status: "sending" },
      { $set: { status: "sent", sentAt: now, providerMessageId: result.messageId || "", failureCode: "", failureMessageSafe: "" }, $unset: { lockedAt: "", lockExpiresAt: "", nextRetryAt: "", failedAt: "" } },
      { returnDocument: "after" }
    ).lean();
  } catch (error) {
    const failure = error.permanent ? { temporary: false, code: error.message, message: "Email delivery configuration or appointment data is invalid." } : safeFailure(error);
    const canRetry = failure.temporary && job.attemptCount < MAX_ATTEMPTS;
    const retryDelay = canRetry ? RETRY_DELAYS_MS[job.attemptCount - 1] : null;
    const updated = await models.EmailNotificationOutbox.findOneAndUpdate(
      { notificationId: job.notificationId, status: "sending" },
      {
        $set: { status: canRetry ? "queued" : (failure.temporary ? "dead_letter" : "failed"), failedAt: now, failureCode: failure.code, failureMessageSafe: failure.message, nextRetryAt: retryDelay ? new Date(now.getTime() + retryDelay) : null },
        $unset: { lockedAt: "", lockExpiresAt: "" }
      },
      { returnDocument: "after" }
    ).lean();
    console.warn("Appointment email failed", { appointmentId: job.appointmentId, code: failure.code });
    return updated;
  }
}

export function scheduleAppointmentEmail(appointmentId) {
  setTimeout(() => processOneAppointmentEmail({ appointmentId }).catch((error) => console.error("Appointment email worker failed", { code: error?.code || error?.name })), 0).unref?.();
}

export function publicAppointmentEmail(job) {
  if (!job) return appointmentEmailConfig().enabled
    ? { status: "not_sent", canRetry: true }
    : { status: "not_configured", canRetry: false };
  return { status: job.status, canRetry: ["failed", "dead_letter"].includes(job.status), failureCode: job.failureCode || "" };
}

export async function appointmentEmailsForAppointments(appointmentIds = []) {
  const ids = [...new Set(appointmentIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const jobs = await models.EmailNotificationOutbox.find({ appointmentId: { $in: ids } }).lean();
  return new Map(jobs.map((job) => [job.appointmentId, publicAppointmentEmail(job)]));
}

export async function retryAppointmentEmail(appointmentId, { schedule = true } = {}) {
  const appointment = await models.Appointment.findOne({ appointmentId }).lean();
  if (!appointment || !["Booked", "Rescheduled"].includes(appointment.status)) throw Object.assign(new Error("Active appointment was not found."), { status: 404 });
  let job = await models.EmailNotificationOutbox.findOneAndUpdate(
    { appointmentId, status: { $in: ["failed", "dead_letter"] } },
    { $set: { status: "queued", attemptCount: 0, nextRetryAt: new Date(), providerMessageId: "", failureCode: "", failureMessageSafe: "" }, $unset: { lockedAt: "", lockExpiresAt: "", failedAt: "", sentAt: "" } },
    { returnDocument: "after" }
  ).lean();
  if (!job) {
    const existing = await models.EmailNotificationOutbox.findOne({ appointmentId }).lean();
    if (existing) return publicAppointmentEmail(existing);
    const queued = await queueAppointmentEmail(appointment);
    if (!queued.queued) throw Object.assign(new Error("Email configuration is incomplete."), { status: 409 });
    job = await models.EmailNotificationOutbox.findOne({ appointmentId }).lean();
  }
  if (schedule) scheduleAppointmentEmail(appointmentId);
  return publicAppointmentEmail(job);
}

export function startAppointmentEmailWorker({ intervalMs = 15_000 } = {}) {
  if (workerTimer) return workerTimer;
  const tick = async () => {
    if (workerRunning) return;
    workerRunning = true;
    try {
      for (let index = 0; index < 20; index += 1) if (!await processOneAppointmentEmail()) break;
    } finally {
      workerRunning = false;
    }
  };
  workerTimer = setInterval(tick, Math.max(1_000, Number(intervalMs) || 15_000));
  workerTimer.unref?.();
  setTimeout(tick, 0).unref?.();
  return workerTimer;
}

export function stopAppointmentEmailWorker() {
  if (workerTimer) clearInterval(workerTimer);
  workerTimer = null;
  workerRunning = false;
}

export function setAppointmentEmailTransportForTests(value) {
  transportOverride = value;
  transport = undefined;
}

export function resetAppointmentEmailTransportForTests() {
  transportOverride = undefined;
  transport = undefined;
}
