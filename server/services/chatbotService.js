import { models } from "../models/index.js";
import { DOCTOR } from "../config/clinic.js";
import { getDoctorProfile, listLocations, listSchedules } from "./clinicConfigService.js";
import { cancelAppointment, createAppointment, getAppointmentById, lookupAppointmentSafe, rescheduleAppointment, toPublicAppointment } from "./appointmentService.js";
import { getAvailability, getUpcomingAvailableDates } from "./slotService.js";
import {
  appointmentConfirmation,
  appointmentLookupMessage,
  cancellationConfirmation,
  consentMessage,
  contactReceptionMessage,
  doctorProfileMessage,
  emergencyMessage,
  languagePrompt,
  locationsMessage,
  mainMenu,
  rescheduleConfirmation
} from "./messageTemplates.js";
import { chatMessageSchema, isValidPatientName, phoneSchema } from "../utils/validation.js";
import { compactText, displayDate, displayTime, makePublicId, normalizePhone } from "../utils/time.js";
import { withConversationLock } from "./conversationLockService.js";
import { ACTIONS, dateAction, locationAction, normalizeChatAction, timeAction } from "./interactiveMessageService.js";
import { classifyEmergencyReason } from "./emergencyClassificationService.js";

function option(label, value, description = "") {
  return { label, value, ...(description ? { description } : {}) };
}

function navigationOptions(language = "en", { includeBack = true } = {}) {
  const options = [];
  if (includeBack) options.push(option(language === "ur" ? "واپس" : "Back", ACTIONS.back));
  options.push(option(language === "ur" ? "مین مینو" : "Main Menu", ACTIONS.mainMenu));
  return options;
}

function detectUrdu(text = "") {
  return /[\u0600-\u06FF]/.test(text);
}

function yes(value = "") {
  const text = value.trim().toLowerCase();
  return ["yes", "y", "1", "haan", "han", "ha", "ji", "jee", "جی", "ہاں", "yes continue"].includes(text);
}

function no(value = "") {
  const text = value.trim().toLowerCase();
  return ["no", "n", "2", "nahin", "nahi", "نہیں"].includes(text);
}

function numberChoice(text) {
  const match = String(text || "").trim().match(/^\d+$/);
  return match ? Number(match[0]) : null;
}

export function classifyIntent(input = "") {
  const text = input.toLowerCase().trim();
  const n = numberChoice(text);
  if (n === 1) return "book";
  if (n === 2) return "check";
  if (n === 3) return "reschedule";
  if (n === 4) return "cancel";
  if (n === 5) return "locations";
  if (n === 6) return "profile";
  if (n === 7) return "reception";
  if (n === 8) return "emergency";
  if (n === 9) return "language";

  if (/(book|appointment chahiye|appointment cha|need appointment|new appointment|اپائنٹمنٹ چاہیے|اپائنٹمنٹ بک)/i.test(input)) return "book";
  if (/(check|status|token|my appointment|اپنی اپائنٹمنٹ|چیک)/i.test(input)) return "check";
  if (/(reschedule|change time|time change|change appointment|تبدیل|وقت بدل|وقت تبدیل)/i.test(input)) return "reschedule";
  if (/(cancel|cancel karni|منسوخ|کینسل)/i.test(input)) return "cancel";
  if (/(where|location|timing|hours|clinic|doctor kahan|bethte|کہاں|لوکیشن|اوقات|وقت)/i.test(input)) return "locations";
  if (/(doctor profile|doctor details|qualification|ڈاکٹر صاحب|تعارف)/i.test(input)) return "profile";
  if (/(reception|contact|phone|call|رابطہ|ریسیپشن)/i.test(input)) return "reception";
  if (/(emergency guidance|emergency help|medical emergency|ایمرجنسی|ہنگامی رہنمائی)/i.test(input)) return "emergency";
  if (/(language|urdu|english|زبان|اردو)/i.test(input)) return "language";
  return "unknown";
}

async function getSession(normalizedPhone, hintedLanguage) {
  let session = await models.ChatSession.findOne({ normalizedPhone });
  if (!session) {
    session = await models.ChatSession.create({
      chatSessionId: makePublicId("CHT"),
      normalizedPhone,
      language: hintedLanguage || "en",
      step: "language",
      draft: {},
      lastMessageAt: new Date()
    });
  }
  return session;
}

async function saveSession(session, updates) {
  Object.assign(session, updates, { lastMessageAt: new Date() });
  session.markModified("draft");
  if (Object.hasOwn(updates, "processedInteractions")) session.markModified("processedInteractions");
  await session.save();
  return session;
}

async function resetToMenu(session, language = session.language) {
  await saveSession(session, { language, step: "menu", draft: {} });
  return { text: mainMenu(language), options: menuOptions(language), language };
}

function menuOptions(language = "en") {
  return language === "ur"
    ? [
        option("📅 اپائنٹمنٹ بک کریں", ACTIONS.book, "نئی اپائنٹمنٹ"),
        option("🔎 اپائنٹمنٹ چیک کریں", ACTIONS.check, "اپنی بکنگ دیکھیں"),
        option("🔄 اپائنٹمنٹ تبدیل کریں", ACTIONS.reschedule, "تاریخ یا وقت بدلیں"),
        option("❌ اپائنٹمنٹ منسوخ کریں", ACTIONS.cancel, "اپنی بکنگ منسوخ کریں"),
        option("🏥 کلینک معلومات", ACTIONS.locations, "پتہ اور اوقات"),
        option("👨‍⚕️ ڈاکٹر کا تعارف", ACTIONS.profile, "تصدیق شدہ پروفائل"),
        option("☎️ ریسپشن رابطہ", ACTIONS.reception, "اپائنٹمنٹ مدد"),
        option("🚨 ہنگامی رہنمائی", ACTIONS.emergency, "فوری حفاظتی رہنمائی"),
        option("🌐 زبان تبدیل کریں", ACTIONS.language, "English یا اردو")
      ]
    : [
        option("📅 Book Appointment", ACTIONS.book, "Start a secure booking"),
        option("🔎 Check Appointment", ACTIONS.check, "View your booking"),
        option("🔄 Reschedule", ACTIONS.reschedule, "Change date or time"),
        option("❌ Cancel Appointment", ACTIONS.cancel, "Cancel an active booking"),
        option("🏥 Clinic Information", ACTIONS.locations, "Address and timings"),
        option("👨‍⚕️ Doctor Profile", ACTIONS.profile, "Verified doctor details"),
        option("☎️ Reception Contact", ACTIONS.reception, "Get appointment help"),
        option("🚨 Emergency Guidance", ACTIONS.emergency, "Urgent safety guidance"),
        option("🌐 Change Language", ACTIONS.language, "English or Urdu")
      ];
}

async function locationOptions(language = "en") {
  const locations = await listLocations({ activeOnly: true });
  return {
    locations,
    text: locations.length
      ? language === "ur" ? "براہِ کرم کلینک منتخب کریں۔" : "Please select a clinic location."
      : language === "ur" ? "کوئی تصدیق شدہ فعال کلینک دستیاب نہیں ہے۔" : "No verified active clinic is available.",
    options: locations.map((location) => option(language === "ur" ? location.nameUr : location.nameEn, locationAction(location.locationId), location.city))
  };
}

function pickByNumberOrValue(value, items, idKey) {
  const n = numberChoice(value);
  if (n && items[n - 1]) return items[n - 1];
  const lower = value.toLowerCase().trim();
  return items.find((item) => String(item[idKey] || item.date || item.time).toLowerCase() === lower);
}

async function askDates(session, locationId, nextStep) {
  const language = session.language;
  const dates = await getUpcomingAvailableDates(locationId, 6);
  if (!dates.length) {
    await saveSession(session, { step: "menu", draft: {} });
    return {
      text: language === "ur" ? "اس کلینک کے لیے فی الحال کوئی دستیاب تاریخ نہیں ملی۔ براہِ کرم ریسیپشن سے رابطہ کریں۔" : "No available date was found for this clinic. Please contact reception.",
      options: menuOptions(language),
      language
    };
  }

  session.draft = { ...session.draft, dateOptions: dates };
  await saveSession(session, { step: nextStep, draft: session.draft });

  return {
    text: language === "ur" ? "دستیاب تاریخ منتخب کریں۔" : "Please select an available date.",
    options: dates.map((item) => option(displayDate(item.date, language), dateAction(item.date), item.day)),
    language
  };
}

async function askSlots(session, locationId, date, nextStep, requestedPage = 0) {
  const language = session.language;
  const availability = await getAvailability({ locationId, date, includeUnavailable: false });
  const slots = availability.availableSlots;
  if (!slots.length) {
    return askDates(session, locationId, nextStep === "book_time" ? "book_date" : "reschedule_date");
  }

  const pageSize = 6;
  const totalPages = Math.max(1, Math.ceil(slots.length / pageSize));
  const slotPage = Math.max(0, Math.min(Number(requestedPage) || 0, totalPages - 1));
  const pageSlots = slots.slice(slotPage * pageSize, (slotPage + 1) * pageSize);
  session.draft = { ...session.draft, slotOptions: pageSlots, slotPage, slotTotalPages: totalPages };
  await saveSession(session, { step: nextStep, draft: session.draft });

  const pagination = [];
  if (slotPage > 0) pagination.push(option(language === "ur" ? "پچھلے اوقات" : "Previous Times", ACTIONS.slotsPrevious));
  if (slotPage < totalPages - 1) pagination.push(option(language === "ur" ? "مزید اوقات" : "More Times", ACTIONS.slotsMore));
  const pageLabel = totalPages > 1
    ? language === "ur" ? ` صفحہ ${slotPage + 1} از ${totalPages}` : ` Page ${slotPage + 1} of ${totalPages}.`
    : "";

  return {
    text: language === "ur" ? `دستیاب وقت منتخب کریں۔${pageLabel}` : `Please select an available time slot.${pageLabel}`,
    options: [
      ...pageSlots.map((slot) => option(displayTime(slot.time, language), timeAction(slot.time, date), `${language === "ur" ? "ٹوکن" : "Token"} ${slot.tokenNumber}`)),
      ...pagination
    ],
    language
  };
}

async function staticReply(session, text) {
  const language = session.language;
  await saveSession(session, { step: "menu", draft: {} });
  return { text: `${text}\n\n${mainMenu(language)}`, options: menuOptions(language), language };
}

function ask(language, en, ur) {
  return language === "ur" ? ur : en;
}

function bookingProgress(language, step, text) {
  const labels = language === "ur"
    ? ["رضامندی", "مریض کی تفصیلات", "کلینک", "تاریخ", "وقت", "تصدیق"]
    : ["Consent", "Patient Details", "Clinic", "Date", "Time", "Confirmation"];
  const label = language === "ur" ? `مرحلہ ${step} از 6 — ${labels[step - 1]}` : `Step ${step} of 6 — ${labels[step - 1]}`;
  const menuHint = language === "ur" ? "مین مینو کے لیے MENU لکھیں۔" : "Type MENU at any time for the main menu.";
  return `${label}\n${text}\n\n${menuHint}`;
}

function patientNamePrompt(language = "en") {
  return ask(
    language,
    [
      "👤 Patient Name",
      "",
      "What is the patient’s full name?",
      "",
      "Please enter the name as it appears on the patient’s records.",
      "",
      "Example: Ahmed Khan"
    ].join("\n"),
    [
      "👤 مریض کا نام",
      "",
      "مریض کا مکمل نام کیا ہے؟",
      "",
      "براہِ کرم نام مریض کے ریکارڈ کے مطابق لکھیں۔",
      "",
      "مثال: علی احمد"
    ].join("\n")
  );
}

function patientPhonePrompt(language = "en", fullName = "") {
  return ask(
    language,
    `${fullName ? `✅ Name Recorded\n\nThank you, ${fullName}.\n\n` : ""}📱 Please enter the patient’s phone number.`,
    `${fullName ? `✅ نام درج کر لیا گیا\n\nشکریہ، ${fullName}۔\n\n` : ""}📱 براہِ کرم مریض کا فون نمبر لکھیں۔`
  );
}

function chatInputForStep(step, language = "en") {
  const urdu = language === "ur";
  const fields = {
    book_name: { mode: "text", field: "fullName", placeholder: urdu ? "مریض کا مکمل نام لکھیں…" : "Enter patient’s full name…", autoComplete: "name" },
    book_phone: { mode: "text", field: "bookingPhone", placeholder: urdu ? "مریض کا فون نمبر لکھیں…" : "Enter patient’s phone number…", inputMode: "tel", autoComplete: "tel" },
    book_age: { mode: "text", field: "age", placeholder: urdu ? "مریض کی عمر لکھیں…" : "Enter patient’s age…", inputMode: "numeric" },
    book_city: { mode: "text", field: "city", placeholder: urdu ? "شہر کا نام لکھیں…" : "Enter city…", autoComplete: "address-level2" },
    book_reason: { mode: "text", field: "reasonForVisit", placeholder: urdu ? "مشاورت کی وجہ لکھیں…" : "Describe the concern…" },
    check_id: { mode: "text", field: "appointmentId", placeholder: urdu ? "اپائنٹمنٹ آئی ڈی لکھیں…" : "Enter appointment reference…" },
    check_phone: { mode: "text", field: "lookupPhone", placeholder: urdu ? "بکنگ کا فون نمبر لکھیں…" : "Enter booking phone number…", inputMode: "tel" },
    reschedule_id: { mode: "text", field: "appointmentId", placeholder: urdu ? "اپائنٹمنٹ آئی ڈی لکھیں…" : "Enter appointment reference…" },
    reschedule_phone: { mode: "text", field: "lookupPhone", placeholder: urdu ? "بکنگ کا فون نمبر لکھیں…" : "Enter booking phone number…", inputMode: "tel" },
    cancel_id: { mode: "text", field: "appointmentId", placeholder: urdu ? "اپائنٹمنٹ آئی ڈی لکھیں…" : "Enter appointment reference…" },
    cancel_phone: { mode: "text", field: "lookupPhone", placeholder: urdu ? "بکنگ کا فون نمبر لکھیں…" : "Enter booking phone number…", inputMode: "tel" },
    cancel_reason: { mode: "text", field: "cancellationReason", placeholder: urdu ? "منسوخی کی وجہ لکھیں…" : "Enter cancellation reason…" }
  };
  return fields[step] || { mode: "choice", placeholder: urdu ? "ایک آپشن منتخب کریں" : "Choose an option" };
}

function withSessionState(reply, session) {
  return {
    ...reply,
    nextStep: session.step,
    input: chatInputForStep(session.step, reply?.language || session.language)
  };
}

async function handleMenu(session, value) {
  const language = session.language;
  const intent = classifyIntent(value);

  if (intent === "book") {
    await saveSession(session, { step: "book_consent", draft: {} });
    return {
      text: bookingProgress(language, 1, consentMessage(language)),
      options: [
        option(language === "ur" ? "میں متفق ہوں" : "I Agree", ACTIONS.consentAccept),
        option(language === "ur" ? "میں متفق نہیں ہوں" : "I Do Not Agree", ACTIONS.consentDecline)
      ],
      language
    };
  }
  if (intent === "check") {
    await saveSession(session, { step: "check_id", draft: {} });
    return { text: ask(language, "Please enter your appointment ID.", "براہِ کرم اپائنٹمنٹ آئی ڈی لکھیں۔"), language };
  }
  if (intent === "reschedule") {
    await saveSession(session, { step: "reschedule_id", draft: {} });
    return { text: ask(language, "Please enter your appointment ID.", "براہِ کرم اپائنٹمنٹ آئی ڈی لکھیں۔"), language };
  }
  if (intent === "cancel") {
    await saveSession(session, { step: "cancel_id", draft: {} });
    return { text: ask(language, "Please enter your appointment ID.", "براہِ کرم اپائنٹمنٹ آئی ڈی لکھیں۔"), language };
  }
  if (intent === "locations") {
    const [locations, schedules] = await Promise.all([listLocations({ activeOnly: true }), listSchedules()]);
    return staticReply(session, locationsMessage(locations, language, schedules));
  }
  if (intent === "profile") return staticReply(session, doctorProfileMessage(language, await getDoctorProfile()));
  if (intent === "reception") return staticReply(session, contactReceptionMessage(language, await getDoctorProfile()));
  if (intent === "emergency") return { ...(await staticReply(session, emergencyMessage(language))), emergency: true };
  if (intent === "language") {
    await saveSession(session, { step: "language", draft: {} });
    return { text: languagePrompt(), options: [option("English", ACTIONS.languageEnglish), option("اردو", ACTIONS.languageUrdu)], language };
  }

  return {
    text: `${ask(language, "Please choose one option so I can help you properly.", "براہِ کرم ایک آپشن منتخب کریں تاکہ میں آپ کی بہتر رہنمائی کر سکوں۔")}\n\n${mainMenu(language)}`,
    options: menuOptions(language),
    language
  };
}

async function handleBooking(session, value) {
  const language = session.language;
  const draft = session.draft || {};

  if (session.step === "book_consent") {
    if (!yes(value)) {
      if (no(value)) {
        await saveSession(session, {
          step: "menu",
          draft: { consentAccepted: false, consentRejectedAt: new Date() }
        });
        return {
          text: ask(
            language,
            "No problem.\n\nConsent is required before we can save appointment details.\n\nYou may return to the main menu or contact reception directly.",
            "کوئی مسئلہ نہیں۔\n\nاپائنٹمنٹ کی تفصیلات محفوظ کرنے سے پہلے رضامندی ضروری ہے۔\n\nآپ مین مینو پر واپس جا سکتے ہیں یا براہِ راست ریسپشن سے رابطہ کر سکتے ہیں۔"
          ),
          options: [
            option(language === "ur" ? "🏠 مین مینو پر واپس جائیں" : "🏠 Return to Main Menu", ACTIONS.mainMenu),
            option(language === "ur" ? "☎️ ریسپشن سے رابطہ" : "☎️ Contact Reception", ACTIONS.reception)
          ],
          language,
          consentRejected: true
        };
      }
      return {
        text: consentMessage(language),
        options: [option(language === "ur" ? "میں متفق ہوں" : "I Agree", ACTIONS.consentAccept), option(language === "ur" ? "میں متفق نہیں ہوں" : "I Do Not Agree", ACTIONS.consentDecline)],
        language
      };
    }
    await saveSession(session, {
      step: "book_name",
      draft: { consentAccepted: true, consentAcceptedAt: new Date() }
    });
    return { text: bookingProgress(language, 2, patientNamePrompt(language)), language };
  }
  if (session.step === "book_name") {
    if (String(value).length > 100) {
      return { text: ask(language, "⚠️ Please enter the patient’s complete name.\n\nExample: Ahmed Khan", "⚠️ براہِ کرم مریض کا مکمل نام لکھیں۔\n\nمثال: علی احمد"), language };
    }
    draft.fullName = compactText(value, 100);
    if (!isValidPatientName(draft.fullName)) {
      return { text: ask(language, "⚠️ Please enter the patient’s complete name.\n\nExample: Ahmed Khan", "⚠️ براہِ کرم مریض کا مکمل نام لکھیں۔\n\nمثال: علی احمد"), language };
    }
    await saveSession(session, { step: "book_phone", draft });
    return { text: bookingProgress(language, 2, patientPhonePrompt(language, draft.fullName)), language };
  }
  if (session.step === "book_phone") {
    try {
      draft.phone = phoneSchema.parse(value);
    } catch {
      return { text: ask(language, "Please enter a valid phone number with country or mobile code.", "براہِ کرم ملک یا موبائل کوڈ کے ساتھ درست فون نمبر لکھیں۔"), language };
    }
    await saveSession(session, { step: "book_age", draft });
    return { text: bookingProgress(language, 2, ask(language, "Please enter patient age.", "براہِ کرم مریض کی عمر لکھیں۔")), language };
  }
  if (session.step === "book_age") {
    const age = Number(value);
    if (!Number.isInteger(age) || age < 1 || age > 120) return { text: ask(language, "Please enter a valid age between 1 and 120.", "براہِ کرم 1 سے 120 کے درمیان درست عمر لکھیں۔"), language };
    draft.age = age;
    await saveSession(session, { step: "book_gender", draft });
    const guardianNotice = age < 18
      ? ask(language, "A parent or legal guardian should accompany a patient under 18.\n\n", "18 سال سے کم عمر مریض کے ساتھ والدین یا قانونی سرپرست کا ہونا ضروری ہے۔\n\n")
      : "";
    return {
      text: bookingProgress(language, 2, `${guardianNotice}${ask(language, "Please select gender.", "براہِ کرم جنس منتخب کریں۔")}`),
      options: [option("Male", ACTIONS.genderMale), option("Female", ACTIONS.genderFemale), option("Other", ACTIONS.genderOther)],
      language
    };
  }
  if (session.step === "book_gender") {
    const map = { 1: "Male", 2: "Female", 3: "Other", male: "Male", female: "Female", other: "Other" };
    const gender = map[value.toLowerCase().trim()];
    if (!gender) {
      return {
        text: ask(language, "Please select a gender option.", "براہِ کرم جنس کا آپشن منتخب کریں۔"),
        options: [option("Male", ACTIONS.genderMale), option("Female", ACTIONS.genderFemale), option("Other", ACTIONS.genderOther)],
        language
      };
    }
    draft.gender = gender;
    await saveSession(session, { step: "book_city", draft });
    return { text: bookingProgress(language, 2, ask(language, "Please enter city.", "براہِ کرم شہر کا نام لکھیں۔")), language };
  }
  if (session.step === "book_city") {
    draft.city = compactText(value, 80);
    if (draft.city.length < 2) return { text: ask(language, "Please enter city.", "براہِ کرم شہر کا نام لکھیں۔"), language };
    await saveSession(session, { step: "book_reason", draft });
    return { text: bookingProgress(language, 2, ask(language, "Please briefly describe the reason for visit.", "براہِ کرم وزٹ کی وجہ مختصر لکھیں۔")), language };
  }
  if (session.step === "book_reason") {
    draft.reasonForVisit = compactText(value, 500);
    draft.reason = draft.reasonForVisit;
    if (draft.reasonForVisit.length < 3) return { text: ask(language, "Please write a short reason for visit.", "براہِ کرم وزٹ کی مختصر وجہ لکھیں۔"), language };
    const locations = await locationOptions(language);
    if (!locations.locations.length) {
      await saveSession(session, { step: "menu", draft: {} });
      return { text: `${locations.text}\n\n${mainMenu(language)}`, options: menuOptions(language), language };
    }
    draft.locationOptions = locations.locations;
    await saveSession(session, { step: "book_location", draft });
    const recorded = ask(
      language,
      "✅ Reason Recorded\n\nThank you. Your reason for consultation has been recorded.\n\nPlease select an available appointment option below.",
      "✅ وجہ درج کر لی گئی ہے\n\nشکریہ۔ آپ کی مشاورت کی وجہ درج کر لی گئی ہے۔\n\nبراہِ کرم نیچے سے دستیاب اپائنٹمنٹ کا آپشن منتخب کریں۔"
    );
    return { text: bookingProgress(language, 3, `${recorded}\n\n${locations.text}`), options: locations.options, language };
  }
  if (session.step === "book_location") {
    const location = pickByNumberOrValue(value, draft.locationOptions || [], "locationId");
    if (!location) {
      const locations = await locationOptions(language);
      return { text: locations.text, options: locations.options, language };
    }
    draft.locationId = location.locationId;
    draft.locationNameEn = location.nameEn;
    draft.locationNameUr = location.nameUr;
    await saveSession(session, { step: "book_date", draft });
    const reply = await askDates(session, location.locationId, "book_date");
    return { ...reply, text: bookingProgress(language, 4, reply.text) };
  }
  if (session.step === "book_date") {
    const picked = pickByNumberOrValue(value, draft.dateOptions || [], "date");
    if (!picked) return askDates(session, draft.locationId, "book_date");
    draft.date = picked.date;
    await saveSession(session, { step: "book_time", draft });
    const reply = await askSlots(session, draft.locationId, draft.date, "book_time");
    return { ...reply, text: bookingProgress(language, 5, reply.text) };
  }
  if (session.step === "book_time") {
    if (value === "slots_more" || value === "slots_previous") {
      const page = Number(draft.slotPage || 0) + (value === "slots_more" ? 1 : -1);
      const reply = await askSlots(session, draft.locationId, draft.date, "book_time", page);
      return { ...reply, text: bookingProgress(language, 5, reply.text) };
    }
    const picked = pickByNumberOrValue(value, draft.slotOptions || [], "time");
    if (!picked) return askSlots(session, draft.locationId, draft.date, "book_time");
    draft.time = picked.time;
    draft.tokenNumber = picked.tokenNumber;
    await saveSession(session, { step: "book_confirm", draft });
    return {
      text: bookingProgress(language, 6, ask(
        language,
        `Please confirm appointment:\n\nPatient: ${draft.fullName}\nDoctor: ${DOCTOR.nameEn}\nHospital: ${draft.locationNameEn}\nDate: ${displayDate(draft.date, language)}\nTime: ${displayTime(draft.time, language)}\nToken: ${draft.tokenNumber}`,
        `براہِ کرم اپائنٹمنٹ کی تصدیق کریں:\n\nمریض: ${draft.fullName}\nڈاکٹر: ${DOCTOR.nameUr}\nہسپتال: ${draft.locationNameUr}\nتاریخ: ${displayDate(draft.date, language)}\nوقت: ${displayTime(draft.time, language)}\nٹوکن: ${draft.tokenNumber}`
      )),
      options: [option("Confirm", ACTIONS.confirmBooking), option("Cancel", ACTIONS.cancelBooking)],
      language
    };
  }
  if (session.step === "book_confirm") {
    if (!yes(value)) return resetToMenu(session, language);
    let appointment;
    try {
      appointment = await createAppointment(
        {
          fullName: draft.fullName,
          phone: draft.phone,
          age: draft.age,
          gender: draft.gender,
          city: draft.city,
          reasonForVisit: draft.reasonForVisit,
          locationId: draft.locationId,
          date: draft.date,
          time: draft.time,
          language,
          source: "WhatsApp",
          consentAccepted: true
        },
        { userId: "Patient", role: "Patient" }
      );
    } catch (error) {
      if (error.status !== 409 || error.patientSafe) throw error;
      const alternatives = await askSlots(session, draft.locationId, draft.date, "book_time");
      return {
        ...alternatives,
        text: `${ask(language, "That slot is no longer available. Please select another time.", "یہ وقت اب دستیاب نہیں ہے۔ براہِ کرم دوسرا وقت منتخب کریں۔")}\n\n${alternatives.text}`
      };
    }
    const publicAppointment = toPublicAppointment(appointment);
    await saveSession(session, { step: "menu", draft: {} });
    return { text: `${appointmentConfirmation(publicAppointment, language)}\n\n${mainMenu(language)}`, options: menuOptions(language), language, appointment: publicAppointment };
  }

  return resetToMenu(session, language);
}

async function verifyAppointment(session, id, phone) {
  const appointment = await lookupAppointmentSafe({ appointmentId: id, phone });
  if (!appointment) {
    const language = session.language;
    return {
      error: true,
      reply: {
        text: ask(language, "Appointment was not found. Please check both appointment ID and phone number.", "اپائنٹمنٹ نہیں ملی۔ براہِ کرم اپائنٹمنٹ آئی ڈی اور فون نمبر دونوں چیک کریں۔"),
        language
      }
    };
  }
  return { appointment };
}

async function handleCheck(session, value) {
  const language = session.language;
  const draft = session.draft || {};
  if (session.step === "check_id") {
    draft.appointmentId = compactText(value, 40);
    await saveSession(session, { step: "check_phone", draft });
    return { text: ask(language, "Please enter the phone number used for booking.", "براہِ کرم وہ فون نمبر لکھیں جس سے بکنگ کی گئی تھی۔"), language };
  }
  const verified = await verifyAppointment(session, draft.appointmentId, value);
  await saveSession(session, { step: "menu", draft: {} });
  if (verified.error) return { ...verified.reply, text: `${verified.reply.text}\n\n${mainMenu(language)}`, options: menuOptions(language) };
  return { text: `${appointmentLookupMessage(verified.appointment, language)}\n\n${mainMenu(language)}`, options: menuOptions(language), language };
}

async function handleReschedule(session, value) {
  const language = session.language;
  const draft = session.draft || {};
  if (session.step === "reschedule_id") {
    draft.appointmentId = compactText(value, 40);
    await saveSession(session, { step: "reschedule_phone", draft });
    return { text: ask(language, "Please enter the phone number used for booking.", "براہِ کرم وہ فون نمبر لکھیں جس سے بکنگ کی گئی تھی۔"), language };
  }
  if (session.step === "reschedule_phone") {
    const verified = await verifyAppointment(session, draft.appointmentId, value);
    if (verified.error) return verified.reply;
    const full = await getAppointmentById(verified.appointment.appointmentId);
    if (!["Booked", "Rescheduled"].includes(full.status)) {
      await saveSession(session, { step: "menu", draft: {} });
      return { text: `${ask(language, "This appointment is not active and cannot be rescheduled.", "یہ اپائنٹمنٹ فعال نہیں، اس لیے تبدیل نہیں ہو سکتی۔")}\n\n${mainMenu(language)}`, options: menuOptions(language), language };
    }
    draft.phone = phoneSchema.parse(value);
    draft.currentAppointment = full;
    const locations = await locationOptions(language);
    if (!locations.locations.length) {
      await saveSession(session, { step: "menu", draft: {} });
      return { text: `${locations.text}\n\n${mainMenu(language)}`, options: menuOptions(language), language };
    }
    draft.locationOptions = locations.locations;
    await saveSession(session, { step: "reschedule_location", draft });
    return { text: locations.text, options: locations.options, language };
  }
  if (session.step === "reschedule_location") {
    const location = pickByNumberOrValue(value, draft.locationOptions || [], "locationId");
    if (!location) {
      const locations = await locationOptions(language);
      return { text: locations.text, options: locations.options, language };
    }
    draft.locationId = location.locationId;
    draft.locationNameEn = location.nameEn;
    draft.locationNameUr = location.nameUr;
    await saveSession(session, { step: "reschedule_date", draft });
    return askDates(session, location.locationId, "reschedule_date");
  }
  if (session.step === "reschedule_date") {
    const picked = pickByNumberOrValue(value, draft.dateOptions || [], "date");
    if (!picked) return askDates(session, draft.locationId, "reschedule_date");
    draft.date = picked.date;
    await saveSession(session, { step: "reschedule_time", draft });
    return askSlots(session, draft.locationId, draft.date, "reschedule_time");
  }
  if (session.step === "reschedule_time") {
    if (value === "slots_more" || value === "slots_previous") {
      const page = Number(draft.slotPage || 0) + (value === "slots_more" ? 1 : -1);
      return askSlots(session, draft.locationId, draft.date, "reschedule_time", page);
    }
    const picked = pickByNumberOrValue(value, draft.slotOptions || [], "time");
    if (!picked) return askSlots(session, draft.locationId, draft.date, "reschedule_time");
    draft.time = picked.time;
    await saveSession(session, { step: "reschedule_confirm", draft });
    return {
      text: ask(
        language,
        `Confirm new appointment time?\n\nLocation: ${draft.locationNameEn}\nDate: ${displayDate(draft.date, language)}\nTime: ${displayTime(draft.time, language)}`,
        `کیا نیا وقت کنفرم ہے؟\n\nلوکیشن: ${draft.locationNameUr}\nتاریخ: ${displayDate(draft.date, language)}\nوقت: ${displayTime(draft.time, language)}`
      ),
      options: [option("Confirm", ACTIONS.confirmReschedule), option("Cancel", ACTIONS.cancelReschedule)],
      language
    };
  }
  if (session.step === "reschedule_confirm") {
    if (!yes(value)) return resetToMenu(session, language);
    let appointment;
    try {
      appointment = await rescheduleAppointment(
        {
          appointmentId: draft.appointmentId,
          phone: draft.phone,
          locationId: draft.locationId,
          date: draft.date,
          time: draft.time,
          language
        },
        { userId: "Patient", role: "Patient" }
      );
    } catch (error) {
      if (error.status !== 409 || error.patientSafe) throw error;
      const alternatives = await askSlots(session, draft.locationId, draft.date, "reschedule_time");
      return {
        ...alternatives,
        text: `${ask(language, "That slot is no longer available. Your original appointment is unchanged. Please select another time.", "یہ وقت اب دستیاب نہیں ہے۔ آپ کی اصل اپائنٹمنٹ برقرار ہے۔ براہِ کرم دوسرا وقت منتخب کریں۔")}\n\n${alternatives.text}`
      };
    }
    const publicAppointment = toPublicAppointment(appointment);
    await saveSession(session, { step: "menu", draft: {} });
    return { text: `${rescheduleConfirmation(publicAppointment, language)}\n\n${mainMenu(language)}`, options: menuOptions(language), language, appointment: publicAppointment };
  }
  return resetToMenu(session, language);
}

async function handleCancel(session, value) {
  const language = session.language;
  const draft = session.draft || {};
  if (session.step === "cancel_id") {
    draft.appointmentId = compactText(value, 40);
    await saveSession(session, { step: "cancel_phone", draft });
    return { text: ask(language, "Please enter the phone number used for booking.", "براہِ کرم وہ فون نمبر لکھیں جس سے بکنگ کی گئی تھی۔"), language };
  }
  if (session.step === "cancel_phone") {
    const verified = await verifyAppointment(session, draft.appointmentId, value);
    if (verified.error) return verified.reply;
    draft.phone = phoneSchema.parse(value);
    await saveSession(session, { step: "cancel_reason", draft });
    return { text: ask(language, "Please write a short cancellation reason.", "براہِ کرم منسوخی کی مختصر وجہ لکھیں۔"), language };
  }
  if (session.step === "cancel_reason") {
    draft.reason = compactText(value, 250);
    if (draft.reason.length < 2) return { text: ask(language, "Please write a cancellation reason.", "براہِ کرم منسوخی کی وجہ لکھیں۔"), language };
    await saveSession(session, { step: "cancel_confirm", draft });
    return {
      text: ask(language, "Are you sure you want to cancel this appointment?", "کیا آپ واقعی یہ اپائنٹمنٹ منسوخ کرنا چاہتے ہیں؟"),
      options: [option("Yes, cancel", ACTIONS.confirmCancellation), option("Keep appointment", ACTIONS.keepAppointment)],
      language
    };
  }
  if (session.step === "cancel_confirm") {
    if (!yes(value)) return resetToMenu(session, language);
    const appointment = await cancelAppointment(
      {
        appointmentId: draft.appointmentId,
        phone: draft.phone,
        reason: draft.reason,
        language
      },
      { userId: "Patient", role: "Patient" }
    );
    const publicAppointment = toPublicAppointment(appointment);
    await saveSession(session, { step: "menu", draft: {} });
    return { text: `${cancellationConfirmation(publicAppointment, language)}\n\n${mainMenu(language)}`, options: menuOptions(language), language, appointment: publicAppointment };
  }
  return resetToMenu(session, language);
}

function addNavigation(reply, session) {
  if (!reply || ["menu", "language"].includes(session.step)) return reply;
  const existing = Array.isArray(reply.options) ? reply.options : [];
  const navigation = navigationOptions(session.language, { includeBack: session.step !== "book_consent" });
  const seen = new Set(existing.map((item) => item.value));
  return {
    ...reply,
    options: [...existing, ...navigation.filter((item) => !seen.has(item.value))].slice(0, 10)
  };
}

async function handleBack(session) {
  const language = session.language;
  const draft = session.draft || {};
  const prompt = (step, text, options) => saveSession(session, { step, draft }).then(() => ({ text, options, language }));

  switch (session.step) {
    case "book_consent":
    case "check_id":
    case "reschedule_id":
    case "cancel_id":
      return resetToMenu(session, language);
    case "book_name":
      return prompt("book_consent", bookingProgress(language, 1, consentMessage(language)), [
        option(language === "ur" ? "میں متفق ہوں" : "I Agree", ACTIONS.consentAccept),
        option(language === "ur" ? "میں متفق نہیں ہوں" : "I Do Not Agree", ACTIONS.consentDecline)
      ]);
    case "book_phone":
      return prompt("book_name", bookingProgress(language, 2, patientNamePrompt(language)));
    case "book_age":
      return prompt("book_phone", bookingProgress(language, 2, patientPhonePrompt(language)));
    case "book_gender":
      return prompt("book_age", bookingProgress(language, 2, ask(language, "Please enter patient age.", "براہِ کرم مریض کی عمر لکھیں۔")));
    case "book_city":
      return prompt(
        "book_gender",
        bookingProgress(language, 2, ask(language, "Please select gender.", "براہِ کرم جنس منتخب کریں۔")),
        [option("Male", ACTIONS.genderMale), option("Female", ACTIONS.genderFemale), option("Other", ACTIONS.genderOther)]
      );
    case "book_reason":
      return prompt("book_city", bookingProgress(language, 2, ask(language, "Please enter city.", "براہِ کرم شہر کا نام لکھیں۔")));
    case "book_location":
      return prompt("book_reason", bookingProgress(language, 2, ask(language, "Please briefly describe the reason for visit.", "براہِ کرم وزٹ کی وجہ مختصر لکھیں۔")));
    case "book_date": {
      const locations = await locationOptions(language);
      draft.locationOptions = locations.locations;
      return prompt("book_location", bookingProgress(language, 3, locations.text), locations.options);
    }
    case "book_time": {
      const reply = await askDates(session, draft.locationId, "book_date");
      return { ...reply, text: bookingProgress(language, 4, reply.text) };
    }
    case "book_confirm": {
      const reply = await askSlots(session, draft.locationId, draft.date, "book_time", draft.slotPage || 0);
      return { ...reply, text: bookingProgress(language, 5, reply.text) };
    }
    case "check_phone":
      return prompt("check_id", ask(language, "Please enter your appointment ID.", "براہِ کرم اپائنٹمنٹ آئی ڈی لکھیں۔"));
    case "reschedule_phone":
      return prompt("reschedule_id", ask(language, "Please enter your appointment ID.", "براہِ کرم اپائنٹمنٹ آئی ڈی لکھیں۔"));
    case "reschedule_location":
      return prompt("reschedule_phone", ask(language, "Please enter the phone number used for booking.", "براہِ کرم بکنگ کے لیے استعمال کیا گیا فون نمبر لکھیں۔"));
    case "reschedule_date": {
      const locations = await locationOptions(language);
      draft.locationOptions = locations.locations;
      return prompt("reschedule_location", locations.text, locations.options);
    }
    case "reschedule_time":
      return askDates(session, draft.locationId, "reschedule_date");
    case "reschedule_confirm":
      return askSlots(session, draft.locationId, draft.date, "reschedule_time", draft.slotPage || 0);
    case "cancel_phone":
      return prompt("cancel_id", ask(language, "Please enter your appointment ID.", "براہِ کرم اپائنٹمنٹ آئی ڈی لکھیں۔"));
    case "cancel_reason":
      return prompt("cancel_phone", ask(language, "Please enter the phone number used for booking.", "براہِ کرم بکنگ کے لیے استعمال کیا گیا فون نمبر لکھیں۔"));
    case "cancel_confirm":
      return prompt("cancel_reason", ask(language, "Please write a short cancellation reason.", "براہِ کرم منسوخی کی مختصر وجہ لکھیں۔"));
    default:
      return resetToMenu(session, language);
  }
}

async function currentSessionReply(session) {
  const language = session.language || "en";
  const draft = session.draft || {};
  switch (session.step) {
    case "language":
      return { text: languagePrompt(), options: [option("English", ACTIONS.languageEnglish), option("اردو", ACTIONS.languageUrdu)], language };
    case "menu":
      return { text: mainMenu(language), options: menuOptions(language), language };
    case "book_consent":
      return {
        text: bookingProgress(language, 1, consentMessage(language)),
        options: [
          option(language === "ur" ? "میں متفق ہوں" : "I Agree", ACTIONS.consentAccept),
          option(language === "ur" ? "میں متفق نہیں ہوں" : "I Do Not Agree", ACTIONS.consentDecline)
        ],
        language
      };
    case "book_name":
      return { text: bookingProgress(language, 2, patientNamePrompt(language)), language };
    case "book_phone":
      return { text: bookingProgress(language, 2, patientPhonePrompt(language)), language };
    case "book_age":
      return { text: bookingProgress(language, 2, ask(language, "Please enter patient age.", "براہِ کرم مریض کی عمر لکھیں۔")), language };
    case "book_gender":
      return {
        text: bookingProgress(language, 2, ask(language, "Please select gender.", "براہِ کرم جنس منتخب کریں۔")),
        options: [option("Male", ACTIONS.genderMale), option("Female", ACTIONS.genderFemale), option("Other", ACTIONS.genderOther)],
        language
      };
    case "book_city":
      return { text: bookingProgress(language, 2, ask(language, "Please enter city.", "براہِ کرم شہر کا نام لکھیں۔")), language };
    case "book_reason":
      return { text: bookingProgress(language, 2, ask(language, "Please briefly describe the reason for visit.", "براہِ کرم وزٹ کی وجہ مختصر لکھیں۔")), language };
    case "book_location": {
      const locations = await locationOptions(language);
      return { text: bookingProgress(language, 3, locations.text), options: locations.options, language };
    }
    case "book_date": {
      const reply = await askDates(session, draft.locationId, "book_date");
      return { ...reply, text: bookingProgress(language, 4, reply.text) };
    }
    case "book_time": {
      const reply = await askSlots(session, draft.locationId, draft.date, "book_time", draft.slotPage || 0);
      return { ...reply, text: bookingProgress(language, 5, reply.text) };
    }
    case "book_confirm":
      return {
        text: bookingProgress(language, 6, ask(
          language,
          `Please confirm appointment:\n\nPatient: ${draft.fullName}\nDoctor: ${DOCTOR.nameEn}\nHospital: ${draft.locationNameEn}\nDate: ${displayDate(draft.date, language)}\nTime: ${displayTime(draft.time, language)}\nToken: ${draft.tokenNumber}`,
          `براہِ کرم اپائنٹمنٹ کی تصدیق کریں:\n\nمریض: ${draft.fullName}\nڈاکٹر: ${DOCTOR.nameUr}\nہسپتال: ${draft.locationNameUr}\nتاریخ: ${displayDate(draft.date, language)}\nوقت: ${displayTime(draft.time, language)}\nٹوکن: ${draft.tokenNumber}`
        )),
        options: [option("Confirm", ACTIONS.confirmBooking), option("Cancel", ACTIONS.cancelBooking)],
        language
      };
    case "check_id":
    case "reschedule_id":
    case "cancel_id":
      return { text: ask(language, "Please enter your appointment ID.", "براہِ کرم اپائنٹمنٹ آئی ڈی لکھیں۔"), language };
    case "check_phone":
    case "reschedule_phone":
    case "cancel_phone":
      return { text: ask(language, "Please enter the phone number used for booking.", "براہِ کرم بکنگ کے لیے استعمال کیا گیا فون نمبر لکھیں۔"), language };
    case "cancel_reason":
      return { text: ask(language, "Please write a short cancellation reason.", "براہِ کرم منسوخی کی مختصر وجہ لکھیں۔"), language };
    default:
      return { text: mainMenu(language), options: menuOptions(language), language };
  }
}

async function transitionChatMessage(parsed, context, session) {
  const incoming = parsed.actionId || parsed.message;
  const hintedLanguage = parsed.language || (detectUrdu(incoming) ? "ur" : "en");
  const value = normalizeChatAction(compactText(incoming, 1000));

  if (value === "back" && session.step !== "language" && session.step !== "menu") {
    return withSessionState(addNavigation(await handleBack(session), session), session);
  }

  if (session.step !== "language" && classifyEmergencyReason(value).isEmergency) {
    await saveSession(session, { step: "menu", draft: {} });
    return withSessionState({ text: `${emergencyMessage(session.language)}\n\n${mainMenu(session.language)}`, options: menuOptions(session.language), language: session.language, emergency: true }, session);
  }

  let reply;
  if (/^(hi|hello|start|menu|0|السلام|سلام)$/i.test(value)) {
    await saveSession(session, { step: session.step === "language" ? "language" : "menu", language: session.language || hintedLanguage, draft: {} });
    if (session.step === "language") reply = { text: languagePrompt(), options: [option("English", ACTIONS.languageEnglish), option("اردو", ACTIONS.languageUrdu)], language: session.language };
    else reply = await resetToMenu(session, session.language);
  } else if (session.step === "language") {
    const language = value.trim() === "2" || /urdu|اردو/i.test(value) ? "ur" : value.trim() === "1" || /english/i.test(value) ? "en" : null;
    if (!language) reply = { text: languagePrompt(), options: [option("English", ACTIONS.languageEnglish), option("اردو", ACTIONS.languageUrdu)], language: hintedLanguage };
    else reply = await resetToMenu(session, language);
  } else {
    try {
      if (session.step.startsWith("book_")) {
        reply = await handleBooking(session, value);
      } else if (session.step.startsWith("check_")) {
        reply = await handleCheck(session, value);
      } else if (session.step.startsWith("reschedule_")) {
        reply = await handleReschedule(session, value);
      } else if (session.step.startsWith("cancel_")) {
        reply = await handleCancel(session, value);
      } else {
        reply = await handleMenu(session, value);
      }
    } catch (error) {
      console.error("Chatbot state transition failed", { step: session.step, error: error.message });
      await saveSession(session, { step: "menu", draft: {} });
      const patientText = error.patientSafe ? error.message : ask(session.language, "Something went wrong. Please try again.", "کچھ غلط ہو گیا۔ براہِ کرم دوبارہ کوشش کریں۔");
      reply = {
        text: `${patientText}\n\n${mainMenu(session.language)}`,
        options: menuOptions(session.language),
        language: session.language,
        error: context.includeErrors ? error.message : undefined
      };
    }
  }

  return withSessionState(addNavigation(reply, session), session);
}

const interactionLocks = new Map();

async function handleChatMessageUnlocked(input, context = {}) {
  const parsed = chatMessageSchema.parse(input);
  const normalizedPhone = normalizePhone(parsed.phone);
  const hintedLanguage = parsed.language || (detectUrdu(parsed.actionId || parsed.message) ? "ur" : "en");
  const session = await getSession(normalizedPhone, hintedLanguage);

  if (!parsed.interactionId) return transitionChatMessage(parsed, context, session);

  const completed = (session.processedInteractions || []).find((item) => item.interactionId === parsed.interactionId);
  if (completed?.reply) return completed.reply;

  const lockKey = `${normalizedPhone}:${parsed.interactionId}`;
  if (interactionLocks.has(lockKey)) return interactionLocks.get(lockKey);

  const processing = (async () => {
    const reply = await transitionChatMessage(parsed, context, session);
    const previous = (session.processedInteractions || []).map((item) => item.toObject?.() || item);
    const processedInteractions = [
      ...previous.filter((item) => item.interactionId !== parsed.interactionId),
      {
        interactionId: parsed.interactionId,
        actionId: parsed.actionId || "",
        reply,
        processedAt: new Date()
      }
    ].slice(-30);
    await saveSession(session, { processedInteractions });
    return reply;
  })();

  interactionLocks.set(lockKey, processing);
  try {
    return await processing;
  } finally {
    interactionLocks.delete(lockKey);
  }
}

export async function handleChatMessage(input, context = {}) {
  const normalizedPhone = phoneSchema.parse(input?.phone);
  return withConversationLock(normalizedPhone, () => handleChatMessageUnlocked(input, context));
}

export async function resumeChatSession(input = {}) {
  const normalizedPhone = phoneSchema.parse(input.phone);
  const session = await models.ChatSession.findOne({ normalizedPhone });
  if (!session) return null;
  const reply = await currentSessionReply(session);
  return withSessionState(addNavigation(reply, session), session);
}
