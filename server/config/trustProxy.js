export function parseTrustProxy(rawValue = "1") {
  const value = String(rawValue ?? "").trim();
  if (!value || value === "0" || value.toLowerCase() === "false") return false;
  if (/^[1-9]\d*$/.test(value)) return Number(value);

  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!entries.length || entries.some((entry) => ["true", "*"].includes(entry.toLowerCase()))) {
    throw new Error("TRUST_PROXY must be a proxy hop count or a comma-separated list of trusted addresses/subnets.");
  }
  return entries;
}
