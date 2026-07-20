import bcrypt from "bcryptjs";
import { Router } from "express";
import mongoose from "mongoose";
import { requireRole } from "../middleware/auth.js";
import { models } from "../models/index.js";
import { addAuditLog } from "../services/auditService.js";
import { makePublicId } from "../utils/time.js";
import { userCreateSchema, userUpdateSchema } from "../utils/validation.js";
import { acquireInvariantLock, removesSuperAdminAccess } from "../services/adminInvariantService.js";
import { revokeUserSessions } from "../services/authSessionService.js";

const router = Router();

router.use(requireRole("Super Admin"));

router.get("/", async (_req, res, next) => {
  try {
    const users = await models.User.find({}).sort({ createdAt: -1 }).select("-passwordHash").lean();
    res.json({ users });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const parsed = userCreateSchema.parse(req.body);
    const user = await models.User.create({
      userId: makePublicId("USR"),
      name: parsed.name,
      email: parsed.email,
      passwordHash: await bcrypt.hash(parsed.password, 12),
      role: parsed.role,
      status: parsed.status
    });
    await addAuditLog({ actor: req.user, action: "Staff user created", module: "Users", targetType: "User", targetId: user.userId, req });
    const item = user.toObject();
    delete item.passwordHash;
    res.status(201).json({ user: item });
  } catch (error) {
    next(error);
  }
});

router.put("/:userId", async (req, res, next) => {
  const session = await mongoose.startSession();
  try {
    const parsed = userUpdateSchema.parse(req.body);
    const updates = { ...parsed };
    let incrementTokenVersion = false;
    if (parsed.password) {
      updates.passwordHash = await bcrypt.hash(parsed.password, 12);
      incrementTokenVersion = true;
      delete updates.password;
    }
    let user;
    await session.withTransaction(async () => {
      await acquireInvariantLock("active-super-admin-invariant", session);
      const current = await models.User.findOne({ userId: req.params.userId }).session(session).lean();
      if (!current) {
        const error = new Error("Staff user was not found.");
        error.status = 404;
        throw error;
      }
      if (removesSuperAdminAccess(current, updates)) {
        const otherActiveAdmins = await models.User.countDocuments({
          userId: { $ne: current.userId },
          role: "Super Admin",
          status: "Active"
        }).session(session);
        if (otherActiveAdmins === 0) {
          const error = new Error("The final active Super Admin cannot be disabled or demoted.");
          error.status = 409;
          throw error;
        }
      }
      user = await models.User.findOneAndUpdate(
        { userId: req.params.userId },
        { $set: updates, ...(incrementTokenVersion ? { $inc: { tokenVersion: 1 } } : {}) },
        { returnDocument: "after", session }
      ).select("-passwordHash").lean();
    });
    await addAuditLog({ actor: req.user, action: "Staff user updated", module: "Users", targetType: "User", targetId: req.params.userId, req });
    if (parsed.password || parsed.status === "Inactive") await revokeUserSessions(req.params.userId, parsed.password ? "password_changed" : "account_inactive");
    res.json({ user });
  } catch (error) {
    next(error);
  } finally {
    await session.endSession();
  }
});

export default router;
