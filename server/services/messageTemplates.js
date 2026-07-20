import { DOCTOR, VERIFIED_GENERAL_SCHEDULE } from "../config/clinic.js";
import { displayDate, displayTime, maskPhone } from "../utils/time.js";

export function isUrdu(language = "en") {
  return language === "ur";
}

export function isolateLtr(value) {
  return `\u2066${value}\u2069`;
}

function contactLine(language, doctor = DOCTOR) {
  const contact = doctor.receptionPhone || doctor.contact || DOCTOR.contact;
  return isUrdu(language)
    ? `ریسپشن: ${isolateLtr(contact)}`
    : `Reception: ${contact}`;
}

export function languagePrompt() {
  return [
    "👋 Welcome to Dr. Khurrum Mansoor’s Appointment Assistant",
    "",
    "Please choose your preferred language.",
    "",
    "ڈاکٹر خرم منصور کے اپائنٹمنٹ اسسٹنٹ میں خوش آمدید",
    "",
    "براہِ کرم اپنی پسندیدہ زبان منتخب کریں۔"
  ].join("\n");
}

export function mainMenu(language = "en") {
  if (isUrdu(language)) {
    return [
      "👋 ڈاکٹر خرم منصور کے اپائنٹمنٹ اسسٹنٹ میں خوش آمدید",
      "",
      "اپنی اپائنٹمنٹ آسانی اور محفوظ طریقے سے بک یا منظم کریں۔",
      "",
      "ہم آپ کی کس طرح مدد کر سکتے ہیں؟"
    ].join("\n");
  }

  return [
    "👋 Welcome to Dr. Khurrum Mansoor’s Appointment Assistant",
    "",
    "Book and manage your appointment quickly and securely.",
    "",
    "How may we help you today?"
  ].join("\n");
}

export function consentMessage(language = "en") {
  if (isUrdu(language)) {
    return [
      "🔐 مریض کی رضامندی",
      "",
      "اپائنٹمنٹ منظم کرنے کے لیے ہمیں محفوظ طریقے سے یہ معلومات درکار ہیں:",
      "",
      "• مریض کا نام",
      "• رابطہ نمبر",
      "• اپائنٹمنٹ کی تاریخ اور وقت",
      "• مشاورت کی وجہ",
      "",
      "آپ کی معلومات صرف اپائنٹمنٹ کے انتظام کے لیے استعمال ہوں گی۔",
      "",
      "ایک آپشن منتخب کریں:"
    ].join("\n");
  }
  return [
    "🔐 Patient Consent",
    "",
    "To manage your clinic appointment, we need to securely save:",
    "",
    "• Patient name",
    "• Contact number",
    "• Appointment date and time",
    "• Reason for consultation",
    "",
    "Your information will only be used for appointment management.",
    "",
    "Choose an option:"
  ].join("\n");
}

const URDU_DAYS = { Monday: "پیر", Tuesday: "منگل", Wednesday: "بدھ", Thursday: "جمعرات", Friday: "جمعہ", Saturday: "ہفتہ", Sunday: "اتوار" };

function locationScheduleLines(schedule, language) {
  const activeSchedule = schedule || VERIFIED_GENERAL_SCHEDULE;
  const rules = activeSchedule.dayRules?.length ? activeSchedule.dayRules : [];
  if (rules.length) {
    const lines = [];
    for (const rule of rules) {
      const day = isUrdu(language) ? URDU_DAYS[rule.day] || rule.day : rule.day;
      if (!rule.working) {
        lines.push(isUrdu(language) ? `${day}: بند` : `${day}: Closed`);
        continue;
      }
      lines.push(
        isUrdu(language)
          ? `${day}: ${isolateLtr(displayTime(rule.openingTime, language))} سے ${isolateLtr(displayTime(rule.closingTime, language))}`
          : `${day}: ${displayTime(rule.openingTime, language)} to ${displayTime(rule.closingTime, language)}`
      );
      for (const item of rule.breaks || []) {
        const label = isUrdu(language) ? item.labelUr || "وقفہ" : item.labelEn || "Break";
        lines.push(
          isUrdu(language)
            ? `  ${label}: ${isolateLtr(displayTime(item.startTime, language))} سے ${isolateLtr(displayTime(item.endTime, language))}`
            : `  ${label}: ${displayTime(item.startTime, language)} to ${displayTime(item.endTime, language)}`
        );
      }
    }
    return [...lines, isUrdu(language) ? `ہر اپائنٹمنٹ کا دورانیہ دن کے شیڈول کے مطابق ہے۔` : "Appointment duration follows each day's schedule."];
  }

  const weekdays = activeSchedule.workingDays || [];
  const standardWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].every((day) => weekdays.includes(day)) && weekdays.length === 5;
  const workingLabel = standardWeek
    ? isUrdu(language) ? "پیر تا جمعہ" : "Monday to Friday"
    : weekdays.map((day) => isUrdu(language) ? URDU_DAYS[day] || day : day).join(", ");
  const closed = Object.keys(URDU_DAYS).filter((day) => !weekdays.includes(day));
  const breakLabel = isUrdu(language)
    ? schedule ? activeSchedule.breakReasonUr || "وقفہ" : "نماز اور کلینک کا وقفہ"
    : activeSchedule.breakReasonEn || "Prayer and Clinic Break";
  return [
    workingLabel,
    isUrdu(language)
      ? `${isolateLtr(displayTime(activeSchedule.openingTime, language))} سے ${isolateLtr(displayTime(activeSchedule.closingTime, language))}`
      : `${displayTime(activeSchedule.openingTime, language)} to ${displayTime(activeSchedule.closingTime, language)}`,
    ...(activeSchedule.breakStart && activeSchedule.breakEnd
      ? ["", breakLabel, isUrdu(language)
        ? `${isolateLtr(displayTime(activeSchedule.breakStart, language))} سے ${isolateLtr(displayTime(activeSchedule.breakEnd, language))}`
        : `${displayTime(activeSchedule.breakStart, language)} to ${displayTime(activeSchedule.breakEnd, language)}`]
      : []),
    "",
    isUrdu(language)
      ? `${closed.map((day) => URDU_DAYS[day]).join(" اور ")}: بند`
      : `${closed.join(" and ")}: Closed`,
    isUrdu(language)
      ? `ہر اپائنٹمنٹ کا دورانیہ: ${isolateLtr(activeSchedule.slotDurationMinutes)} منٹ`
      : `Appointment Duration: ${activeSchedule.slotDurationMinutes} minutes`
  ];
}

export function locationsMessage(locations = [], language = "en", schedules = []) {
  if (!locations.length) {
    return isUrdu(language)
      ? "تصدیق شدہ کلینک کی معلومات فی الحال دستیاب نہیں ہیں۔ براہِ کرم ریسپشن سے رابطہ کریں۔"
      : "Verified clinic information is not available yet. Please contact reception.";
  }
  const blocks = locations.map((location) => {
    const timingLines = locationScheduleLines(schedules.find((item) => item.locationId === location.locationId), language);
    if (isUrdu(language)) {
      return [
        DOCTOR.nameUr,
        DOCTOR.specialtyUr,
        DOCTOR.qualificationsUr,
        "",
        location.nameUr,
        location.addressUr,
        "",
        ...timingLines,
        contactLine(language)
      ].join("\n");
    }
    return [
      DOCTOR.nameEn,
      DOCTOR.specialtyEn,
      DOCTOR.qualificationsEn,
      "",
      location.nameEn,
      location.addressEn,
      "",
      ...timingLines,
      contactLine(language)
    ].join("\n");
  });
  return blocks.join("\n\n");
}

export function doctorProfileMessage(language = "en", doctor = DOCTOR) {
  return isUrdu(language)
    ? [doctor.nameUr, doctor.qualificationsUr, doctor.specialtyUr, "", doctor.biographyUr, "", contactLine(language, doctor)].join("\n")
    : [doctor.nameEn, doctor.qualificationsEn, doctor.specialtyEn, "", doctor.biographyEn, "", contactLine(language, doctor)].join("\n");
}

export function emergencyMessage(language = "en") {
  if (isUrdu(language)) {
    return [
      "⚠️ ہنگامی رہنمائی",
      "",
      "یہ چیٹ بوٹ صرف اپائنٹمنٹ اور کلینک کی عمومی معلومات کے لیے ہے۔ یہ ہنگامی طبی سہولت فراہم نہیں کرتا۔",
      "",
      "درج ذیل صورتوں میں فوراً قریبی ہسپتال کی ایمرجنسی میں جائیں یا مقامی ایمرجنسی سروس سے رابطہ کریں:",
      "",
      "• بہت زیادہ اندام نہانی سے خون آنا",
      "• پیٹ یا پیڑو میں شدید درد",
      "• بے ہوشی، گر جانا یا ہوش کھو دینا",
      "• دورے پڑنا",
      "• سانس لینے میں شدید دشواری یا سینے میں درد",
      "• حمل کے دوران شدید سر درد کے ساتھ نظر دھندلانا یا روشنی کی چمک دکھائی دینا",
      "• زیادہ خون آنے کے ساتھ چکر یا شدید کمزوری",
      "• حمل کے دوران پانی آنے کے ساتھ درد، خون یا کوئی سنگین تشویش",
      "• کوئی بھی ایسی حالت جو جان لیوا محسوس ہو یا تیزی سے خراب ہو رہی ہو",
      "",
      "ہنگامی صورتحال میں چیٹ بوٹ کے جواب یا معمول کی اپائنٹمنٹ کا انتظار نہ کریں۔",
      "",
      `فوری لیکن مستحکم اپائنٹمنٹ مدد کے لیے ریسپشن سے ${isolateLtr(DOCTOR.contact)} پر رابطہ کریں۔`
    ].join("\n");
  }
  return [
    "⚠️ Emergency Guidance",
    "",
    "This chatbot is only for appointments and general clinic information. It does not provide emergency medical care.",
    "",
    "Please go immediately to the nearest hospital emergency department or contact local emergency services if you have:",
    "",
    "• Heavy vaginal bleeding",
    "• Severe abdominal or pelvic pain",
    "• Fainting, collapse or loss of consciousness",
    "• Seizures",
    "• Severe breathing difficulty or chest pain",
    "• A severe headache with blurred vision or flashing lights during pregnancy",
    "• Heavy bleeding with dizziness or weakness",
    "• Fluid leaking during pregnancy with pain, bleeding or serious concern",
    "• Any condition that feels life-threatening or is rapidly becoming worse",
    "",
    "Do not wait for a chatbot response or a routine appointment during an emergency.",
    "",
    `For urgent but stable appointment assistance, contact reception at ${DOCTOR.contact}.`
  ].join("\n");
}

export function contactReceptionMessage(language = "en", doctor = DOCTOR) {
  const contact = doctor.receptionPhone || doctor.contact || DOCTOR.contact;
  return isUrdu(language)
    ? `اپائنٹمنٹ سے متعلق مدد کے لیے کلینک کے اوقات میں ریسپشن ٹیم سے ${isolateLtr(contact)} پر رابطہ کریں۔`
    : `For appointment assistance, please contact the reception team at ${contact} during clinic hours.`;
}

export function lateArrivalMessage(language = "en") {
  return isUrdu(language)
    ? `براہِ کرم اپنی اپائنٹمنٹ سے کم از کم 10 منٹ پہلے پہنچیں۔ اگر آپ کو دیر ہونے کا امکان ہو تو ریسپشن سے ${isolateLtr(DOCTOR.contact)} پر رابطہ کریں۔ دیر سے پہنچنے کی صورت میں کلینک کی دستیابی کے مطابق انتظار یا نئی اپائنٹمنٹ کی ضرورت ہو سکتی ہے۔`
    : `Please arrive at least 10 minutes before your appointment. If you expect to be late, contact reception at ${DOCTOR.contact}. Late arrival may result in additional waiting or rescheduling, depending on clinic availability.`;
}

export function appointmentConfirmation(appointment, language = "en") {
  const location = isUrdu(language) ? appointment.locationNameUr : appointment.locationNameEn;
  if (isUrdu(language)) {
    return [
      "✅ اپائنٹمنٹ کی تصدیق ہو گئی ہے",
      "",
      `اپائنٹمنٹ آئی ڈی: ${isolateLtr(appointment.appointmentId)}`,
      "اس آئی ڈی کو محفوظ رکھیں۔ اپائنٹمنٹ چیک، تبدیل یا منسوخ کرنے کے لیے اس آئی ڈی اور فون نمبر کی ضرورت ہوگی۔",
      "",
      `ڈاکٹر: ${DOCTOR.nameUr}`,
      `ہسپتال: ${location}`,
      `تاریخ: ${isolateLtr(displayDate(appointment.date, language))}`,
      `وقت: ${isolateLtr(displayTime(appointment.time, language))}`,
      `ٹوکن نمبر: ${isolateLtr(appointment.tokenNumber)}`,
      `مریض کا نام: ${appointment.patientName}`,
      "",
      "براہِ کرم مقررہ وقت سے کم از کم 10 منٹ پہلے پہنچیں۔",
      "اگر مریض مقررہ ٹوکن وقت کے 15 منٹ کے اندر نہ پہنچے تو اپائنٹمنٹ منسوخ کر دی جائے گی۔",
      "",
      contactLine(language)
    ].join("\n");
  }
  return [
    "✅ Appointment Confirmed",
    "",
    `Appointment ID: ${appointment.appointmentId}`,
    "Save this ID. You will need it with your phone number to check, reschedule, or cancel your appointment.",
    "",
    `Doctor: ${DOCTOR.nameEn}`,
    `Hospital: ${location}`,
    `Date: ${displayDate(appointment.date, language)}`,
    `Time: ${displayTime(appointment.time, language)}`,
    `Token Number: ${appointment.tokenNumber}`,
    `Patient: ${appointment.patientName}`,
    "",
    "Please arrive at least 10 minutes before your scheduled time.",
    "If the patient does not arrive within 15 minutes of the scheduled token time, the appointment will be cancelled.",
    "",
    contactLine(language)
  ].join("\n");
}

export function appointmentLookupMessage(appointment, language = "en") {
  const location = isUrdu(language) ? appointment.locationNameUr : appointment.locationNameEn;
  if (isUrdu(language)) {
    return [
      "آپ کی اپائنٹمنٹ کی تفصیلات:",
      `اپائنٹمنٹ آئی ڈی: ${isolateLtr(appointment.appointmentId)}`,
      `ڈاکٹر: ${DOCTOR.nameUr}`,
      `تاریخ: ${isolateLtr(displayDate(appointment.date, language))}`,
      `وقت: ${isolateLtr(displayTime(appointment.time, language))}`,
      `ہسپتال: ${location}`,
      `سٹیٹس: ${appointment.status}`,
      `ٹوکن نمبر: ${isolateLtr(appointment.tokenNumber)}`,
      `فون: ${isolateLtr(appointment.maskedPhone || maskPhone(appointment.normalizedPhone || appointment.phone))}`
    ].join("\n");
  }
  return [
    "Your appointment details:",
    `Appointment ID: ${appointment.appointmentId}`,
    `Doctor: ${DOCTOR.nameEn}`,
    `Date: ${displayDate(appointment.date, language)}`,
    `Time: ${displayTime(appointment.time, language)}`,
    `Hospital: ${location}`,
    `Status: ${appointment.status}`,
    `Token Number: ${appointment.tokenNumber}`,
    `Phone: ${appointment.maskedPhone || maskPhone(appointment.normalizedPhone || appointment.phone)}`
  ].join("\n");
}

export function rescheduleConfirmation(appointment, language = "en") {
  return isUrdu(language)
    ? `آپ کی اپائنٹمنٹ کامیابی سے تبدیل کر دی گئی ہے۔\n\nبراہِ کرم نئی تاریخ، وقت اور ٹوکن نمبر کے مطابق تشریف لائیں اور مقررہ وقت سے کم از کم 10 منٹ پہلے پہنچیں۔\n\n${appointmentConfirmation(appointment, language)}`
    : `Your appointment has been rescheduled successfully.\n\nPlease follow your new appointment date, time and token number. Arrive at least 10 minutes before the scheduled time.\n\n${appointmentConfirmation(appointment, language)}`;
}

export function cancellationConfirmation(appointment, language = "en") {
  if (isUrdu(language)) {
    return [
      "آپ کی اپائنٹمنٹ کامیابی سے منسوخ کر دی گئی ہے۔ خالی ہونے والا وقت اب کسی دوسرے مریض کے لیے دستیاب ہو سکتا ہے۔",
      "",
      `اپائنٹمنٹ آئی ڈی: ${isolateLtr(appointment.appointmentId)}`,
      `تاریخ: ${isolateLtr(displayDate(appointment.date, language))}`,
      `وقت: ${isolateLtr(displayTime(appointment.time, language))}`,
      "",
      `اپائنٹمنٹ سے دو گھنٹے سے کم وقت پہلے منسوخی کے لیے ریسپشن سے ${isolateLtr(DOCTOR.contact)} پر رابطہ کریں۔`
    ].join("\n");
  }
  return [
    "Your appointment has been cancelled successfully. The released time slot may now be booked by another patient.",
    "",
    `Appointment ID: ${appointment.appointmentId}`,
    `Date: ${displayDate(appointment.date, language)}`,
    `Time: ${displayTime(appointment.time, language)}`,
    "",
    `For a cancellation less than two hours before your appointment, please contact reception at ${DOCTOR.contact}.`
  ].join("\n");
}
