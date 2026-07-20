import mongoose from "mongoose";
import { ACTIVE_APPOINTMENT_STATUSES, APPOINTMENT_POLICIES, DOCTOR } from "../config/clinic.js";
import { models } from "../models/index.js";
import { getDoctorProfile, getLocation } from "./clinicConfigService.js";
import { minutesUntilLocalAppointment, validateSlotAvailability } from "./slotService.js";
import { addAuditLogSafely } from "./auditService.js";
import { adminAlertsForAppointments, queueAdminAppointmentAlert, scheduleAdminAlertProcessing } from "./adminAlertService.js";
import { appointmentCreateSchema, appointmentLookupSchema, appointmentRescheduleSchema, appointmentCancelSchema } from "../utils/validation.js";
import { escapeRegex, makeAppointmentId, makePublicId, maskPhone, normalizePhone } from "../utils/time.js";

function duplicateKeyMessage(error) {
  if (error?.code !== 11000) return null;
  const keys = Object.keys(error.keyPattern || {});
  if (keys.includes("patientId")) return "This patient already has an active appointment on this date.";
  if (keys.includes("time")) return "This slot is already booked.";
  return "A conflicting appointment already exists.";
}

function patientChangeCutoffError(action, language = "en") {
  const englishAction = action === "cancel" ? "cancelled" : "rescheduled";
  const urduAction = action === "cancel" ? "منسوخ" : "تبدیل";
  const message = language === "ur"
    ? `اپائنٹمنٹ کے وقت سے دو گھنٹے کے اندر اسے ${urduAction} نہیں کیا جا سکتا۔ براہِ کرم ریسپشن سے \u2066${DOCTOR.contact}\u2069 پر رابطہ کریں۔`
    : `Appointments cannot be ${englishAction} within two hours of the appointment time. Please contact reception at ${DOCTOR.contact}.`;
  const error = new Error(message);
  error.status = 409;
  error.patientSafe = true;
  return error;
}

function cancellationSource(actor) {
  if (actor?.role === "Patient") return "Patient";
  if (actor?.role) return "Admin";
  return "System";
}

function publicAppointment(appointment) {
  if (!appointment) return null;
  const item = typeof appointment.toObject === "function" ? appointment.toObject() : appointment;
  return {
    appointmentId: item.appointmentId,
    patientName: item.patientName,
    maskedPhone: maskPhone(item.normalizedPhone || item.phone),
    age: item.age,
    gender: item.gender,
    city: item.city,
    locationId: item.locationId,
    locationNameEn: item.locationNameEn,
    locationNameUr: item.locationNameUr,
    doctorName: item.doctorName,
    date: item.date,
    time: item.time,
    tokenNumber: item.tokenNumber,
    status: item.status,
    source: item.source,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

export function toPublicAppointment(appointment) {
  return publicAppointment(appointment);
}

export async function listAppointments(filters = {}) {
  const query = {};
  if (filters.status) query.status = filters.status;
  if (filters.date) query.date = filters.date;
  if (filters.locationId) query.locationId = filters.locationId;
  const search = String(filters.q || "").trim().slice(0, 64);
  if (search) {
    const q = escapeRegex(search);
    query.$or = [
      { appointmentId: { $regex: q, $options: "i" } },
      { patientName: { $regex: q, $options: "i" } },
      { normalizedPhone: { $regex: q, $options: "i" } },
      { date: { $regex: q, $options: "i" } }
    ];
  }
  const appointments = await models.Appointment.find(query).sort({ date: -1, time: -1 }).limit(Math.min(Number(filters.limit || 500), 1000)).lean();
  const alertMap = await adminAlertsForAppointments(appointments.map((item) => item.appointmentId));
  return appointments.map((item) => ({
    appointmentId: item.appointmentId,
    patientName: item.patientName,
    normalizedPhone: item.normalizedPhone,
    maskedPhone: maskPhone(item.normalizedPhone || item.phone),
    age: item.age,
    gender: item.gender,
    city: item.city,
    locationId: item.locationId,
    locationNameEn: item.locationNameEn,
    locationNameUr: item.locationNameUr,
    doctorName: item.doctorName,
    date: item.date,
    time: item.time,
    tokenNumber: item.tokenNumber,
    status: item.status,
    source: item.source,
    adminAlert: alertMap.get(item.appointmentId) || null,
    requiresReschedule: Boolean(item.requiresReschedule),
    rescheduleReason: item.rescheduleReason || "",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }));
}

export async function listAppointmentsPage(filters = {}) {
  const query = {};
  if (filters.status) query.status = filters.status;
  if (filters.date) query.date = filters.date;
  if (filters.locationId) query.locationId = filters.locationId;
  if (String(filters.requiresReschedule || "").toLowerCase() === "true") query.requiresReschedule = true;
  const search = String(filters.q || "").trim().slice(0, 64);
  if (search) {
    const q = escapeRegex(search);
    query.$or = [
      { appointmentId: { $regex: q, $options: "i" } },
      { patientName: { $regex: q, $options: "i" } },
      { normalizedPhone: { $regex: q, $options: "i" } },
      { date: { $regex: q, $options: "i" } }
    ];
  }
  const page = Math.max(1, Number.parseInt(filters.page, 10) || 1);
  const limit = Math.max(1, Math.min(Number.parseInt(filters.limit, 10) || 50, 200));
  const [items, total] = await Promise.all([
    models.Appointment.find(query).sort({ date: -1, time: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    models.Appointment.countDocuments(query)
  ]);
  const alertMap = await adminAlertsForAppointments(items.map((item) => item.appointmentId));
  const appointments = items.map((item) => ({
    appointmentId: item.appointmentId,
    patientName: item.patientName,
    normalizedPhone: item.normalizedPhone,
    maskedPhone: maskPhone(item.normalizedPhone || item.phone),
    age: item.age,
    gender: item.gender,
    city: item.city,
    locationId: item.locationId,
    locationNameEn: item.locationNameEn,
    locationNameUr: item.locationNameUr,
    doctorName: item.doctorName,
    date: item.date,
    time: item.time,
    tokenNumber: item.tokenNumber,
    status: item.status,
    source: item.source,
    adminAlert: alertMap.get(item.appointmentId) || null,
    requiresReschedule: Boolean(item.requiresReschedule),
    rescheduleReason: item.rescheduleReason || "",
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }));
  return {
    appointments,
    pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)), hasNext: page * limit < total, hasPrevious: page > 1 }
  };
}

export async function getAppointmentById(appointmentId) {
  return models.Appointment.findOne({ appointmentId }).lean();
}

export async function lookupAppointmentSafe(payload) {
  const parsed = appointmentLookupSchema.parse(payload);
  const appointment = await models.Appointment.findOne({
    appointmentId: { $regex: `^${escapeRegex(parsed.appointmentId)}$`, $options: "i" },
    normalizedPhone: parsed.phone
  }).lean();
  return publicAppointment(appointment);
}

export async function createAppointment(input, actor = null, req = null) {
  const parsed = appointmentCreateSchema.parse(input);
  const normalizedPhone = normalizePhone(parsed.phone);
  const patientId = parsed.patientId || makePublicId("PAT");
  const identityKey = patientId;
  if (parsed.patientId) {
    const knownPatient = await models.Patient.findOne({ patientId: parsed.patientId }).lean();
    if (!knownPatient) {
      const error = new Error("The selected patient record was not found. Start a new patient registration instead.");
      error.status = 404;
      throw error;
    }
    if (normalizePhone(knownPatient.normalizedPhone || knownPatient.phone) !== normalizedPhone) {
      const error = new Error("The selected patient record does not belong to this contact number.");
      error.status = 409;
      throw error;
    }
  }
  const location = await getLocation(parsed.locationId);
  if (!location) {
    const error = new Error("Clinic location was not found.");
    error.status = 404;
    throw error;
  }
  const doctor = await getDoctorProfile();

  const selectedSlot = await validateSlotAvailability({
    locationId: parsed.locationId,
    date: parsed.date,
    time: parsed.time,
    patientId
  });
  const tokenNumber = selectedSlot.tokenNumber;
  if (!tokenNumber) {
    const error = new Error("Selected time does not have a valid token number.");
    error.status = 422;
    throw error;
  }

  const session = await mongoose.startSession();
  try {
    let appointment;
    let adminAlertQueued = false;
    await session.withTransaction(async () => {
      const patientDetails = {
        fullName: parsed.fullName,
        phone: parsed.phone,
        normalizedPhone,
        age: parsed.age,
        gender: parsed.gender,
        city: parsed.city,
        reasonForVisit: parsed.reasonForVisit,
        consentAccepted: true,
        consentAcceptedAt: new Date(),
        consentSource: parsed.source || "WhatsApp",
        consentRecordedBy: actor?.userId || ""
      };
      const patient = parsed.patientId
        ? await models.Patient.findOneAndUpdate(
          { patientId, normalizedPhone },
          {
            $set: patientDetails
          },
          { returnDocument: "after", session }
        )
        : await models.Patient.create([{
          patientId,
          identityKey,
          ...patientDetails
        }], { session }).then((items) => items[0]);
      /*
       * Do not infer that two registrations are the same person merely because
       * a family shares a contact number, name, or gender. Only an opaque,
       * previously issued patientId authorizes reuse of an existing record.
       */
      if (!patient) {
        const error = new Error("The selected patient record could not be updated.");
        error.status = 409;
        throw error;
      }
      const consentedAt = new Date();
      await models.WhatsAppConsent.findOneAndUpdate(
        { normalizedPhone },
        {
          $set: {
            phone: parsed.phone,
            normalizedPhone,
            optedIn: true,
            source: parsed.source || "WhatsApp",
            language: parsed.language || "en",
            lastOptInAt: consentedAt,
            lastMessageAt: consentedAt
          },
          $setOnInsert: {
            consentId: makePublicId("CNS"),
            nonEssentialOptOut: false,
            failureCount: 0
          }
        },
        { returnDocument: "after", upsert: true, session }
      );

      appointment = await models.Appointment.create(
        [
          {
            appointmentId: makeAppointmentId(),
            patientId: patient.patientId,
            patientName: parsed.fullName,
            phone: parsed.phone,
            normalizedPhone,
            age: parsed.age,
            gender: parsed.gender,
            city: parsed.city,
            locationId: parsed.locationId,
            locationNameEn: location.nameEn,
            locationNameUr: location.nameUr,
            doctorName: doctor.nameEn || DOCTOR.nameEn,
            date: parsed.date,
            time: parsed.time,
            tokenNumber,
            status: "Booked",
            reasonForVisit: parsed.reasonForVisit,
            source: parsed.source || "WhatsApp"
          }
        ],
        { session }
      ).then((items) => items[0]);
      adminAlertQueued = (await queueAdminAppointmentAlert(appointment, { session })).queued;
    });

    await addAuditLogSafely({
      actor,
      action: "Appointment created",
      module: "Appointments",
      targetType: "Appointment",
      targetId: appointment.appointmentId,
      metadata: { source: appointment.source, date: appointment.date, locationId: appointment.locationId },
      req
    });

    if (adminAlertQueued) scheduleAdminAlertProcessing(appointment.appointmentId);

    return appointment.toObject();
  } catch (error) {
    const message = duplicateKeyMessage(error);
    if (message) {
      const existing = await models.Appointment.findOne({
        patientId,
        locationId: parsed.locationId,
        date: parsed.date,
        time: parsed.time,
        status: { $in: ACTIVE_APPOINTMENT_STATUSES }
      }).lean();
      if (existing) return existing;
      const conflict = new Error(message);
      conflict.status = 409;
      conflict.patientSafe = message.startsWith("This phone number");
      throw conflict;
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function rescheduleAppointment(input, actor = null, req = null) {
  const parsed = appointmentRescheduleSchema.parse(input);
  const normalizedPhone = normalizePhone(parsed.phone);
  const appointment = await models.Appointment.findOne({ appointmentId: parsed.appointmentId, normalizedPhone });
  if (!appointment) {
    const error = new Error("Appointment was not found for the provided ID and phone number.");
    error.status = 404;
    throw error;
  }
  if (!ACTIVE_APPOINTMENT_STATUSES.includes(appointment.status)) {
    const error = new Error("This appointment cannot be rescheduled because it is not active.");
    error.status = 409;
    throw error;
  }
  if (actor?.role === "Patient" && minutesUntilLocalAppointment(appointment.date, appointment.time) < APPOINTMENT_POLICIES.rescheduleCutoffMinutes) {
    throw patientChangeCutoffError("reschedule", parsed.language);
  }

  const location = await getLocation(parsed.locationId);
  if (!location) {
    const error = new Error("Clinic location was not found.");
    error.status = 404;
    throw error;
  }

  const selectedSlot = await validateSlotAvailability({
    locationId: parsed.locationId,
    date: parsed.date,
    time: parsed.time,
    patientId: appointment.patientId,
    excludeAppointmentId: appointment.appointmentId
  });
  const tokenNumber = selectedSlot.tokenNumber;
  if (!tokenNumber) {
    const error = new Error("Selected time does not have a valid token number.");
    error.status = 422;
    throw error;
  }

  const session = await mongoose.startSession();
  try {
    let updated;
    await session.withTransaction(async () => {
      updated = await models.Appointment.findOneAndUpdate(
        {
          appointmentId: parsed.appointmentId,
          normalizedPhone,
          status: { $in: ACTIVE_APPOINTMENT_STATUSES }
        },
        {
          locationId: parsed.locationId,
          locationNameEn: location.nameEn,
          locationNameUr: location.nameUr,
          date: parsed.date,
          time: parsed.time,
          tokenNumber,
          status: "Rescheduled",
          requiresReschedule: false,
          rescheduleReason: "",
          $push: {
            rescheduleHistory: {
              fromLocationId: appointment.locationId,
              fromDate: appointment.date,
              fromTime: appointment.time,
              fromTokenNumber: appointment.tokenNumber,
              toLocationId: parsed.locationId,
              toDate: parsed.date,
              toTime: parsed.time,
              toTokenNumber: tokenNumber,
              changedAt: new Date(),
              changedBy: actor?.userId || actor?.id || "Patient"
            }
          }
        },
        { returnDocument: "after", session }
      );
    });

    await addAuditLogSafely({
      actor,
      action: "Appointment rescheduled",
      module: "Appointments",
      targetType: "Appointment",
      targetId: updated.appointmentId,
      metadata: { date: updated.date, time: updated.time, locationId: updated.locationId },
      req
    });

    return updated.toObject();
  } catch (error) {
    const message = duplicateKeyMessage(error);
    if (message) {
      const conflict = new Error(message);
      conflict.status = 409;
      conflict.patientSafe = message.startsWith("This phone number");
      throw conflict;
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function cancelAppointment(input, actor = null, req = null) {
  const parsed = appointmentCancelSchema.parse(input);
  const normalizedPhone = normalizePhone(parsed.phone);
  const existing = await models.Appointment.findOne({ appointmentId: parsed.appointmentId, normalizedPhone }).lean();
  if (!existing) {
    const error = new Error("Appointment was not found for the provided ID and phone number.");
    error.status = 404;
    throw error;
  }
  if (existing.status === "Cancelled") return existing;
  if (!ACTIVE_APPOINTMENT_STATUSES.includes(existing.status)) {
    const error = new Error("This appointment cannot be cancelled because it is not active.");
    error.status = 409;
    error.patientSafe = true;
    throw error;
  }
  if (actor?.role === "Patient" && minutesUntilLocalAppointment(existing.date, existing.time) < APPOINTMENT_POLICIES.cancellationCutoffMinutes) {
    throw patientChangeCutoffError("cancel", parsed.language);
  }
  const appointment = await models.Appointment.findOneAndUpdate(
    {
      appointmentId: parsed.appointmentId,
      normalizedPhone,
      status: { $in: ACTIVE_APPOINTMENT_STATUSES }
    },
    {
      status: "Cancelled",
      requiresReschedule: false,
      rescheduleReason: "",
      cancelledReason: parsed.reason,
      cancelledAt: new Date(),
      cancelledBy: actor?.userId || actor?.id || "System",
      cancelledSource: cancellationSource(actor)
    },
    { returnDocument: "after" }
  ).lean();

  if (!appointment) {
    const error = new Error("Active appointment was not found for the provided ID and phone number.");
    error.status = 404;
    throw error;
  }

  await addAuditLogSafely({
    actor,
    action: "Appointment cancelled",
    module: "Appointments",
    targetType: "Appointment",
    targetId: appointment.appointmentId,
    metadata: { reason: parsed.reason },
    req
  });

  return appointment;
}

export const APPOINTMENT_STATUS_TRANSITIONS = {
  Booked: ["Visited", "No-Show", "Cancelled"],
  Rescheduled: ["Visited", "No-Show", "Cancelled"],
  Visited: [],
  "No-Show": [],
  Cancelled: []
};

export async function updateAppointmentStatus(appointmentId, status, actor = null, req = null, reason = "") {
  if (status === "No-Show" && String(reason || "").trim().length < 3) {
    const error = new Error("A brief verification note is required when marking an appointment No-Show.");
    error.status = 422;
    throw error;
  }
  const existing = await models.Appointment.findOne({ appointmentId }).lean();
  if (!existing) {
    const error = new Error("Appointment was not found.");
    error.status = 404;
    throw error;
  }

  if (status === existing.status) return existing;
  if (!(APPOINTMENT_STATUS_TRANSITIONS[existing.status] || []).includes(status)) {
    const error = new Error(`An appointment marked ${existing.status} cannot be changed to ${status}.`);
    error.status = 409;
    throw error;
  }

  const minutesUntil = minutesUntilLocalAppointment(existing.date, existing.time);
  if (status === "Visited" && minutesUntil > 0) {
    const error = new Error("A future appointment cannot be marked Visited.");
    error.status = 409;
    throw error;
  }
  if (status === "No-Show" && minutesUntil > -APPOINTMENT_POLICIES.noShowAfterMinutes) {
    const error = new Error(`An appointment cannot be marked No-Show until ${APPOINTMENT_POLICIES.noShowAfterMinutes} minutes after its scheduled time.`);
    error.status = 409;
    throw error;
  }

  const updates = { status };
  if (!["Booked", "Rescheduled"].includes(status)) {
    updates.requiresReschedule = false;
    updates.rescheduleReason = "";
  }
  if (status === "Cancelled") {
    updates.cancelledReason = String(reason || "Cancelled by staff").slice(0, 250);
    updates.cancelledAt = new Date();
    updates.cancelledBy = actor?.userId || actor?.id || "Staff";
    updates.cancelledSource = cancellationSource(actor);
  } else if (status === "Visited") {
    updates.visitedAt = new Date();
    updates.visitedBy = actor?.userId || actor?.id || "Staff";
  } else if (status === "No-Show") {
    updates.noShowAt = new Date();
    updates.noShowBy = actor?.userId || actor?.id || "Staff";
    updates.noShowReason = String(reason || "").trim().slice(0, 250);
  }

  const appointment = await models.Appointment.findOneAndUpdate(
    { appointmentId, status: existing.status },
    updates,
    { returnDocument: "after" }
  ).lean();
  if (!appointment) {
    const current = await models.Appointment.findOne({ appointmentId }).lean();
    const error = new Error(current
      ? `This appointment changed to ${current.status} while you were updating it. Refresh and review the latest status.`
      : "Appointment was not found.");
    error.status = current ? 409 : 404;
    throw error;
  }

  await addAuditLogSafely({
    actor,
    action: `Appointment marked ${status}`,
    module: "Appointments",
    targetType: "Appointment",
    targetId: appointment.appointmentId,
    metadata: {
      previousStatus: existing.status,
      newStatus: status,
      ...(reason ? { reason: String(reason).trim().slice(0, 250) } : {})
    },
    req
  });

  return appointment;
}
