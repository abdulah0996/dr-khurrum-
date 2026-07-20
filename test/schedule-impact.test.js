import test from "node:test";
import assert from "node:assert/strict";
import { models } from "../server/models/index.js";
import {
  flagAppointmentsForReschedule,
  getActivationImpact,
  getBlockedSlotImpact,
  getScheduleChangeImpact,
  getSpecialScheduleImpact,
  toPublicImpact
} from "../server/services/scheduleImpactService.js";
import { addDaysIso, dayName, todayIso } from "../server/utils/time.js";

const originals = {
  Appointment: { find: models.Appointment.find, updateMany: models.Appointment.updateMany },
  SpecialSchedule: { find: models.SpecialSchedule.find },
  ScheduleRule: { findOne: models.ScheduleRule.findOne }
};

let appointments = [];
let update;

function queryMany(value) {
  return {
    sort() { return this; },
    limit() { return this; },
    lean: async () => value
  };
}

function queryOne(value) {
  return { lean: async () => value };
}

function nextDay(wantedDay) {
  let date = addDaysIso(todayIso(), 1);
  while (dayName(date) !== wantedDay) date = addDaysIso(date, 1);
  return date;
}

const monday = nextDay("Monday");
const baseSchedule = {
  locationId: "LOC-IMPACT",
  active: true,
  workingDays: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
  openingTime: "09:00",
  closingTime: "12:00",
  slotDurationMinutes: 30,
  dailyLimit: 6,
  timezone: "Asia/Karachi"
};

test.before(() => {
  models.Appointment.find = () => queryMany(appointments);
  models.Appointment.updateMany = async (filter, changes) => {
    update = { filter, changes };
    return { matchedCount: filter.appointmentId.$in.length, modifiedCount: filter.appointmentId.$in.length };
  };
  models.SpecialSchedule.find = () => queryOne([]);
  models.ScheduleRule.findOne = () => queryOne(baseSchedule);
});

test.after(() => {
  for (const [model, methods] of Object.entries(originals)) Object.assign(models[model], methods);
});

test.beforeEach(() => {
  update = null;
  appointments = [
    { appointmentId: "APT-1", patientName: "Patient One", locationId: "LOC-IMPACT", locationNameEn: "Clinic", date: monday, time: "09:00", tokenNumber: 1, status: "Booked" },
    { appointmentId: "APT-2", patientName: "Patient Two", locationId: "LOC-IMPACT", locationNameEn: "Clinic", date: monday, time: "10:00", tokenNumber: 3, status: "Booked" }
  ];
});

test("schedule previews identify only appointments invalidated by a new break", async () => {
  const proposed = {
    ...baseSchedule,
    dayRules: [{
      day: "Monday",
      working: true,
      openingTime: "09:00",
      closingTime: "12:00",
      slotDurationMinutes: 30,
      dailyLimit: 5,
      breaks: [{ breakId: "new-break", startTime: "10:00", endTime: "10:30", labelEn: "Break", labelUr: "وقفہ" }]
    }]
  };
  const impact = await getScheduleChangeImpact("LOC-IMPACT", proposed);
  assert.equal(impact.count, 1);
  assert.equal(impact.affectedAppointments[0].appointmentId, "APT-2");
  assert.equal(Object.hasOwn(toPublicImpact(impact), "appointmentIds"), false);
});

test("leave ranges, special hours, and deactivation return safe affected appointment previews", async () => {
  assert.equal((await getBlockedSlotImpact({ locationId: "LOC-IMPACT", date: monday, dateEnd: monday, fullDay: false, startTime: "09:30", endTime: "10:30" })).count, 1);
  assert.equal((await getSpecialScheduleImpact({ locationId: "LOC-IMPACT", date: monday, working: true, openingTime: "09:00", closingTime: "09:30", slotDurationMinutes: 30, dailyLimit: 1, breaks: [] })).count, 1);
  assert.equal((await getActivationImpact({ locationId: "LOC-IMPACT", active: false })).count, 2);
  assert.equal((await getActivationImpact({ locationId: "LOC-IMPACT", active: true })).count, 0);
});

test("affected appointments are flagged instead of deleted or cancelled", async () => {
  const impact = await getActivationImpact({ active: false });
  const result = await flagAppointmentsForReschedule(impact, "Doctor inactive");
  assert.equal(result.modifiedCount, 2);
  assert.deepEqual(update.filter.appointmentId.$in, ["APT-1", "APT-2"]);
  assert.deepEqual(update.changes.$set, { requiresReschedule: true, rescheduleReason: "Doctor inactive" });
  assert.equal(JSON.stringify(update).includes("delete"), false);
  assert.equal(JSON.stringify(update).includes("Cancelled"), false);
});

test("impact evaluation and updates continue beyond one thousand appointments", async () => {
  appointments = Array.from({ length: 1205 }, (_, index) => ({
    appointmentId: `APT-LARGE-${index}`,
    patientName: `Patient ${index}`,
    locationId: "LOC-IMPACT",
    locationNameEn: "Clinic",
    date: monday,
    time: "09:00",
    tokenNumber: 1,
    status: "Booked"
  }));
  let calls = 0;
  models.Appointment.updateMany = async (filter) => {
    calls += 1;
    return { matchedCount: filter.appointmentId.$in.length, modifiedCount: filter.appointmentId.$in.length };
  };
  try {
    const impact = await getActivationImpact({ active: false });
    assert.equal(impact.count, 1205);
    assert.equal(impact.truncated, true);
    const result = await flagAppointmentsForReschedule(impact, "Doctor inactive");
    assert.deepEqual(result, { matchedCount: 1205, modifiedCount: 1205 });
    assert.equal(calls, 3);
  } finally {
    models.Appointment.updateMany = originals.Appointment.updateMany;
  }
});
