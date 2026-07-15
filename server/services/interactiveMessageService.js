import { compactText } from "../utils/time.js";

export const ACTIONS = Object.freeze({
  languageEnglish: "language_english",
  languageUrdu: "language_urdu",
  mainMenu: "main_menu",
  back: "navigation_back",
  slotsPrevious: "slots_previous",
  slotsMore: "slots_more",
  book: "menu_book_appointment",
  check: "menu_check_appointment",
  reschedule: "menu_reschedule_appointment",
  cancel: "menu_cancel_appointment",
  locations: "menu_clinic_information",
  profile: "menu_doctor_profile",
  reception: "menu_reception_contact",
  emergency: "menu_emergency_guidance",
  language: "menu_change_language",
  consentAccept: "consent_accept",
  consentDecline: "consent_reject",
  genderMale: "gender_male",
  genderFemale: "gender_female",
  genderOther: "gender_other",
  confirmBooking: "booking_confirm",
  cancelBooking: "booking_cancel",
  confirmReschedule: "reschedule_confirm",
  cancelReschedule: "reschedule_cancel",
  confirmCancellation: "cancellation_confirm",
  keepAppointment: "cancellation_keep"
});

const CANONICAL_ACTIONS = new Map([
  [ACTIONS.languageEnglish, "1"],
  [ACTIONS.languageUrdu, "2"],
  [ACTIONS.mainMenu, "menu"],
  [ACTIONS.back, "back"],
  [ACTIONS.slotsPrevious, "slots_previous"],
  [ACTIONS.slotsMore, "slots_more"],
  [ACTIONS.book, "1"],
  [ACTIONS.check, "2"],
  [ACTIONS.reschedule, "3"],
  [ACTIONS.cancel, "4"],
  [ACTIONS.locations, "5"],
  [ACTIONS.profile, "6"],
  [ACTIONS.reception, "7"],
  [ACTIONS.emergency, "8"],
  [ACTIONS.language, "9"],
  [ACTIONS.consentAccept, "yes"],
  [ACTIONS.consentDecline, "no"],
  ["consent_decline", "no"],
  [ACTIONS.genderMale, "male"],
  [ACTIONS.genderFemale, "female"],
  [ACTIONS.genderOther, "other"],
  [ACTIONS.confirmBooking, "yes"],
  [ACTIONS.cancelBooking, "no"],
  [ACTIONS.confirmReschedule, "yes"],
  [ACTIONS.cancelReschedule, "no"],
  [ACTIONS.confirmCancellation, "yes"],
  [ACTIONS.keepAppointment, "no"]
]);

export function locationAction(locationId) {
  return `clinic_${locationId}`;
}

export function dateAction(date) {
  return `date_${date}`;
}

export function timeAction(time, date = "") {
  return date ? `slot_${date}_${String(time).replace(":", "-")}` : `time:${time}`;
}

export function normalizeChatAction(value = "") {
  const action = compactText(value, 1000);
  if (CANONICAL_ACTIONS.has(action)) return CANONICAL_ACTIONS.get(action);
  if (action.startsWith("location:")) return action.slice("location:".length);
  if (action.startsWith("clinic_")) return action.slice("clinic_".length);
  if (action.startsWith("date:")) return action.slice("date:".length);
  if (/^date_\d{4}-\d{2}-\d{2}$/.test(action)) return action.slice("date_".length);
  if (action.startsWith("time:")) return action.slice("time:".length);
  const slot = action.match(/^slot_\d{4}-\d{2}-\d{2}_(\d{2})-(\d{2})$/);
  if (slot) return `${slot[1]}:${slot[2]}`;
  return action;
}

export function parseIncomingMessage(message = {}) {
  const buttonId = message.interactive?.button_reply?.id || message.button?.payload || "";
  const listId = message.interactive?.list_reply?.id || "";
  const actionId = compactText(buttonId || listId, 256);
  const title = compactText(
    message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || message.button?.text || "",
    256
  );
  const text = compactText(message.text?.body || actionId || title, 1000);
  return {
    type: actionId ? "interactive" : message.text?.body ? "text" : "unsupported",
    actionId,
    title,
    text
  };
}

function cleanOption(option, index) {
  return {
    id: compactText(option?.value || String(index + 1), 200),
    title: compactText(option?.label || String(index + 1), 24),
    description: compactText(option?.description || "", 72)
  };
}

export function buildInteractiveContent({ text, options = [], language = "en" }) {
  const rows = options.slice(0, 10).map(cleanOption).filter((row) => row.id && row.title);
  if (!rows.length) return null;

  if (rows.length <= 3 && rows.every((row) => row.title.length <= 20)) {
    return {
      type: "button",
      body: { text: compactText(text, 1024) },
      action: {
        buttons: rows.map((row) => ({ type: "reply", reply: { id: row.id, title: row.title } }))
      }
    };
  }

  return {
    type: "list",
    body: { text: compactText(text, 1024) },
    action: {
      button: language === "ur" ? "آپشن منتخب کریں" : "Choose an option",
      sections: [
        {
          title: language === "ur" ? "دستیاب آپشنز" : "Available options",
          rows: rows.map((row) => ({
            id: row.id,
            title: row.title,
            ...(row.description ? { description: row.description } : {})
          }))
        }
      ]
    }
  };
}

export function buildTextFallback(text, options = [], language = "en") {
  const choices = options.slice(0, 10).map((item, index) => `${index + 1}. ${compactText(item?.label || String(index + 1), 80)}`);
  if (!choices.length) return compactText(text, 4000);
  const instruction = language === "ur" ? "جواب میں آپشن کا نمبر لکھیں۔" : "Reply with the option number.";
  return compactText(`${text}\n\n${choices.join("\n")}\n\n${instruction}`, 4000);
}
