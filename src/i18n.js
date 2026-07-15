import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../locales/en.json";
import ur from "../locales/ur.json";

export const supportedLanguages = [
  { code: "en", label: "English", dir: "ltr" },
  { code: "ur", label: "اردو", dir: "rtl" }
];

export function normalizeLanguage(language) {
  return supportedLanguages.some((item) => item.code === language) ? language : "en";
}

export function isRtlLanguage(language) {
  return supportedLanguages.find((item) => item.code === normalizeLanguage(language))?.dir === "rtl";
}

i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ur: { translation: ur }
  },
  lng: normalizeLanguage(localStorage.getItem("muj_chat_language") || "en"),
  fallbackLng: "en",
  interpolation: {
    escapeValue: false
  }
});

export default i18n;
