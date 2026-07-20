import net from "node:net";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";

const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const SUCCESS_WINDOW_MS = 24 * 60 * 60 * 1000;

export function normalizedLoginEmail(req) {
  return String(req.body?.email || "").trim().toLowerCase();
}

export function safeClientIpKey(req) {
  const candidate = net.isIP(req.ip) ? req.ip : req.socket?.remoteAddress;
  return net.isIP(candidate) ? ipKeyGenerator(candidate) : "invalid-client-ip";
}

function failedLoginHandler(req, res) {
  const resetAt = req.rateLimit?.resetTime?.getTime?.() || Date.now() + FAILURE_WINDOW_MS;
  const minutes = Math.max(1, Math.ceil((resetAt - Date.now()) / 60000));
  res.status(429).json({
    message: `Too many unsuccessful sign-in attempts. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`
  });
}

export function createLoginLimiters() {
  const accountFailures = rateLimit({
    windowMs: FAILURE_WINDOW_MS,
    limit: 10,
    keyGenerator: (req) => `account:${normalizedLoginEmail(req) || "invalid"}`,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    handler: failedLoginHandler
  });

  const ipFailures = rateLimit({
    windowMs: FAILURE_WINDOW_MS,
    limit: 30,
    keyGenerator: safeClientIpKey,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    handler: failedLoginHandler
  });

  const accountSuccesses = rateLimit({
    windowMs: SUCCESS_WINDOW_MS,
    limit: 500,
    keyGenerator: (req) => `account:${normalizedLoginEmail(req) || "invalid"}`,
    skipFailedRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "The daily sign-in allowance has been reached. Please try again later." }
  });

  return { accountFailures, ipFailures, accountSuccesses };
}

const loginRateLimits = createLoginLimiters();

export const loginLimiters = [
  loginRateLimits.accountFailures,
  loginRateLimits.ipFailures,
  loginRateLimits.accountSuccesses
];

export const bootstrapLimiter = rateLimit({
  windowMs: FAILURE_WINDOW_MS,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});

export function resetAccountFailureLimit(req, res) {
  const key = `account:${normalizedLoginEmail(req) || "invalid"}`;
  res.once("finish", () => loginRateLimits.accountFailures.resetKey(key));
}
