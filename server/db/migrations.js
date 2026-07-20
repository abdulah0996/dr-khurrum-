import { models } from "../models/index.js";
import { makePublicId, patientIdentityKey } from "../utils/time.js";

const PRODUCTION_MIGRATION_APPROVAL = "backup-and-test-copy-verified";

export function patientIdentityMigrationDecision(env = process.env, databaseName = models.Patient.db.name || "") {
  if (String(env.RUN_PATIENT_IDENTITY_MIGRATION || "").toLowerCase() !== "true") {
    return { run: false, reason: "Patient identity migration is disabled by default." };
  }
  if (String(databaseName).endsWith("_test")) return { run: true, reason: "Dedicated test database verified." };
  if (env.PATIENT_IDENTITY_MIGRATION_APPROVAL === PRODUCTION_MIGRATION_APPROVAL) {
    return { run: true, reason: "Explicit backup and copied-test-data approval supplied." };
  }
  throw new Error(
    "Patient identity migration refused: use a database ending in _test, or explicitly confirm that a backup and copied-dataset migration test were verified."
  );
}

async function removeLegacyUniquePhoneIndex() {
  const indexes = await models.Patient.collection.indexes();
  const legacy = indexes.find((index) => index.unique && Object.keys(index.key || {}).length === 1 && index.key.normalizedPhone === 1);
  if (legacy) await models.Patient.collection.dropIndex(legacy.name);
}

async function replaceLegacyAppointmentPhoneIndex() {
  const indexes = await models.Appointment.collection.indexes();
  const legacy = indexes.find((index) => index.unique && index.key?.normalizedPhone === 1 && index.key?.date === 1);
  if (legacy) await models.Appointment.collection.dropIndex(legacy.name);
  const current = indexes.find((index) => index.unique && index.key?.patientId === 1 && index.key?.date === 1);
  if (!current) {
    await models.Appointment.collection.createIndex(
      { patientId: 1, date: 1 },
      { unique: true, partialFilterExpression: { status: { $in: ["Booked", "Rescheduled"] } } }
    );
  }
}

function patientFromAppointment(appointment, identityKey) {
  return {
    patientId: makePublicId("PAT"),
    identityKey,
    fullName: appointment.patientName,
    phone: appointment.phone,
    normalizedPhone: appointment.normalizedPhone,
    age: appointment.age,
    gender: appointment.gender,
    city: appointment.city,
    reasonForVisit: appointment.reasonForVisit || "",
    consentAccepted: false
  };
}

export async function migrateIndependentPatientIdentities() {
  await removeLegacyUniquePhoneIndex();
  await replaceLegacyAppointmentPhoneIndex();
  const marker = await models.Counter.findOne({ scope: "migration:independent-patient-identities:v1", value: 1 }).lean();
  if (marker) return { migratedAppointments: 0, createdPatients: 0, alreadyApplied: true };
  const cursor = models.Appointment.find({}).sort({ createdAt: 1 }).cursor();
  let migratedAppointments = 0;
  let createdPatients = 0;

  for await (const appointment of cursor) {
    const identityKey = patientIdentityKey({
      phone: appointment.normalizedPhone || appointment.phone,
      fullName: appointment.patientName,
      gender: appointment.gender
    });
    let patient = await models.Patient.findOne({ identityKey });
    if (!patient) {
      const reusable = await models.Patient.findOne({
        patientId: appointment.patientId,
        $or: [{ identityKey: { $exists: false } }, { identityKey: "" }]
      });
      if (reusable && patientIdentityKey(reusable) === identityKey) {
        reusable.identityKey = identityKey;
        await reusable.save();
        patient = reusable;
      } else {
        patient = await models.Patient.create(patientFromAppointment(appointment, identityKey));
        createdPatients += 1;
      }
    }
    if (appointment.patientId !== patient.patientId) {
      await models.Appointment.updateOne({ _id: appointment._id }, { $set: { patientId: patient.patientId } });
      migratedAppointments += 1;
    }
  }

  const unmappedPatients = models.Patient.find({ $or: [{ identityKey: { $exists: false } }, { identityKey: "" }] }).cursor();
  for await (const patient of unmappedPatients) {
    const identityKey = patientIdentityKey(patient);
    const existing = await models.Patient.findOne({ identityKey });
    if (!existing) await models.Patient.updateOne({ _id: patient._id }, { $set: { identityKey } });
  }

  await models.Counter.findOneAndUpdate(
    { scope: "migration:independent-patient-identities:v1" },
    { $setOnInsert: { counterId: makePublicId("CTR") }, $set: { value: 1 } },
    { upsert: true, returnDocument: "after" }
  );

  return { migratedAppointments, createdPatients };
}

export async function runSafeMigrations() {
  const decision = patientIdentityMigrationDecision();
  const patientIdentities = decision.run
    ? await migrateIndependentPatientIdentities()
    : { migratedAppointments: 0, createdPatients: 0, skipped: true, reason: decision.reason };
  const legacyWebhookEvents = await models.WebhookEvent.updateMany(
    { $or: [{ status: { $exists: false } }, { status: null }] },
    { $set: { status: "completed", completedAt: new Date() } }
  );
  return { patientIdentities, legacyWebhookEvents: legacyWebhookEvents.modifiedCount || 0 };
}
