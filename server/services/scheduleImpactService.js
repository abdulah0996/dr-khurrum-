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

function futureAppointmentsSource(query = {}) {
  const requestedDate = query.date;
  const result = models.Appointment.find({
    ...query,
    date: typeof requestedDate === "string" ? requestedDate : { $gte: todayIso(), ...(requestedDate || {}) },
    status: { $in: ACTIVE_STATUSES }
  }).sort({ date: 1, time: 1, _id: 1 }).lean();
  return typeof result.cursor === "function" ? result.cursor({ batchSize: 250 }) : result;
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

async function evaluateFutureAppointments(query, predicate = () => true) {
  const affected = [];
  const source = await futureAppointmentsSource(query);
  for await (const appointment of source) {
    if (await predicate(appointment)) affected.push(appointment);
  }
  return impactResult(affected);
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
  const specials = await models.SpecialSchedule.find({ locationId, date: { $gte: todayIso() }, active: true }).lean();
  const byDate = new Map(specials.map((item) => [item.date, item]));
  const normalizedSchedule = { ...proposedSchedule, active: proposedSchedule.active ?? true };
  return evaluateFutureAppointments(
    { locationId },
    (item) => !appointmentFitsSchedule(item, normalizedSchedule, byDate.get(item.date) || null)
  );
}

export async function getSpecialScheduleImpact(proposedSpecial) {
  const schedule = await models.ScheduleRule.findOne({ locationId: proposedSpecial.locationId, active: true }).lean();
  return evaluateFutureAppointments(
    { locationId: proposedSpecial.locationId, date: proposedSpecial.date },
    (item) => !appointmentFitsSchedule(item, schedule, { ...proposedSpecial, active: true })
  );
}

export async function getSpecialScheduleRemovalImpact(specialScheduleId) {
  const special = await models.SpecialSchedule.findOne({ specialScheduleId, active: true }).lean();
  if (!special) return null;
  const schedule = await models.ScheduleRule.findOne({ locationId: special.locationId, active: true }).lean();
  const impact = await evaluateFutureAppointments(
    { locationId: special.locationId, date: special.date },
    (item) => !appointmentFitsSchedule(item, schedule, null)
  );
  return { special, impact };
}

export async function getBlockedSlotImpact(block) {
  const endDate = block.dateEnd || block.date;
  return evaluateFutureAppointments({ locationId: block.locationId, date: { $gte: block.date, $lte: endDate } }, (item) => {
    if (item.date < block.date || item.date > endDate) return false;
    if (block.fullDay) return true;
    const time = toMinutes(item.time);
    const start = toMinutes(block.startTime);
    const end = toMinutes(block.endTime);
    return time !== null && start !== null && end !== null && time >= start && time < end;
  });
}

export async function getActivationImpact({ locationId = "", active = true } = {}) {
  if (active) return impactResult([]);
  return evaluateFutureAppointments(locationId ? { locationId } : {});
}

export async function flagAppointmentsForReschedule(impact, reason) {
  const appointmentIds = impact?.appointmentIds || [];
  if (!appointmentIds.length) return { matchedCount: 0, modifiedCount: 0 };
  let matchedCount = 0;
  let modifiedCount = 0;
  for (let offset = 0; offset < appointmentIds.length; offset += 500) {
    const result = await models.Appointment.updateMany(
      { appointmentId: { $in: appointmentIds.slice(offset, offset + 500) }, status: { $in: ACTIVE_STATUSES } },
      { $set: { requiresReschedule: true, rescheduleReason: String(reason || "Schedule changed").slice(0, 250) } }
    );
    matchedCount += result.matchedCount || 0;
    modifiedCount += result.modifiedCount || 0;
  }
  return { matchedCount, modifiedCount };
}
