import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localeDir = path.resolve(__dirname, "../../locales");

const dictionaries = {
  en: JSON.parse(fs.readFileSync(path.join(localeDir, "en.json"), "utf8")),
  ur: JSON.parse(fs.readFileSync(path.join(localeDir, "ur.json"), "utf8"))
};

export const supportedLanguages = Object.keys(dictionaries);

export function normalizeLanguage(language) {
  return supportedLanguages.includes(language) ? language : "en";
}

function valueAt(object, key) {
  return String(key)
    .split(".")
    .reduce((current, part) => (current && current[part] !== undefined ? current[part] : undefined), object);
}

export function t(language, key, params = {}) {
  const normalized = normalizeLanguage(language);
  const fallback = valueAt(dictionaries.en, key);
  const template = valueAt(dictionaries[normalized], key) ?? fallback ?? key;
  if (typeof template !== "string") return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(params[name] ?? ""));
}

export function languageFromRequest(req) {
  return normalizeLanguage(req.query?.lang || req.body?.language || req.headers["x-clinic-language"] || req.user?.language || "en");
}

export function languageMiddleware(req, _res, next) {
  req.language = languageFromRequest(req);
  next();
}
