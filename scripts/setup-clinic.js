import "dotenv/config";
import { pathToFileURL } from "node:url";
import { DOCTOR, VERIFIED_CLINIC } from "../server/config/clinic.js";
import { connectDatabase, disconnectDatabase } from "../server/db/connection.js";
import { models } from "../server/models/index.js";
import { makePublicId } from "../server/utils/time.js";

export async function setupClinic() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is required. No clinic data was changed.");
  }

  await connectDatabase();
  await Promise.all([models.ClinicLocation.init(), models.ScheduleRule.init(), models.DoctorProfile.init(), models.SpecialSchedule.init()]);

  const otherActiveClinic = await models.ClinicLocation.findOne({
    slug: { $ne: VERIFIED_CLINIC.slug },
    active: true
  }).select("slug").lean();
  if (otherActiveClinic) {
    throw new Error("Another active clinic exists. Review it manually before configuring the verified clinic.");
  }

  const existingClinic = await models.ClinicLocation.findOne({ slug: VERIFIED_CLINIC.slug }).select("locationId").lean();
  if (existingClinic) {
    const existingScheduleCount = await models.ScheduleRule.countDocuments({ locationId: existingClinic.locationId });
    if (existingScheduleCount > 1) {
      throw new Error("Multiple schedules exist for the verified clinic. Review the records manually before running setup.");
    }
  }

  const { schedule, ...clinicFields } = VERIFIED_CLINIC;
  const dayRules = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => ({
    day,
    working: schedule.workingDays.includes(day),
    openingTime: schedule.openingTime,
    closingTime: schedule.closingTime,
    slotDurationMinutes: schedule.slotDurationMinutes,
    dailyLimit: schedule.dailyLimit,
    breaks: schedule.breakStart && schedule.breakEnd
      ? [{ breakId: "prayer-break", startTime: schedule.breakStart, endTime: schedule.breakEnd, labelEn: schedule.breakReasonEn, labelUr: schedule.breakReasonUr }]
      : []
  }));
  const clinic = await models.ClinicLocation.findOneAndUpdate(
    { slug: VERIFIED_CLINIC.slug },
    {
      $set: clinicFields,
      $setOnInsert: { locationId: makePublicId("LOC") }
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  ).lean();

  const rule = await models.ScheduleRule.findOneAndUpdate(
    { locationId: clinic.locationId },
    {
      $set: { ...schedule, dayRules, locationId: clinic.locationId },
      $setOnInsert: { ruleId: makePublicId("SCH") }
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  ).lean();

  await models.DoctorProfile.findOneAndUpdate(
    { profileKey: "primary" },
    {
      $set: {
        profileKey: "primary",
        nameEn: DOCTOR.nameEn,
        nameUr: DOCTOR.nameUr,
        qualificationsEn: DOCTOR.qualificationsEn,
        qualificationsUr: DOCTOR.qualificationsUr,
        specialtyEn: DOCTOR.specialtyEn,
        specialtyUr: DOCTOR.specialtyUr,
        biographyEn: DOCTOR.biographyEn,
        biographyUr: DOCTOR.biographyUr,
        receptionPhone: DOCTOR.contact,
        active: true
      },
      $setOnInsert: { doctorProfileId: makePublicId("DOC"), pendingQualifications: DOCTOR.pendingQualifications }
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  ).lean();

  console.log("Verified clinic configuration is ready", {
    clinic: clinic.nameEn,
    city: clinic.city,
    workingDays: rule.workingDays,
    hours: `${rule.openingTime}-${rule.closingTime}`,
    break: `${rule.breakStart}-${rule.breakEnd}`,
    slotDurationMinutes: rule.slotDurationMinutes,
    dailyLimit: rule.dailyLimit,
    timezone: rule.timezone,
    active: clinic.active && rule.active
  });
}

const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  setupClinic()
    .catch((error) => {
      console.error("Clinic setup failed:", error.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await disconnectDatabase();
    });
}
