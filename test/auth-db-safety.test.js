import test from "node:test";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { refreshLifetimeMs } from "../server/services/authSessionService.js";
import { patientIdentityMigrationDecision } from "../server/db/migrations.js";
import { connectDatabase, disconnectDatabase, startDatabaseRecovery, stopDatabaseRecovery } from "../server/db/connection.js";
import { assertDisposableTestMongoUri, databaseNameFromMongoUri } from "../scripts/lib/test-mongodb.js";

test("disposable database guard accepts local and Atlas test names only", () => {
  assert.equal(databaseNameFromMongoUri("mongodb://127.0.0.1:27017/clinic_test?replicaSet=testset"), "clinic_test");
  assert.equal(databaseNameFromMongoUri("mongodb+srv://example.invalid/clinic_test?retryWrites=true"), "clinic_test");
  assert.equal(assertDisposableTestMongoUri("mongodb://127.0.0.1:27017/clinic_test"), "clinic_test");
  assert.throws(() => assertDisposableTestMongoUri("mongodb://127.0.0.1:27017/clinic"), /ends with _test/);
  assert.throws(() => assertDisposableTestMongoUri("https://example.invalid/clinic_test"), /ends with _test/);
});

test("refresh-token lifetime uses the configured bounded duration", () => {
  assert.equal(refreshLifetimeMs("30m"), 30 * 60 * 1000);
  assert.equal(refreshLifetimeMs("12h"), 12 * 60 * 60 * 1000);
  assert.equal(refreshLifetimeMs("7d"), 7 * 24 * 60 * 60 * 1000);
  assert.throws(() => refreshLifetimeMs("forever"), /duration/);
  assert.throws(() => refreshLifetimeMs("30s"), /between 1 minute and 90 days/);
  assert.throws(() => refreshLifetimeMs("91d"), /between 1 minute and 90 days/);
});

test("patient identity migration is opt-in and fails closed outside a test database", () => {
  assert.deepEqual(patientIdentityMigrationDecision({}, "clinic"), {
    run: false,
    reason: "Patient identity migration is disabled by default."
  });
  assert.equal(patientIdentityMigrationDecision({ RUN_PATIENT_IDENTITY_MIGRATION: "true" }, "clinic_copy_test").run, true);
  assert.throws(
    () => patientIdentityMigrationDecision({ RUN_PATIENT_IDENTITY_MIGRATION: "true" }, "clinic"),
    /migration refused/i
  );
  assert.equal(patientIdentityMigrationDecision({
    RUN_PATIENT_IDENTITY_MIGRATION: "true",
    PATIENT_IDENTITY_MIGRATION_APPROVAL: "backup-and-test-copy-verified"
  }, "clinic").run, true);
});

test("database recovery retries initialization failures and marks ready only after success", async () => {
  let ready = false;
  let initializationAttempts = 0;
  let resolveInitialized;
  const initialized = new Promise((resolve) => { resolveInitialized = resolve; });

  startDatabaseRecovery({
    minimumDelayMs: 1,
    maximumDelayMs: 2,
    connect: async () => ({ connected: true, mode: "mongo" }),
    isReady: () => ready,
    onConnected: async () => {
      initializationAttempts += 1;
      if (initializationAttempts === 1) throw new Error("controlled initialization failure");
    },
    markInitialized: () => {
      ready = true;
      resolveInitialized();
    }
  });

  await Promise.race([
    initialized,
    new Promise((_, reject) => setTimeout(() => reject(new Error("database recovery did not retry")), 250))
  ]);
  stopDatabaseRecovery();
  assert.equal(initializationAttempts, 2);
  assert.equal(ready, true);
});

test("production database connections disable implicit index creation", async () => {
  const originalConnect = mongoose.connect;
  const originalEnvironment = process.env.NODE_ENV;
  const originalUri = process.env.MONGODB_URI;
  let configuredAutoIndex;
  mongoose.connect = async () => {
    configuredAutoIndex = mongoose.get("autoIndex");
  };
  process.env.NODE_ENV = "production";
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/controlled_test";
  try {
    await connectDatabase();
    assert.equal(configuredAutoIndex, false);
  } finally {
    await disconnectDatabase();
    mongoose.connect = originalConnect;
    if (originalEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalEnvironment;
    if (originalUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = originalUri;
  }
});
