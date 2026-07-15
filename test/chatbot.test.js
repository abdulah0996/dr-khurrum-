import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { classifyIntent } from "../server/services/chatbotService.js";
import { APPOINTMENT_POLICIES, DEFAULT_LOCATIONS, DOCTOR, VERIFIED_CLINIC, VERIFIED_GENERAL_SCHEDULE } from "../server/config/clinic.js";
import {
  generateScheduleSlots,
  isInsideSameDayCutoff,
  isWithinAdvanceWindow,
  minutesUntilLocalAppointment,
  tokenNumberForTime
} from "../server/services/slotService.js";
import { validateEnvironment, whatsappConfigured } from "../server/config/validation.js";
import { AppointmentSchema } from "../server/models/index.js";
import { isValidPatientName } from "../server/utils/validation.js";
import {
  appointmentConfirmation,
  contactReceptionMessage,
  doctorProfileMessage,
  emergencyMessage,
  isolateLtr,
  languagePrompt,
  locationsMessage,
  mainMenu
} from "../server/services/messageTemplates.js";
import {
  appointmentTemplateComponents,
  inboundConsentUpdate,
  isInsideServiceWindow,
  isOptInMessage,
  isOptOutMessage,
  isRetryableWhatsAppStatus,
  templateNameForMessageType,
  verifyMetaSignature
} from "../server/services/whatsappService.js";
import { setupClinic } from "../scripts/setup-clinic.js";
import { makeAppointmentId, maskPhone, normalizePhone } from "../server/utils/time.js";

test("menu and intent mapping preserve English, Urdu, and all appointment actions", () => {
  assert.equal(classifyIntent("I need appointment"), "book");
  assert.equal(classifyIntent("appointment cancel karni hai"), "cancel");
  assert.equal(classifyIntent("clinic timing"), "locations");
  assert.equal(classifyIntent("ہنگامی رہنمائی"), "emergency");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map(String).map(classifyIntent), [
    "book", "check", "reschedule", "cancel", "locations", "profile", "reception", "emergency", "language"
  ]);
  assert.match(mainMenu("en"), /How may we help/);
  assert.match(mainMenu("ur"), /ہم آپ کی کس طرح مدد/);
  assert.doesNotMatch(mainMenu("en"), /1\. Book Appointment/);
  assert.match(languagePrompt(), /Dr\. Khurrum Mansoor/);
});

test("verified doctor and clinic configuration is exact and FCPS remains withheld", () => {
  assert.equal(DOCTOR.nameEn, "Dr. Khurrum Mansoor");
  assert.equal(DOCTOR.nameUr, "ڈاکٹر خرم منصور");
  assert.equal(DOCTOR.qualificationsEn, "MBBS");
  assert.deepEqual(DOCTOR.pendingQualifications, ["FCPS"]);
  assert.equal(DOCTOR.specialtyEn, "Consultant Gynecologist");
  assert.equal(DOCTOR.specialtyUr, "ماہرِ امراضِ نسواں");
  assert.equal(DOCTOR.contact, "+92 335 7504478");
  assert.equal(VERIFIED_CLINIC.nameEn, "Nighat Medical Complex");
  assert.equal(VERIFIED_CLINIC.nameUr, "نگہت میڈیکل کمپلیکس");
  assert.match(VERIFIED_CLINIC.addressEn, /Gojra Road.*Jhang.*33200.*Pakistan/);
  assert.match(VERIFIED_CLINIC.addressUr, /گوجرہ روڈ.*جھنگ.*33200.*پاکستان/);
  assert.deepEqual(DEFAULT_LOCATIONS, []);
});

test("verified schedule creates exactly 28 time-linked tokens and excludes the prayer break", () => {
  const monday = "2026-06-29";
  const slots = generateScheduleSlots(VERIFIED_GENERAL_SCHEDULE, monday);
  assert.equal(slots.length, 28);
  assert.equal(slots[0], "09:00");
  assert.equal(slots[15], "12:45");
  assert.equal(slots[16], "14:00");
  assert.equal(slots[27], "16:45");
  assert.deepEqual(slots.filter((time) => time >= "13:00" && time < "14:00"), []);
  slots.forEach((time, index) => assert.equal(tokenNumberForTime(VERIFIED_GENERAL_SCHEDULE, monday, time), index + 1));
  assert.equal(tokenNumberForTime(VERIFIED_GENERAL_SCHEDULE, monday, "13:15"), null);
  for (const unavailable of ["08:45", "13:00", "13:15", "13:30", "13:45", "17:00"]) {
    assert.equal(tokenNumberForTime(VERIFIED_GENERAL_SCHEDULE, monday, unavailable), null);
  }
  assert.equal(generateScheduleSlots(VERIFIED_GENERAL_SCHEDULE, "2026-07-04").length, 0);
  assert.equal(generateScheduleSlots(VERIFIED_GENERAL_SCHEDULE, "2026-07-05").length, 0);
});

test("booking windows enforce 30 days and the same-day 30-minute cutoff", () => {
  assert.equal(isWithinAdvanceWindow("2026-07-15", "2026-07-15"), true);
  assert.equal(isWithinAdvanceWindow("2026-08-14", "2026-07-15"), true);
  assert.equal(isWithinAdvanceWindow("2026-08-15", "2026-07-15"), false);
  assert.equal(isInsideSameDayCutoff("10:29", "10:00"), true);
  assert.equal(isInsideSameDayCutoff("10:30", "10:00"), false);
  assert.equal(APPOINTMENT_POLICIES.sameDayCutoffMinutes, 30);
});

test("cancellation and rescheduling use a two-hour patient cutoff", () => {
  assert.equal(minutesUntilLocalAppointment("2026-07-15", "12:00", "2026-07-15", "10:00"), 120);
  assert.equal(minutesUntilLocalAppointment("2026-07-15", "11:59", "2026-07-15", "10:00"), 119);
  assert.equal(APPOINTMENT_POLICIES.cancellationCutoffMinutes, 120);
  assert.equal(APPOINTMENT_POLICIES.rescheduleCutoffMinutes, 120);
});

test("database indexes prevent duplicate active time slots and tokens", () => {
  const indexes = AppointmentSchema.indexes().map(([keys, options]) => ({ keys, options }));
  assert.ok(indexes.some(({ keys, options }) => keys.locationId === 1 && keys.date === 1 && keys.time === 1 && options.unique));
  assert.ok(indexes.some(({ keys, options }) => keys.locationId === 1 && keys.date === 1 && keys.tokenNumber === 1 && options.unique));
  assert.ok(indexes.some(({ keys, options }) => keys.normalizedPhone === 1 && keys.date === 1 && options.unique));
});

test("profile, clinic, reception, confirmation, and emergency content is bilingual", () => {
  const clinic = { ...VERIFIED_CLINIC, locationId: "LOC-VERIFIED" };
  assert.match(doctorProfileMessage("en"), /Consultant Gynecologist/);
  assert.match(doctorProfileMessage("ur"), /ماہرِ امراضِ نسواں/);
  assert.doesNotMatch(doctorProfileMessage("en"), /FCPS/);
  assert.match(locationsMessage([clinic], "en"), /Nighat Medical Complex[\s\S]*1:00 PM to 2:00 PM/);
  assert.match(locationsMessage([clinic], "ur"), /نگہت میڈیکل کمپلیکس[\s\S]*نماز اور کلینک کا وقفہ/);
  assert.equal(contactReceptionMessage("en"), "For appointment assistance, please contact the reception team at +92 335 7504478 during clinic hours.");
  assert.match(contactReceptionMessage("ur"), /\u2066\+92 335 7504478\u2069/u);
  assert.match(emergencyMessage("en"), /Heavy vaginal bleeding/);
  assert.match(emergencyMessage("ur"), /بہت زیادہ اندام نہانی سے خون آنا/);
  const confirmation = appointmentConfirmation({
    appointmentId: "KHR-20260716-ABC123",
    patientName: "Patient Name",
    locationNameEn: clinic.nameEn,
    locationNameUr: clinic.nameUr,
    date: "2026-07-16",
    time: "10:30",
    tokenNumber: 7
  });
  assert.match(confirmation, /Token Number: 7/);
  assert.match(confirmation, /Patient: Patient Name/);
  assert.match(confirmation, /Appointment ID: KHR-20260716-ABC123/);
  assert.match(confirmation, /Save this ID/);
});

test("patient names allow multilingual letters and reject numbers or symbols only", () => {
  assert.equal(isValidPatientName("Patient Name"), true);
  assert.equal(isValidPatientName("مریض کا نام"), true);
  assert.equal(isValidPatientName("12345"), false);
  assert.equal(isValidPatientName("---"), false);
});

test("phone numbers normalize, mask, and isolate safely", () => {
  assert.equal(normalizePhone("+92 335 7504478"), "+923357504478");
  assert.equal(maskPhone("+92 335 7504478"), "+923****478");
  assert.equal(isolateLtr("+92 335 7504478"), "\u2066+92 335 7504478\u2069");
});

test("environment validation blocks incomplete production configuration", () => {
  const result = validateEnvironment({ NODE_ENV: "production", WHATSAPP_REQUIRED: "true" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join(" "), /MONGODB_URI/);
  assert.match(result.errors.join(" "), /WHATSAPP_ACCESS_TOKEN/);
  assert.equal(whatsappConfigured({}), false);
  const wrongTimezone = validateEnvironment({ NODE_ENV: "production", DEFAULT_TIMEZONE: "UTC" });
  assert.match(wrongTimezone.errors.join(" "), /DEFAULT_TIMEZONE must be Asia\/Karachi/);
});

test("WhatsApp policy and template helpers are safe", () => {
  assert.equal(isOptOutMessage("STOP"), true);
  assert.equal(isOptOutMessage("بند"), true);
  assert.equal(isOptOutMessage("appointment cancel karni hai"), false);
  assert.equal(isOptInMessage("START"), true);
  const now = new Date("2026-06-27T12:00:00.000Z");
  assert.equal(isInsideServiceWindow("2026-06-26T13:00:00.000Z", now), true);
  assert.equal(isInsideServiceWindow("2026-06-26T11:59:00.000Z", now), false);
  assert.equal(isRetryableWhatsAppStatus(429), true);
  assert.equal(isRetryableWhatsAppStatus(400), false);

  const previous = process.env.WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION;
  process.env.WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION = "appointment_confirmation_v1";
  assert.equal(templateNameForMessageType("appointment_confirmation"), "appointment_confirmation_v1");
  if (previous === undefined) delete process.env.WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION;
  else process.env.WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION = previous;

  const components = appointmentTemplateComponents({
    doctorName: DOCTOR.nameEn,
    date: "2026-07-16",
    time: "10:30",
    locationNameEn: VERIFIED_CLINIC.nameEn,
    tokenNumber: 7,
    appointmentId: "KHR-20260716-ABC123"
  });
  assert.equal(components[0].parameters.length, 7);
  assert.equal(components[0].parameters[6].text, "+92 335 7504478");
});

test("Meta webhook signature verification rejects invalid signatures", () => {
  const previous = process.env.META_APP_SECRET;
  process.env.META_APP_SECRET = "a".repeat(32);
  const rawBody = Buffer.from(JSON.stringify({ object: "whatsapp_business_account" }));
  const signature = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(rawBody).digest("hex")}`;
  assert.equal(verifyMetaSignature({ headers: { "x-hub-signature-256": signature }, rawBody }), true);
  assert.equal(verifyMetaSignature({ headers: { "x-hub-signature-256": "sha256=bad" }, rawBody }), false);
  if (previous === undefined) delete process.env.META_APP_SECRET;
  else process.env.META_APP_SECRET = previous;
});

test("session draft and consent production fixes remain intact", () => {
  const chatbotSource = fs.readFileSync(new URL("../server/services/chatbotService.js", import.meta.url), "utf8");
  assert.match(chatbotSource, /session\.markModified\("draft"\)/);
  assert.doesNotMatch(chatbotSource, /ChatSession\.findOneAndUpdate/);
  for (const optIn of [true, false]) {
    const update = inboundConsentUpdate({ phone: "+923357504478", normalizedPhone: "+923357504478", optIn });
    assert.equal(Object.hasOwn(update.$set, "lastOptInAt") && Object.hasOwn(update.$setOnInsert, "lastOptInAt"), false);
  }
});

test("rescheduling validates the new slot before changing the original appointment", () => {
  const source = fs.readFileSync(new URL("../server/services/appointmentService.js", import.meta.url), "utf8");
  const section = source.slice(source.indexOf("export async function rescheduleAppointment"), source.indexOf("export async function cancelAppointment"));
  assert.ok(section.indexOf("validateSlotAvailability") < section.indexOf("findOneAndUpdate"));
  assert.match(section, /rescheduleHistory/);
});

test("clinic setup refuses missing MongoDB configuration and uses stable upserts", async () => {
  const previous = process.env.MONGODB_URI;
  delete process.env.MONGODB_URI;
  await assert.rejects(setupClinic(), /MONGODB_URI is required/);
  if (previous !== undefined) process.env.MONGODB_URI = previous;
  const source = fs.readFileSync(new URL("../scripts/setup-clinic.js", import.meta.url), "utf8");
  assert.match(source, /slug: VERIFIED_CLINIC\.slug/);
  assert.equal((source.match(/upsert: true/g) || []).length, 3);
  assert.doesNotMatch(source, /Patient\.(create|insert)|Appointment\.(create|insert)/);
  const startupSource = fs.readFileSync(new URL("../server/services/clinicConfigService.js", import.meta.url), "utf8");
  assert.match(startupSource, /No verified active clinic location is configured/);
  assert.match(startupSource, /Every verified active clinic must have one active schedule/);
});

test("new appointment references use the Dr. Khurrum prefix", () => {
  assert.match(makeAppointmentId(), /^KHR-\d{8}-[A-F0-9]{6}$/);
});
