import bcrypt from "bcryptjs";
import { Router } from "express";
import { models } from "../models/index.js";
import { publicUser, signAccessToken, authenticate } from "../middleware/auth.js";
import { addAuditLog } from "../services/auditService.js";
import { bootstrapSchema, loginSchema } from "../utils/validation.js";
import { makePublicId } from "../utils/time.js";

const router = Router();
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

router.get("/bootstrap/status", async (_req, res, next) => {
  try {
    const adminCount = await models.User.countDocuments({ role: "Super Admin" });
    res.json({ setupRequired: adminCount === 0 });
  } catch (error) {
    next(error);
  }
});

router.post("/bootstrap", async (req, res, next) => {
  try {
    const parsed = bootstrapSchema.parse(req.body);
    if (parsed.token !== process.env.ADMIN_BOOTSTRAP_TOKEN) {
      return res.status(403).json({ message: "Invalid bootstrap token." });
    }

    const adminCount = await models.User.countDocuments({ role: "Super Admin" });
    if (adminCount > 0) {
      return res.status(409).json({ message: "Bootstrap is disabled after the first Super Admin is created." });
    }

    const user = await models.User.create({
      userId: makePublicId("USR"),
      name: parsed.name,
      email: parsed.email,
      passwordHash: await bcrypt.hash(parsed.password, 12),
      role: "Super Admin",
      status: "Active"
    });

    await addAuditLog({ actor: user, action: "Staff user created", module: "Users", targetType: "User", targetId: user.userId, req });
    const token = signAccessToken(user);
    res.status(201).json({ token, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const parsed = loginSchema.parse(req.body);
    const user = await models.User.findOne({ email: parsed.email });
    const locked = user?.lockUntil && user.lockUntil.getTime() > Date.now();

    if (!user || user.status !== "Active" || locked || !(await bcrypt.compare(parsed.password, user.passwordHash))) {
      if (user && !locked) {
        const failedLoginAttempts = Number(user.failedLoginAttempts || 0) + 1;
        const lockUntil = failedLoginAttempts >= LOCK_AFTER ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000) : undefined;
        await models.User.updateOne({ userId: user.userId }, { failedLoginAttempts, ...(lockUntil ? { lockUntil } : {}) });
      }
      await addAuditLog({
        actor: user || null,
        action: "Admin login failure",
        module: "Auth",
        targetType: "User",
        targetId: user?.userId || parsed.email,
        metadata: { locked: Boolean(locked) },
        req
      });
      return res.status(401).json({ message: locked ? "Account is temporarily locked. Please try again later." : "Invalid email or password." });
    }

    user.failedLoginAttempts = 0;
    user.lockUntil = undefined;
    user.lastLoginAt = new Date();
    await user.save();
    await addAuditLog({ actor: user, action: "Admin login success", module: "Auth", targetType: "User", targetId: user.userId, req });

    const token = signAccessToken(user);
    res.json({ token, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

router.get("/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});

router.post("/logout", authenticate, (_req, res) => {
  res.json({ ok: true });
});

export default router;
