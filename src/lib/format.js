function currentLanguage() {
  if (typeof localStorage === "undefined") return "en";
  return localStorage.getItem("clinic_language") === "ur" ? "ur" : "en";
}

function dateLocale() {
  return currentLanguage() === "ur" ? "ur-PK" : "en-GB";
}

function timeLocale() {
  return currentLanguage() === "ur" ? "ur-PK" : "en-US";
}

export function displayDate(dateIso) {
  if (!dateIso) return "-";
  return new Intl.DateTimeFormat(dateLocale(), {
    day: "2-digit",
    month: "short",
    year: "numeric"
  }).format(new Date(`${dateIso}T00:00:00`));
}

export function displayLongDate(dateIso) {
  if (!dateIso) return "-";
  return new Intl.DateTimeFormat(dateLocale(), {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  }).format(new Date(`${dateIso}T00:00:00`));
}

export function displayTime(time) {
  if (!time) return "-";
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return new Intl.DateTimeFormat(timeLocale(), {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

export function statusClass(status) {
  return String(status || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function initials(name) {
  return String(name || "CK")
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
