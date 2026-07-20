import { Router } from "express";
import {
  cancelAppointment,
  createAppointment,
  getAppointmentById,
  listAppointments,
  listAppointmentsPage,
  lookupAppointmentSafe,
  rescheduleAppointment,
  updateAppointmentStatus
} from "../services/appointmentService.js";
import { sendAppointmentWhatsApp } from "../services/whatsappService.js";
import { appointmentConfirmation, cancellationConfirmation, rescheduleConfirmation } from "../services/messageTemplates.js";
import { DOCTOR } from "../config/clinic.js";
import { requireRole } from "../middleware/auth.js";
import { retryAdminAppointmentAlert } from "../services/adminAlertService.js";
import { addAuditLogSafely } from "../services/auditService.js";
import { adminStatusSchema, appointmentCancelSchema, appointmentCreateSchema, appointmentLookupSchema, appointmentRescheduleSchema } from "../utils/validation.js";

const router = Router();

function appointmentReminder(appointment, language = "en") {
  const contact = DOCTOR.contact || "";
  if (language === "ur") {
    return `یاد دہانی: آپ کی ${DOCTOR.nameUr} کے ساتھ اپائنٹمنٹ \u2066${appointment.date}\u2069 کو \u2066${appointment.time}\u2069 پر ہے۔${contact ? ` رابطہ: \u2066${contact}\u2069` : ""}`;
  }
  return `Reminder: your appointment with ${DOCTOR.nameEn} is on ${appointment.date} at ${appointment.time}.${contact ? ` Contact: ${contact}` : ""}`;
}

router.get("/", async (req, res, next) => {
  try {
    res.json(await listAppointmentsPage(req.query));
  } catch (error) {
    next(error);
  }
});

router.get("/:appointmentId", async (req, res, next) => {
  try {
    const appointment = await getAppointmentById(req.params.appointmentId);
    if (!appointment) return res.status(404).json({ message: "Appointment was not found." });
    res.json({ appointment });
  } catch (error) {
    next(error);
  }
});

router.post("/lookup", async (req, res, next) => {
  try {
    const parsed = appointmentLookupSchema.parse(req.body);
    const appointment = await lookupAppointmentSafe(parsed);
    if (!appointment) return res.status(404).json({ message: "Appointment was not found for the provided ID and phone number." });
    res.json({ appointment });
  } catch (error) {
    next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const parsed = appointmentCreateSchema.parse({ ...req.body, source: req.body.source || "Reception" });
    const appointment = await createAppointment(parsed, req.user, req);
    const whatsapp = await sendAppointmentWhatsApp({
      appointment,
      text: appointmentConfirmation(appointment, req.body.language || "en"),
      messageType: "appointment_confirmation",
      actor: req.user,
      language: req.body.language || "en"
    });
    res.status(201).json({ appointment, whatsapp });
  } catch (error) {
    next(error);
  }
});

router.post("/reschedule", async (req, res, next) => {
  try {
    const parsed = appointmentRescheduleSchema.parse(req.body);
    const appointment = await rescheduleAppointment(parsed, req.user, req);
    const whatsapp = await sendAppointmentWhatsApp({
      appointment,
      text: rescheduleConfirmation(appointment, req.body.language || "en"),
      messageType: "reschedule_confirmation",
      actor: req.user,
      language: req.body.language || "en"
    });
    res.json({ appointment, whatsapp });
  } catch (error) {
    next(error);
  }
});

router.post("/cancel", async (req, res, next) => {
  try {
    const parsed = appointmentCancelSchema.parse(req.body);
    const appointment = await cancelAppointment(parsed, req.user, req);
    const whatsapp = await sendAppointmentWhatsApp({
      appointment,
      text: cancellationConfirmation(appointment, req.body.language || "en"),
      messageType: "cancellation_confirmation",
      actor: req.user,
      language: req.body.language || "en"
    });
    res.json({ appointment, whatsapp });
  } catch (error) {
    next(error);
  }
});

router.post("/:appointmentId/reminder", async (req, res, next) => {
  try {
    const appointment = await getAppointmentById(req.params.appointmentId);
    if (!appointment) return res.status(404).json({ message: "Appointment was not found." });
    const language = req.body.language || "en";
    const whatsapp = await sendAppointmentWhatsApp({
      appointment,
      text: appointmentReminder(appointment, language),
      messageType: "appointment_reminder",
      actor: req.user,
      language
    });
    res.json({ appointment, whatsapp });
  } catch (error) {
    next(error);
  }
});

router.post("/:appointmentId/admin-alert/retry", requireRole("Super Admin", "Receptionist"), async (req, res, next) => {
  try {
    const adminAlert = await retryAdminAppointmentAlert(req.params.appointmentId);
    await addAuditLogSafely({
      actor: req.user,
      action: "Admin appointment alert retry requested",
      module: "WhatsApp",
      targetType: "Appointment",
      targetId: req.params.appointmentId,
      req
    });
    res.json({ adminAlert });
  } catch (error) {
    next(error);
  }
});

router.post("/:appointmentId/status", requireRole("Super Admin", "Receptionist"), async (req, res, next) => {
  try {
    const parsed = adminStatusSchema.parse(req.body);
    const appointment = await updateAppointmentStatus(req.params.appointmentId, parsed.status, req.user, req, parsed.reason);
    res.json({ appointment });
  } catch (error) {
    next(error);
  }
});

export default router;
