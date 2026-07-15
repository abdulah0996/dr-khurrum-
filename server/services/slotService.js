import { APPOINTMENT_POLICIES, TIMEZONE } from "../config/clinic.js";
import { models } from "../models/index.js";
import { getLocation, getScheduleForLocation } from "./clinicConfigService.js";
import { addDaysIso, currentTimeHHMM, dayName, fromMinutes, isPastDate, toMinutes, todayIso } from "../utils/time.js";

function isWithinBlockedRange(time, block) {
  if (!block.active) return false;
  if (block.fullDay) return true;
  if (!block.startTime || !block.endTime) return false;
  const slot = toMinutes(time);
  const start = toMinutes(block.startTime);
  const end = toMinutes(block.endTime);
  return slot !== null && start !== null && end !== null && slot >= start && slot < end;
}

function isDuringBreak(time, schedule) {
  const slot = toMinutes(time);
  const breaks = schedule.breaks?.length
    ? schedule.breaks
    : schedule.breakStart && schedule.breakEnd
      ? [{ startTime: schedule.breakStart, endTime: schedule.breakEnd }]
      : [];
  return breaks.some((item) => {
    const start = toMinutes(item.startTime);
    const end = toMinutes(item.endTime);
    return slot !== null && start !== null && end !== null && slot >= start && slot < end;
  });
}

export function resolveScheduleForDate(schedule, date, specialSchedule = null) {
  const day = dayName(date);
  const dayRule = schedule?.dayRules?.find((item) => item.day === day);
  const legacyWorking = Boolean(schedule?.workingDays?.includes(day));
  const base = dayRule
    ? {
        working: dayRule.working,
        openingTime: dayRule.openingTime,
        closingTime: dayRule.closingTime,
        slotDurationMinutes: dayRule.slotDurationMinutes,
        dailyLimit: dayRule.dailyLimit,
        breaks: dayRule.breaks || []
      }
    : {
        working: legacyWorking,
        openingTime: schedule?.openingTime,
        closingTime: schedule?.closingTime,
        slotDurationMinutes: schedule?.slotDurationMinutes,
        dailyLimit: schedule?.dailyLimit,
        breaks: schedule?.breakStart && schedule?.breakEnd
          ? [{ breakId: "legacy-break", startTime: schedule.breakStart, endTime: schedule.breakEnd, labelEn: schedule.breakReasonEn, labelUr: schedule.breakReasonUr }]
          : []
      };
  const override = specialSchedule?.active ? specialSchedule : null;
  return {
    ...base,
    ...(override
      ? {
          working: override.working,
          openingTime: override.openingTime,
          closingTime: override.closingTime,
          slotDurationMinutes: override.slotDurationMinutes,
          dailyLimit: override.dailyLimit,
          breaks: override.breaks || [],
          specialScheduleId: override.specialScheduleId,
          labelEn: override.labelEn,
          labelUr: override.labelUr
        }
      : {}),
    date,
    day,
    workingDays: (override?.working ?? base.working) ? [day] : [],
    timezone: schedule?.timezone || TIMEZONE,
    active: Boolean(schedule?.active && (override?.working ?? base.working))
  };
}

export function generateScheduleSlots(schedule, date = todayIso()) {
  if (!schedule?.active) return [];
  if (!schedule.workingDays?.includes(dayName(date))) return [];

  const opening = toMinutes(schedule.openingTime);
  const closing = toMinutes(schedule.closingTime);
  const duration = Number(schedule.slotDurationMinutes || 15);
  const limit = Number(schedule.dailyLimit || 200);
  const slots = [];

  if (opening === null || closing === null || closing <= opening || !Number.isInteger(duration) || duration <= 0 || !Number.isInteger(limit) || limit <= 0) {
    return slots;
  }

  for (let cursor = opening; cursor + duration <= closing && slots.length < limit; cursor += duration) {
    const time = fromMinutes(cursor);
    if (!isDuringBreak(time, schedule)) slots.push(time);
  }

  return slots;
}

export function isWithinAdvanceWindow(date, currentDate = todayIso(), maximumDays = APPOINTMENT_POLICIES.advanceBookingDays) {
  const requested = Date.parse(`${date}T00:00:00.000Z`);
  const first = Date.parse(`${currentDate}T00:00:00.000Z`);
  const last = Date.parse(`${addDaysIso(currentDate, maximumDays)}T00:00:00.000Z`);
  return Number.isFinite(requested) && Number.isFinite(first) && Number.isFinite(last) && requested >= first && requested <= last;
}

export function isInsideSameDayCutoff(time, currentTime = currentTimeHHMM(), cutoffMinutes = APPOINTMENT_POLICIES.sameDayCutoffMinutes) {
  const slot = toMinutes(time);
  const now = toMinutes(currentTime);
  return slot === null || now === null || slot - now < cutoffMinutes;
}

export function minutesUntilLocalAppointment(date, time, currentDate = todayIso(), currentTime = currentTimeHHMM()) {
  const appointment = Date.parse(`${date}T${time}:00.000Z`);
  const current = Date.parse(`${currentDate}T${currentTime}:00.000Z`);
  return Math.floor((appointment - current) / 60000);
}

export function tokenNumberForTime(schedule, date, time) {
  const index = generateScheduleSlots(schedule, date).indexOf(time);
  return index < 0 ? null : index + 1;
}

export async function getAvailability({ locationId, date, includeUnavailable = true, excludeAppointmentId = "" }) {
  const location = await getLocation(locationId);
  if (!location) {
    const error = new Error("Clinic location was not found.");
    error.status = 404;
    throw error;
  }

  const databaseReady = models.SpecialSchedule.db.readyState === 1;
  const [schedule, specialSchedule, doctor] = await Promise.all([
    getScheduleForLocation(locationId),
    databaseReady ? models.SpecialSchedule.findOne({ locationId, date, active: true }).lean() : null,
    databaseReady ? models.DoctorProfile.findOne({ profileKey: "primary" }).select("active").lean() : null
  ]);
  const effectiveSchedule = resolveScheduleForDate(schedule, date, specialSchedule);
  const withinAdvanceWindow = isWithinAdvanceWindow(date, todayIso(schedule?.timezone || TIMEZONE));
  const doctorActive = doctor ? doctor.active : true;
  const baseSlots = withinAdvanceWindow && doctorActive ? generateScheduleSlots(effectiveSchedule, date) : [];
  const blocks = await models.BlockedSlot.find({
    locationId,
    active: true,
    $or: [
      { date, dateEnd: { $exists: false } },
      { date, dateEnd: "" },
      { date: { $lte: date }, dateEnd: { $gte: date } }
    ]
  }).lean();
  const booked = await models.Appointment.find({
    appointmentId: { $ne: excludeAppointmentId },
    locationId,
    date,
    status: { $in: ["Booked", "Rescheduled"] }
  }).lean();

  const bookedByTime = new Map(booked.map((appointment) => [appointment.time, appointment]));
  const atDailyCapacity = booked.length >= Number(effectiveSchedule.dailyLimit || 200);
  const today = todayIso(schedule?.timezone || TIMEZONE);
  const now = currentTimeHHMM(schedule?.timezone || TIMEZONE);

  const slots = baseSlots.map((time) => {
    const blocked = blocks.find((block) => isWithinBlockedRange(time, block));
    const bookedAppointment = bookedByTime.get(time);
    const cutoff = Date.parse(`${date}T00:00:00.000Z`) < Date.parse(`${today}T00:00:00.000Z`) || (date === today && isInsideSameDayCutoff(time, now));
    const available = !blocked && !bookedAppointment && !cutoff && !atDailyCapacity;
    let reason = "";
    if (cutoff) reason = "Same-day booking cutoff";
    if (blocked) reason = blocked.reason || "Blocked";
    if (bookedAppointment) reason = "Already booked";
    if (atDailyCapacity && !bookedAppointment) reason = "Daily appointment capacity reached";

    return {
      time,
      tokenNumber: baseSlots.indexOf(time) + 1,
      available,
      status: available ? "Available" : bookedAppointment ? "Booked" : blocked ? "Blocked" : "Unavailable",
      reason
    };
  });

  return {
    location,
    schedule,
    effectiveSchedule,
    doctorActive,
    date,
    closed: !doctorActive || baseSlots.length === 0 || blocks.some((block) => block.fullDay),
    slots: includeUnavailable ? slots : slots.filter((slot) => slot.available),
    availableSlots: slots.filter((slot) => slot.available)
  };
}

export async function validateSlotAvailability({ locationId, date, time, phone = "", excludeAppointmentId = "" }) {
  if (isPastDate(date) || !isWithinAdvanceWindow(date)) {
    const error = new Error(`Appointments may be booked from today through ${APPOINTMENT_POLICIES.advanceBookingDays} days in advance.`);
    error.status = 422;
    throw error;
  }

  const availability = await getAvailability({ locationId, date, excludeAppointmentId });
  if (!availability.doctorActive || !availability.effectiveSchedule?.active) {
    const error = new Error("Selected clinic is not available on this date.");
    error.status = 422;
    throw error;
  }

  const slot = availability.slots.find((item) => item.time === time);
  if (!slot) {
    const error = new Error("Selected time is outside clinic timing.");
    error.status = 422;
    throw error;
  }

  if (!slot.available) {
    const error = new Error(slot.reason || "Selected slot is not available.");
    error.status = 409;
    throw error;
  }

  if (phone) {
    const duplicate = await models.Appointment.findOne({
      appointmentId: { $ne: excludeAppointmentId },
      normalizedPhone: phone,
      date,
      status: { $in: ["Booked", "Rescheduled"] }
    }).lean();

    if (duplicate) {
      const error = new Error("This phone number already has an active appointment on this date.");
      error.status = 409;
      throw error;
    }
  }

  return slot;
}

export async function getUpcomingAvailableDates(locationId, count = 6, startDate = todayIso()) {
  const dates = [];
  let cursor = startDate;
  let guard = 0;

  while (dates.length < count && guard <= APPOINTMENT_POLICIES.advanceBookingDays) {
    const availability = await getAvailability({ locationId, date: cursor, includeUnavailable: false });
    if (availability.availableSlots.length > 0) {
      dates.push({
        date: cursor,
        day: dayName(cursor),
        firstTime: availability.availableSlots[0].time
      });
    }
    cursor = addDaysIso(cursor, 1);
    guard += 1;
  }

  return dates;
}

export async function createBlockedSlot(payload, actor) {
  const block = await models.BlockedSlot.create({
    blockedSlotId: `BLK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
    ...payload,
    createdBy: actor?.userId || actor?.id || "System",
    active: true
  });
  return block.toObject();
}

export async function updateBlockedSlot(blockedSlotId, payload) {
  return models.BlockedSlot.findOneAndUpdate({ blockedSlotId }, payload, { returnDocument: "after", runValidators: true }).lean();
}

export async function listBlockedSlots() {
  return models.BlockedSlot.find({ active: true }).sort({ date: -1, startTime: 1 }).lean();
}

export async function removeBlockedSlot(blockedSlotId) {
  return models.BlockedSlot.findOneAndUpdate({ blockedSlotId }, { active: false }, { returnDocument: "after" }).lean();
}

export async function listSpecialSchedules() {
  return models.SpecialSchedule.find({ active: true }).sort({ date: 1 }).lean();
}

export async function upsertSpecialSchedule(payload, actor) {
  return models.SpecialSchedule.findOneAndUpdate(
    { locationId: payload.locationId, date: payload.date },
    {
      $set: { ...payload, active: payload.active ?? true },
      $setOnInsert: {
        specialScheduleId: `SPC-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
        createdBy: actor?.userId || actor?.id || "System"
      }
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();
}

export async function removeSpecialSchedule(specialScheduleId) {
  return models.SpecialSchedule.findOneAndUpdate({ specialScheduleId }, { active: false }, { returnDocument: "after" }).lean();
}
