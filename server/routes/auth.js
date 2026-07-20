import bcrypt from "bcryptjs";
import { Router } from "express";
import mongoose from "mongoose";
import { models } from "../models/index.js";
import { authenticate } from "../middleware/auth.js";
import { bootstrapLimiter, loginLimiters, resetAccountFailureLimit } from "../middleware/loginRateLimit.js";
import { addAuditLog } from "../services/auditService.js";
import { bootstrapSchema, loginSchema } from "../utils/validation.js";
import { makePublicId } from "../utils/time.js";
import { acquireInvariantLock } from "../services/adminInvariantService.js";
import { issueAuthSession, revokeAuthSession, rotateAuthSession } from "../services/authSessionService.js";

const router = Router();
const LOCK_AFTER = 10;
const LOCK_MINUTES = 15;
const LOCK_WINDOW_MS = LOCK_MINUTES * 60 * 1000;

router.get("/bootstrap/status", async (_req, res, next) => {
  try {
    const adminCount = await models.User.countDocuments({ role: "Super Admin", status: "Active" });
    res.json({ setupRequired: adminCount === 0 });
  } catch (error) {
    next(error);
  }
});

router.post("/bootstrap", bootstrapLimiter, async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const parsed = bootstrapSchema.parse(req.body);
    if (parsed.token !== process.env.ADMIN_BOOTSTRAP_TOKEN) {
      return res.status(403).json({ message: "Invalid bootstrap token." });
    }

    const passwordHash = await bcrypt.hash(parsed.password, 12);
    let user;
    await session.withTransaction(async () => {
      await acquireInvariantLock("initial-super-admin-bootstrap", session);
      const adminCount = await models.User.countDocuments({ role: "Super Admin", status: "Active" }).session(session);
      if (adminCount > 0) {
        const error = new Error("Bootstrap is disabled after the first Super Admin is created.");
        error.status = 409;
        throw error;
      }
      [user] = await models.User.create([{
        userId: makePublicId("USR"),
        name: parsed.name,
        email: parsed.email,
        passwordHash,
        role: "Super Admin",
        status: "Active"
      }], { session });
    });

    await addAuditLog({ actor: user, action: "Staff user created", module: "Users", targetType: "User", targetId: user.userId, req });
    res.status(201).json(await issueAuthSession(user, res));
  } catch (error) {
    next(error);
  } finally {
    await session.endSession();
  }
});

router.post("/login", ...loginLimiters, async (req, res, next) => {
  try {
    const parsed = loginSchema.parse(req.body);
    const user = await models.User.findOne({ email: parsed.email });
    const locked = user?.lockUntil && user.lockUntil.getTime() > Date.now();

    if (!user || user.status !== "Active") {
      await addAuditLog({
        actor: user || null,
        action: "Admin login failure",
        module: "Auth",
        targetType: "User",
        targetId: user?.userId || parsed.email,
        metadata: { locked: false },
        req
      });
      return res.status(401).json({ message: "Email or password is incorrect." });
    }

    if (locked) {
      const retryAfterSeconds = Math.max(1, Math.ceil((user.lockUntil.getTime() - Date.now()) / 1000));
      const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      await addAuditLog({
        actor: user,
        action: "Admin login failure",
        module: "Auth",
        targetType: "User",
        targetId: user.userId,
        metadata: { locked: true },
        req
      });
      return res.status(429).json({
        message: `Too many unsuccessful sign-in attempts. Please wait ${minutes} minute${minutes === 1 ? "" : "s"} and try again.`
      });
    }

    if (!(await bcrypt.compare(parsed.password, user.passwordHash))) {
      const now = new Date();
      const windowStart = new Date(now.getTime() - LOCK_WINDOW_MS);
      await models.User.updateOne(
        { userId: user.userId },
        [{
          $set: {
            failedLoginAttempts: {
              $cond: [
                { $gte: [{ $ifNull: ["$lastFailedLoginAt", new Date(0)] }, windowStart] },
                { $add: [{ $ifNull: ["$failedLoginAttempts", 0] }, 1] },
                1
              ]
            },
            lastFailedLoginAt: now
          }
        }, {
          $set: {
            lockUntil: {
              $cond: [
                { $gte: ["$failedLoginAttempts", LOCK_AFTER] },
                new Date(now.getTime() + LOCK_WINDOW_MS),
                "$lockUntil"
              ]
            }
          }
        }]
      );
      await addAuditLog({
        actor: user,
        action: "Admin login failure",
        module: "Auth",
        targetType: "User",
        targetId: user.userId,
        metadata: { locked: false },
        req
      });
      return res.status(401).json({ message: "Email or password is incorrect." });
    }

    const loggedInAt = new Date();
    await models.User.updateOne(
      { userId: user.userId },
      {
        $set: { failedLoginAttempts: 0, lastLoginAt: loggedInAt },
        $unset: { lockUntil: 1, lastFailedLoginAt: 1 }
      }
    );
    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    user.lastFailedLoginAt = undefined;
    user.lastLoginAt = loggedInAt;
    resetAccountFailureLimit(req, res);
    await addAuditLog({ actor: user, action: "Admin login success", module: "Auth", targetType: "User", targetId: user.userId, req });

    res.json(await issueAuthSession(user, res));
  } catch (error) {
    next(error);
  }
});

router.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

router.post("/refresh", async (req, res, next) => {
  try {
    const session = await rotateAuthSession(req, res);
    if (!session) return res.status(401).json({ message: "Refresh session is invalid or expired." });
    return res.json(session);
  } catch (error) {
    return next(error);
  }
});

router.post("/logout", async (req, res, next) => {
  try {
    await revokeAuthSession(req, res);
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

export default router;
