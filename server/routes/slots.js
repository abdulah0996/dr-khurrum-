import { Router } from "express";
import { addAuditLog } from "../services/auditService.js";
import { requireRole } from "../middleware/auth.js";
import {
  createBlockedSlot,
  getAvailability,
  getUpcomingAvailableDates,
  listBlockedSlots,
  listSpecialSchedules,
  removeBlockedSlot,
  removeSpecialSchedule,
  updateBlockedSlot,
  upsertSpecialSchedule
} from "../services/slotService.js";
import { blockedSlotSchema, dateSchema, specialScheduleSchema } from "../utils/validation.js";
import {
  flagAppointmentsForReschedule,
  getBlockedSlotImpact,
  getSpecialScheduleImpact,
  getSpecialScheduleRemovalImpact,
  toPublicImpact
} from "../services/scheduleImpactService.js";

const router = Router();

router.get("/availability", async (req, res, next) => {
  try {
    const locationId = String(req.query.locationId || "");
    const date = dateSchema.parse(req.query.date);
    const availability = await getAvailability({ locationId, date });
    res.json(availability);
  } catch (error) {
    next(error);
  }
});

router.get("/dates", async (req, res, next) => {
  try {
    const locationId = String(req.query.locationId || "");
    const dates = await getUpcomingAvailableDates(locationId, Number(req.query.count || 6));
    res.json({ dates });
  } catch (error) {
    next(error);
  }
});

router.get("/blocked", async (_req, res, next) => {
  try {
    res.json({ blockedSlots: await listBlockedSlots() });
  } catch (error) {
    next(error);
  }
});

router.post("/blocked/impact", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = blockedSlotSchema.parse(req.body);
    res.json({ impact: toPublicImpact(await getBlockedSlotImpact(parsed)) });
  } catch (error) {
    next(error);
  }
});

router.post("/blocked", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = blockedSlotSchema.parse(req.body);
    const impact = await getBlockedSlotImpact(parsed);
    const blockedSlot = await createBlockedSlot(parsed, req.user);
    if (parsed.requiresReschedule) await flagAppointmentsForReschedule(impact, parsed.reason);
    await addAuditLog({
      actor: req.user,
      action: "Slot blocked",
      module: "Slots",
      targetType: "BlockedSlot",
      targetId: blockedSlot.blockedSlotId,
      metadata: { date: blockedSlot.date, locationId: blockedSlot.locationId },
      req
    });
    res.status(201).json({ blockedSlot, impact: toPublicImpact(impact) });
  } catch (error) {
    next(error);
  }
});

router.put("/blocked/:blockedSlotId", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = blockedSlotSchema.parse(req.body);
    const impact = await getBlockedSlotImpact(parsed);
    const blockedSlot = await updateBlockedSlot(req.params.blockedSlotId, parsed);
    if (!blockedSlot) return res.status(404).json({ message: "Blocked slot was not found." });
    if (parsed.requiresReschedule) await flagAppointmentsForReschedule(impact, parsed.reason);
    await addAuditLog({ actor: req.user, action: "Blocked slot changed", module: "Slots", targetType: "BlockedSlot", targetId: blockedSlot.blockedSlotId, req });
    return res.json({ blockedSlot, impact: toPublicImpact(impact) });
  } catch (error) {
    return next(error);
  }
});

router.delete("/blocked/:blockedSlotId", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const blockedSlot = await removeBlockedSlot(req.params.blockedSlotId);
    await addAuditLog({
      actor: req.user,
      action: "Slot unblocked",
      module: "Slots",
      targetType: "BlockedSlot",
      targetId: req.params.blockedSlotId,
      req
    });
    res.json({ blockedSlot });
  } catch (error) {
    next(error);
  }
});

router.get("/special", async (_req, res, next) => {
  try {
    res.json({ specialSchedules: await listSpecialSchedules() });
  } catch (error) {
    next(error);
  }
});

router.post("/special/impact", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = specialScheduleSchema.parse(req.body);
    res.json({ impact: toPublicImpact(await getSpecialScheduleImpact(parsed)) });
  } catch (error) {
    next(error);
  }
});

router.put("/special", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = specialScheduleSchema.parse(req.body);
    const impact = await getSpecialScheduleImpact(parsed);
    const specialSchedule = await upsertSpecialSchedule(parsed, req.user);
    await flagAppointmentsForReschedule(impact, parsed.labelEn || "Special schedule changed");
    await addAuditLog({ actor: req.user, action: "Special schedule changed", module: "Slots", targetType: "SpecialSchedule", targetId: specialSchedule.specialScheduleId, req });
    res.json({ specialSchedule, impact: toPublicImpact(impact) });
  } catch (error) {
    next(error);
  }
});

router.post("/special/:specialScheduleId/removal-impact", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const removal = await getSpecialScheduleRemovalImpact(req.params.specialScheduleId);
    if (!removal) return res.status(404).json({ message: "Special schedule was not found." });
    return res.json({ impact: toPublicImpact(removal.impact) });
  } catch (error) {
    return next(error);
  }
});

router.delete("/special/:specialScheduleId", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const removal = await getSpecialScheduleRemovalImpact(req.params.specialScheduleId);
    if (!removal) return res.status(404).json({ message: "Special schedule was not found." });
    const specialSchedule = await removeSpecialSchedule(req.params.specialScheduleId);
    if (!specialSchedule) return res.status(409).json({ message: "Special schedule was already removed. Refresh and try again." });
    await flagAppointmentsForReschedule(removal.impact, "Special schedule removed");
    await addAuditLog({ actor: req.user, action: "Special schedule removed", module: "Slots", targetType: "SpecialSchedule", targetId: specialSchedule.specialScheduleId, req });
    return res.json({ specialSchedule, impact: toPublicImpact(removal.impact) });
  } catch (error) {
    return next(error);
  }
});

export default router;
