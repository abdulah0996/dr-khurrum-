import crypto from "node:crypto";
import { TIMEZONE } from "../config/clinic.js";

export function pad(value) {
  return String(value).padStart(2, "0");
}

export function toMinutes(time) {
  const [hours, minutes] = String(time || "").split(":").map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function fromMinutes(total) {
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

export function todayIso(timezone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function currentTimeHHMM(timezone = TIMEZONE) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

export function addDaysIso(dateIso, days) {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function dayName(dateIso) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "UTC"
  }).format(new Date(`${dateIso}T00:00:00.000Z`));
}

export function isPastDate(dateIso) {
  const requested = Date.parse(`${dateIso}T00:00:00.000Z`);
  const today = Date.parse(`${todayIso()}T00:00:00.000Z`);
  return Number.isFinite(requested) && requested < today;
}

export function isPastDateTime(dateIso, time) {
  if (dateIso !== todayIso()) return false;
  const requested = toMinutes(time);
  const now = toMinutes(currentTimeHHMM());
  return requested !== null && now !== null && requested <= now;
}

export function displayDate(dateIso, language = "en") {
  return new Intl.DateTimeFormat(language === "ur" ? "ur-PK" : "en-GB", {
    day: "2-digit",
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  }).format(new Date(`${dateIso}T00:00:00.000Z`));
}

export function displayTime(time, language = "en") {
  const minutes = toMinutes(time);
  if (minutes === null) return time || "";
  const date = new Date(Date.UTC(2026, 0, 1, Math.floor(minutes / 60), minutes % 60));
  return new Intl.DateTimeFormat(language === "ur" ? "ur-PK" : "en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC"
  }).format(date);
}

export function normalizePhone(phone) {
  const raw = String(phone || "").trim();
  const digits = raw.replace(/[^\d]/g, "");

  if (/^03\d{9}$/.test(digits)) return `+92${digits.slice(1)}`;
  if (/^3\d{9}$/.test(digits)) return `+92${digits}`;
  if (/^92\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10,15}$/.test(digits) && raw.startsWith("+")) return `+${digits}`;
  if (/^\d{10,15}$/.test(digits)) return `+${digits}`;

  return raw.replace(/[^\d+]/g, "");
}

export function patientIdentityKey({ phone, fullName, gender }) {
  const normalizedName = compactText(fullName, 100)
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/[^\p{L}\p{M}]+/gu, " ")
    .trim();
  const input = `${normalizePhone(phone)}|${normalizedName}|${String(gender || "").toLowerCase()}`;
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function maskPhone(phone) {
  const normalized = normalizePhone(phone);
  if (normalized.length <= 6) return "****";
  return `${normalized.slice(0, 4)}****${normalized.slice(-3)}`;
}

export function makePublicId(prefix) {
  return `${prefix}-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

export function makeAppointmentId() {
  const date = todayIso().replaceAll("-", "");
  return `KHR-${date}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

export function compactText(value, max = 500) {
  return String(value || "")
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
