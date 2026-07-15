import { models } from "../models/index.js";
import { todayIso, toMinutes } from "../utils/time.js";
import { generateScheduleSlots, resolveScheduleForDate } from "./slotService.js";

const ACTIVE_STATUSES = ["Booked", "Rescheduled"];

function safeImpactItem(item) {
  return {
    appointmentId: item.appointmentId,
    patientName: item.patientName,
    date: item.date,
    time: item.time,
    tokenNumber: item.tokenNumber,
    locationId: item.locationId,
    locationNameEn: item.locationNameEn
  };
}

async function futureAppointments(query = {}) {
  return models.Appointment.find({
    ...query,
    date: { $gte: todayIso() },
    status: { $in: ACTIVE_STATUSES }
  }).sort({ date: 1, time: 1 }).limit(1000).lean();
}

function impactResult(items) {
  const safe = items.map(safeImpactItem);
  return {
    count: safe.length,
    appointmentIds: safe.map((item) => item.appointmentId),
    affectedAppointments: safe.slice(0, 200),
    truncated: safe.length > 200,
    affectedDates: [...new Set(safe.map((item) => item.date))]
  };
}

export function toPublicImpact(impact) {
  const { appointmentIds: _appointmentIds, ...publicImpact } = impact;
  return publicImpact;
}

function appointmentFitsSchedule(appointment, schedule, specialSchedule = null) {
  const effective = resolveScheduleForDate(schedule, appointment.date, specialSchedule);
  const slots = generateScheduleSlots(effective, appointment.date);
  return slots.includes(appointment.time) && appointment.tokenNumber <= Number(effective.dailyLimit || slots.length);
}

export async function getScheduleChangeImpact(locationId, proposedSchedule) {
  const appointments = await futureAppointments({ locationId });
  if (!appointments.length) return impactResult([]);
  const dates = [...new Set(appointments.map((item) => item.date))];
  const specials = await models.SpecialSchedule.find({ locationId, date: { $in: dates }, active: true }).lean();
  const byDate = new Map(specials.map((item) => [item.date, item]));
  const normalizedSchedule = { ...proposedSchedule, active: proposedSchedule.active ?? true };
  return impactResult(appointments.filter((item) => !appointmentFitsSchedule(item, normalizedSchedule, byDate.get(item.date) || null)));
}

export async function getSpecialScheduleImpact(proposedSpecial) {
  const schedule = await models.ScheduleRule.findOne({ locationId: proposedSpecial.locationId, active: true }).lean();
  const appointments = await futureAppointments({ locationId: proposedSpecial.locationId });
  return impactResult(appointments.filter((item) => item.date === proposedSpecial.date && !appointmentFitsSchedule(item, schedule, { ...proposedSpecial, active: true })));
}

export async function getBlockedSlotImpact(block) {
  const appointments = await futureAppointments({ locationId: block.locationId });
  const endDate = block.dateEnd || block.date;
  const affected = appointments.filter((item) => {
    if (item.date < block.date || item.date > endDate) return false;
    if (block.fullDay) return true;
    const time = toMinutes(item.time);
    const start = toMinutes(block.startTime);
    const end = toMinutes(block.endTime);
    return time !== null && start !== null && end !== null && time >= start && time < end;
  });
  return impactResult(affected);
}

export async function getActivationImpact({ locationId = "", active = true } = {}) {
  if (active) return impactResult([]);
  return impactResult(await futureAppointments(locationId ? { locationId } : {}));
}

export async function flagAppointmentsForReschedule(impact, reason) {
  const appointmentIds = impact?.appointmentIds || [];
  if (!appointmentIds.length) return { matchedCount: 0, modifiedCount: 0 };
  return models.Appointment.updateMany(
    { appointmentId: { $in: appointmentIds }, status: { $in: ACTIVE_STATUSES } },
    { $set: { requiresReschedule: true, rescheduleReason: String(reason || "Schedule changed").slice(0, 250) } }
  );
}
