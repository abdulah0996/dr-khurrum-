import { Router } from "express";
import { DEFAULT_LOCATIONS, SYSTEM_COPY } from "../config/clinic.js";
import { requireRole } from "../middleware/auth.js";
import { addAuditLog, listAuditLogs } from "../services/auditService.js";
import { getDoctorProfile, listLocations, listSchedules, updateDoctorProfile, updateSchedule, upsertLocation } from "../services/clinicConfigService.js";
import { getWhatsAppQualitySnapshot, getWhatsAppStatus } from "../services/whatsappService.js";
import { getMetricsSnapshot } from "../services/monitoringService.js";
import { doctorProfileSchema, locationSchema, scheduleSchema } from "../utils/validation.js";
import {
  flagAppointmentsForReschedule,
  getActivationImpact,
  getScheduleChangeImpact,
  toPublicImpact
} from "../services/scheduleImpactService.js";

const router = Router();

router.get("/metrics", requireRole("Super Admin"), (_req, res) => {
  res.json({ metrics: getMetricsSnapshot() });
});

router.get("/audit-logs", requireRole("Super Admin"), async (req, res, next) => {
  try {
    res.json({ auditLogs: await listAuditLogs(req.query.limit) });
  } catch (error) {
    next(error);
  }
});

router.get("/", async (_req, res, next) => {
  try {
    res.json({
      product: SYSTEM_COPY,
      doctor: await getDoctorProfile({ publicOnly: false }),
      defaults: DEFAULT_LOCATIONS.map(({ schedule, ...location }) => ({ ...location, schedule })),
      locations: await listLocations(),
      schedules: await listSchedules(),
      whatsapp: {
        ...getWhatsAppStatus(),
        quality: await getWhatsAppQualitySnapshot()
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/locations", async (_req, res, next) => {
  try {
    res.json({ locations: await listLocations() });
  } catch (error) {
    next(error);
  }
});

router.get("/doctor", async (_req, res, next) => {
  try {
    res.json({ doctor: await getDoctorProfile({ publicOnly: false }) });
  } catch (error) {
    next(error);
  }
});

router.post("/doctor/impact", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = doctorProfileSchema.parse(req.body);
    res.json({ impact: toPublicImpact(await getActivationImpact({ active: parsed.active })) });
  } catch (error) {
    next(error);
  }
});

router.put("/doctor", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = doctorProfileSchema.parse(req.body);
    const impact = await getActivationImpact({ active: parsed.active });
    const doctor = await updateDoctorProfile(parsed);
    await flagAppointmentsForReschedule(impact, "Doctor was made inactive");
    await addAuditLog({ actor: req.user, action: "Doctor profile changed", module: "Settings", targetType: "DoctorProfile", targetId: doctor.doctorProfileId, req });
    res.json({ doctor, impact: toPublicImpact(impact) });
  } catch (error) {
    next(error);
  }
});

router.post("/locations", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = locationSchema.parse(req.body);
    const location = await upsertLocation("", parsed);
    await addAuditLog({ actor: req.user, action: "Clinic location changed", module: "Settings", targetType: "ClinicLocation", targetId: location.locationId, req });
    res.status(201).json({ location });
  } catch (error) {
    next(error);
  }
});

router.put("/locations/:locationId", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = locationSchema.partial().parse(req.body);
    const impact = await getActivationImpact({ locationId: req.params.locationId, active: parsed.active ?? true });
    const location = await upsertLocation(req.params.locationId, parsed);
    await flagAppointmentsForReschedule(impact, "Clinic was made inactive");
    await addAuditLog({ actor: req.user, action: "Clinic location changed", module: "Settings", targetType: "ClinicLocation", targetId: req.params.locationId, req });
    res.json({ location, impact: toPublicImpact(impact) });
  } catch (error) {
    next(error);
  }
});

router.post("/locations/:locationId/impact", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = locationSchema.partial().parse(req.body);
    res.json({ impact: toPublicImpact(await getActivationImpact({ locationId: req.params.locationId, active: parsed.active ?? true })) });
  } catch (error) {
    next(error);
  }
});

router.get("/schedules", async (_req, res, next) => {
  try {
    res.json({ schedules: await listSchedules() });
  } catch (error) {
    next(error);
  }
});

router.put("/schedules/:locationId", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = scheduleSchema.parse(req.body);
    const impact = await getScheduleChangeImpact(req.params.locationId, parsed);
    const schedule = await updateSchedule(req.params.locationId, parsed);
    await flagAppointmentsForReschedule(impact, "Clinic schedule changed");
    await addAuditLog({ actor: req.user, action: "Clinic timing changed", module: "Settings", targetType: "ScheduleRule", targetId: req.params.locationId, req });
    res.json({ schedule, impact: toPublicImpact(impact) });
  } catch (error) {
    next(error);
  }
});

router.post("/schedules/:locationId/impact", requireRole("Super Admin"), async (req, res, next) => {
  try {
    const parsed = scheduleSchema.parse(req.body);
    res.json({ impact: toPublicImpact(await getScheduleChangeImpact(req.params.locationId, parsed)) });
  } catch (error) {
    next(error);
  }
});

export default router;
