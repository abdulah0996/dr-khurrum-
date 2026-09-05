import bcrypt from "bcryptjs";
import { Router } from "express";
import { requireRole } from "../middleware/auth.js";
import { models } from "../models/index.js";
import { addAuditLog } from "../services/auditService.js";
import { makePublicId } from "../utils/time.js";
import { userCreateSchema, userUpdateSchema } from "../utils/validation.js";

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
  try {
    const parsed = userUpdateSchema.parse(req.body);
    const updates = { ...parsed };
    if (parsed.password) {
      updates.passwordHash = await bcrypt.hash(parsed.password, 12);
      delete updates.password;
    }
    const user = await models.User.findOneAndUpdate({ userId: req.params.userId }, updates, { returnDocument: "after" }).select("-passwordHash").lean();
    await addAuditLog({ actor: req.user, action: "Staff user updated", module: "Users", targetType: "User", targetId: req.params.userId, req });
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

router.delete("/:userId", async (req, res, next) => {
  try {
    const user = await models.User.findOne({ userId: req.params.userId }).lean();
    if (!user) return res.status(404).json({ message: "Staff user was not found." });
    if (user.userId === req.user.userId) {
      return res.status(409).json({ message: "You cannot delete the account you are currently signed in with." });
    }

    if (user.role === "Super Admin" && user.status === "Active") {
      const activeSuperAdminCount = await models.User.countDocuments({ role: "Super Admin", status: "Active" });
      if (activeSuperAdminCount <= 1) {
        return res.status(409).json({ message: "The last active Super Admin cannot be deleted." });
      }
    }

    await models.User.deleteOne({ userId: user.userId });
    await addAuditLog({
      actor: req.user,
      action: "Staff user deleted",
      module: "Users",
      targetType: "User",
      targetId: user.userId,
      metadata: { email: user.email, role: user.role },
      req
    });
    return res.json({ deletedUserId: user.userId });
  } catch (error) {
    return next(error);
  }
});

export default router;
