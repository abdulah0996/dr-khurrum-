import crypto from "node:crypto";

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function sanitizeValue(value) {
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !BLOCKED_KEYS.has(key))
        .map(([key, item]) => {
          const safeKey = key.startsWith("$") ? key.slice(1) : key.replaceAll(".", "_");
          return [safeKey, sanitizeValue(item)];
        })
    );
  }
  if (typeof value === "string") {
    return value.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "").trim();
  }
  return value;
}

export function sanitizeInput(req, _res, next) {
  if (req.path === "/api/whatsapp/webhook" || req.path === "/api/whatsapp/webhook/") {
    return next();
  }
  if (req.body && typeof req.body === "object") req.body = sanitizeValue(req.body);
  if (req.query && typeof req.query === "object") {
    const clean = sanitizeValue(req.query);
    Object.keys(req.query).forEach((key) => delete req.query[key]);
    Object.assign(req.query, clean);
  }
  if (req.params && typeof req.params === "object") {
    const clean = sanitizeValue(req.params);
    Object.keys(req.params).forEach((key) => delete req.params[key]);
    Object.assign(req.params, clean);
  }
  next();
}

export function rejectParameterPollution(req, res, next) {
  if (req.path === "/api/whatsapp/webhook" || req.path === "/api/whatsapp/webhook/") {
    return next();
  }
  const polluted = Object.values(req.query || {}).some((value) => Array.isArray(value));
  if (polluted) return res.status(400).json({ message: "Repeated query parameters are not allowed." });
  return next();
}

export function requestId(req, res, next) {
  const incoming = req.headers["x-request-id"];
  const requestIdValue = typeof incoming === "string" && incoming.trim() ? incoming.trim().slice(0, 80) : crypto.randomUUID();
  req.id = requestIdValue;
  res.setHeader("X-Request-ID", requestIdValue);
  return next();
}

export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  if (process.env.NODE_ENV === "production" && req.headers["x-forwarded-proto"] && req.headers["x-forwarded-proto"] !== "https") {
    return res.status(403).json({ message: "HTTPS is required in production." });
  }
  return next();
}
