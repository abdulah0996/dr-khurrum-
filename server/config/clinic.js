export const TIMEZONE = process.env.DEFAULT_TIMEZONE || "Asia/Karachi";
export const LEGACY_RECEPTION_PHONE = "+92 335 7504478";
export const VERIFIED_RECEPTION_PHONE = "+92 324 4754566";

export const VERIFIED_GENERAL_SCHEDULE = {
  workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  openingTime: "09:00",
  closingTime: "14:00",
  breakStart: "",
  breakEnd: "",
  breakReasonEn: "",
  breakReasonUr: "",
  slotDurationMinutes: 10,
  dailyLimit: 30,
  timezone: "Asia/Karachi",
  active: true
};

export const DOCTOR = {
  nameEn: "Dr. Khurrum Mansoor",
  nameUr: "ڈاکٹر خرم منصور",
  // FCPS remains withheld until the clinic verifies the original FCOS/FCPS note
  // against an official qualification document.
  qualificationsEn: "MBBS",
  qualificationsUr: "ایم بی بی ایس",
  qualificationsShort: "MBBS",
  pendingQualifications: ["FCPS"],
  specialtyEn: "Consultant Gynecologist",
  specialtyUr: "ماہرِ امراضِ نسواں",
  biographyEn:
    "Dr. Khurrum Mansoor is a Consultant Gynecologist with an MBBS qualification. He provides professional consultation and care for women’s health, pregnancy-related concerns, reproductive health, menstrual problems and other gynecological conditions.\n\nThe chatbot helps patients book, check, reschedule and cancel appointments. It does not provide a medical diagnosis, prescribe medicine or replace an examination by a qualified doctor.",
  biographyUr:
    "ڈاکٹر خرم منصور ایم بی بی ایس کی قابلیت رکھنے والے ماہرِ امراضِ نسواں ہیں۔ وہ خواتین کی صحت، حمل سے متعلق مسائل، تولیدی صحت، ماہواری کی بے قاعدگیوں اور دیگر نسوانی مسائل کے لیے پیشہ ورانہ مشاورت فراہم کرتے ہیں۔\n\nیہ چیٹ بوٹ مریضوں کو اپائنٹمنٹ بک کرنے، چیک کرنے، تبدیل کرنے یا منسوخ کرنے میں مدد دیتا ہے۔ یہ چیٹ بوٹ بیماری کی تشخیص، دوا تجویز کرنے یا ڈاکٹر کے طبی معائنے کی جگہ لینے کے لیے نہیں ہے۔",
  contact: VERIFIED_RECEPTION_PHONE
};

export const VERIFIED_CLINIC = {
  slug: "nighat-medical-complex-jhang",
  nameEn: "Nighat Medical Complex",
  nameUr: "نگہت میڈیکل کمپلیکس",
  addressEn: "Gojra Road, near Post Office, Jhang Sadar, Samanabad, Jhang, 33200, Pakistan",
  addressUr: "گوجرہ روڈ، نزد پوسٹ آفس، جھنگ صدر، سمن آباد، جھنگ، 33200، پاکستان",
  city: "Jhang",
  country: "Pakistan",
  phone: VERIFIED_RECEPTION_PHONE,
  googleMapLink: "",
  consultationMode: "Physical consultation",
  active: true,
  schedule: VERIFIED_GENERAL_SCHEDULE
};

// Production clinic creation is explicit through `npm run setup:clinic`.
export const DEFAULT_LOCATIONS = [];

export const APPOINTMENT_POLICIES = {
  advanceBookingDays: 30,
  sameDayCutoffMinutes: 30,
  cancellationCutoffMinutes: 120,
  rescheduleCutoffMinutes: 120,
  arrivalLeadMinutes: 10,
  lateGraceMinutes: 10,
  noShowAfterMinutes: Math.max(0, Math.min(Number(process.env.NO_SHOW_GRACE_MINUTES || 15), 240))
};

export const ACTIVE_APPOINTMENT_STATUSES = ["Booked", "Rescheduled"];
export const CLOSED_APPOINTMENT_STATUSES = ["Cancelled", "Visited", "No-Show"];
export const APPOINTMENT_STATUSES = [...ACTIVE_APPOINTMENT_STATUSES, ...CLOSED_APPOINTMENT_STATUSES];
export const STAFF_ROLES = ["Super Admin", "Receptionist"];

export const SYSTEM_COPY = {
  productName: "Dr. Khurrum Mansoor WhatsApp AI Appointment Chatbot",
  contact: DOCTOR.contact
};
