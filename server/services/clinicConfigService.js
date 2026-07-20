import { DEFAULT_LOCATIONS, DOCTOR } from "../config/clinic.js";
import { models } from "../models/index.js";
import { makePublicId } from "../utils/time.js";

export async function ensureClinicConfiguration() {
  await Promise.all(Object.values(models).map((model) => model.init()));

  for (const item of DEFAULT_LOCATIONS) {
    let location = await models.ClinicLocation.findOne({ slug: item.slug });
    if (!location) {
      location = await models.ClinicLocation.create({
        locationId: makePublicId("LOC"),
        slug: item.slug,
        nameEn: item.nameEn,
        nameUr: item.nameUr,
        addressEn: item.addressEn,
        addressUr: item.addressUr,
        city: item.city,
        country: item.country,
        phone: item.phone,
        googleMapLink: item.googleMapLink,
        consultationMode: item.consultationMode,
        active: item.active
      });
    }

    const existingRule = await models.ScheduleRule.findOne({ locationId: location.locationId });
    if (!existingRule) {
      await models.ScheduleRule.create({
        ruleId: makePublicId("SCH"),
        locationId: location.locationId,
        ...item.schedule
      });
    }
  }

  if (process.env.NODE_ENV === "production") {
    const activeLocations = await models.ClinicLocation.find({ active: true }).select("locationId").lean();
    if (!activeLocations.length) {
      throw new Error("No verified active clinic location is configured in MongoDB.");
    }
    const locationIds = activeLocations.map((location) => location.locationId);
    const activeSchedules = await models.ScheduleRule.find({ locationId: { $in: locationIds }, active: true }).lean();
    if (activeSchedules.length !== activeLocations.length) {
      throw new Error("Every verified active clinic must have one active schedule.");
    }
    const invalidSchedule = activeSchedules.find((schedule) => schedule.timezone !== "Asia/Karachi");
    if (invalidSchedule) {
      throw new Error("Every active clinic schedule must use the Asia/Karachi timezone.");
    }
  }
}

export async function listLocations({ activeOnly = false } = {}) {
  const query = activeOnly ? { active: true } : {};
  return models.ClinicLocation.find(query).sort({ createdAt: 1 }).lean();
}

export async function getLocation(locationId) {
  return models.ClinicLocation.findOne({ locationId, active: true }).lean();
}

export async function upsertLocation(locationId, payload) {
  if (locationId) {
    return models.ClinicLocation.findOneAndUpdate({ locationId }, payload, { returnDocument: "after", runValidators: true }).lean();
  }
  return models.ClinicLocation.create({
    locationId: makePublicId("LOC"),
    slug: payload.slug || makePublicId("clinic").toLowerCase(),
    ...payload
  });
}

export async function listSchedules() {
  return models.ScheduleRule.find({ active: true }).sort({ createdAt: 1 }).lean();
}

export async function getScheduleForLocation(locationId) {
  return models.ScheduleRule.findOne({ locationId, active: true }).lean();
}

export async function updateSchedule(locationId, payload) {
  return models.ScheduleRule.findOneAndUpdate(
    { locationId },
    {
      $set: { ...payload, locationId, timezone: payload.timezone || "Asia/Karachi" },
      $setOnInsert: { ruleId: makePublicId("SCH") }
    },
    {
      returnDocument: "after",
      upsert: true,
      setDefaultsOnInsert: true,
      runValidators: true
    }
  ).lean();
}

export function doctorProfile() {
  const { pendingQualifications: _pendingQualifications, ...publicProfile } = DOCTOR;
  return publicProfile;
}

function publicDoctorProfile(profile) {
  if (!profile) return doctorProfile();
  const {
    pendingQualifications: _pendingQualifications,
    _id: _internalId,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    profileKey: _profileKey,
    ...publicProfile
  } = profile.toObject ? profile.toObject() : profile;
  return publicProfile;
}

export async function getDoctorProfile({ publicOnly = true } = {}) {
  if (models.DoctorProfile.db.readyState !== 1) {
    return publicOnly ? doctorProfile() : { ...DOCTOR, receptionPhone: DOCTOR.contact, active: true };
  }
  const profile = await models.DoctorProfile.findOne({ profileKey: "primary" }).lean();
  if (!profile) return publicOnly ? doctorProfile() : { ...DOCTOR, receptionPhone: DOCTOR.contact, active: true };
  return publicOnly ? publicDoctorProfile(profile) : profile;
}

export async function updateDoctorProfile(payload) {
  return models.DoctorProfile.findOneAndUpdate(
    { profileKey: "primary" },
    {
      $set: { ...payload, profileKey: "primary" },
      $setOnInsert: { doctorProfileId: makePublicId("DOC"), pendingQualifications: DOCTOR.pendingQualifications || [] }
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true, runValidators: true }
  ).lean();
}
