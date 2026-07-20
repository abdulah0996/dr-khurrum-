import crypto from "node:crypto";
import mongoose from "mongoose";
import { models } from "../models/index.js";
import { makePublicId } from "../utils/time.js";
import { publicUser, signAccessToken } from "../middleware/auth.js";

export const REFRESH_COOKIE = "khurrum_refresh";
const DEFAULT_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export function refreshLifetimeMs(value = process.env.JWT_REFRESH_EXPIRES_IN) {
  if (value === undefined || value === null || String(value).trim() === "") return DEFAULT_REFRESH_MS;
  const match = String(value).trim().toLowerCase().match(/^(\d+)([smhd])$/);
  if (!match) throw new Error("JWT_REFRESH_EXPIRES_IN must use a duration such as 30m, 12h, or 7d.");
  const amount = Number(match[1]);
  const multiplier = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  const duration = amount * multiplier;
  if (!Number.isSafeInteger(duration) || duration < 60_000 || duration > 90 * 86_400_000) {
    throw new Error("JWT_REFRESH_EXPIRES_IN must be between 1 minute and 90 days.");
  }
  return duration;
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function signCookieToken(token) {
  const signature = crypto.createHmac("sha256", process.env.COOKIE_SECRET).update(token).digest("base64url");
  return `${token}.${signature}`;
}

function verifyCookieToken(value) {
  const separator = value.lastIndexOf(".");
  if (separator < 1) return "";
  const token = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expected = crypto.createHmac("sha256", process.env.COOKIE_SECRET).update(token).digest();
  let supplied;
  try {
    supplied = Buffer.from(signature, "base64url");
  } catch {
    return "";
  }
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected) ? token : "";
}

function cookieValue(req) {
  const cookies = String(req.headers.cookie || "").split(";");
  for (const cookie of cookies) {
    const [name, ...parts] = cookie.trim().split("=");
    if (name === REFRESH_COOKIE) return verifyCookieToken(decodeURIComponent(parts.join("=")));
  }
  return "";
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api/auth",
    maxAge: refreshLifetimeMs()
  };
}

function rawRefreshToken() {
  return crypto.randomBytes(48).toString("base64url");
}

function sessionDocument(user, rawToken, familyId = makePublicId("FAM")) {
  return {
    authSessionId: makePublicId("SES"),
    userId: user.userId,
    familyId,
    tokenHash: hashToken(rawToken),
    tokenVersion: Number(user.tokenVersion || 0),
    expiresAt: new Date(Date.now() + refreshLifetimeMs())
  };
}

export async function issueAuthSession(user, res) {
  if (models.AuthSession.db.readyState !== 1) return { token: signAccessToken(user), user: publicUser(user) };
  const rawToken = rawRefreshToken();
  await models.AuthSession.create(sessionDocument(user, rawToken));
  res.cookie(REFRESH_COOKIE, signCookieToken(rawToken), cookieOptions());
  return { token: signAccessToken(user), user: publicUser(user) };
}

export async function rotateAuthSession(req, res) {
  const rawToken = cookieValue(req);
  if (!rawToken) return null;
  const tokenHash = hashToken(rawToken);
  const existing = await models.AuthSession.findOne({ tokenHash }).lean();
  if (!existing) return null;
  if (existing.revokedAt) {
    await models.AuthSession.updateMany(
      { familyId: existing.familyId, revokedAt: null },
      { $set: { revokedAt: new Date(), revokeReason: "refresh_token_reuse" } }
    );
    return null;
  }
  if (existing.expiresAt <= new Date()) return null;
  const user = await models.User.findOne({ userId: existing.userId, status: "Active" });
  if (!user || Number(user.tokenVersion || 0) !== Number(existing.tokenVersion || 0)) return null;

  const replacement = rawRefreshToken();
  const replacementDocument = sessionDocument(user, replacement, existing.familyId);
  const session = await mongoose.startSession();
  let reuseDetected = false;
  try {
    await session.withTransaction(async () => {
      const revoked = await models.AuthSession.findOneAndUpdate(
        { tokenHash, revokedAt: null },
        { $set: { revokedAt: new Date(), revokeReason: "rotated", replacedByHash: replacementDocument.tokenHash, lastUsedAt: new Date() } },
        { returnDocument: "after", session }
      );
      if (!revoked) {
        reuseDetected = true;
        const error = new Error("Refresh token reuse detected.");
        error.status = 401;
        throw error;
      }
      await models.AuthSession.create([replacementDocument], { session });
    });
  } catch (error) {
    if (reuseDetected) {
      await models.AuthSession.updateMany(
        { familyId: existing.familyId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokeReason: "refresh_token_reuse" } }
      );
    }
    throw error;
  } finally {
    await session.endSession();
  }
  res.cookie(REFRESH_COOKIE, signCookieToken(replacement), cookieOptions());
  return { token: signAccessToken(user), user: publicUser(user) };
}

export async function revokeAuthSession(req, res, reason = "logout") {
  const rawToken = cookieValue(req);
  if (rawToken) {
    await models.AuthSession.updateOne(
      { tokenHash: hashToken(rawToken), revokedAt: null },
      { $set: { revokedAt: new Date(), revokeReason: reason } }
    );
  }
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
}

export async function revokeUserSessions(userId, reason = "account_changed") {
  return models.AuthSession.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokeReason: reason } }
  );
}
