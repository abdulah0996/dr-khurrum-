import test from "node:test";
import assert from "node:assert/strict";
import { startDatabaseRecovery, stopDatabaseRecovery } from "../server/db/connection.js";

test("database recovery retries initialization and marks the API ready after success", async () => {
  let ready = false;
  let initializationAttempts = 0;
  let resolveInitialized;
  const initialized = new Promise((resolve) => {
    resolveInitialized = resolve;
  });

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

  try {
    await Promise.race([
      initialized,
      new Promise((_, reject) => setTimeout(() => reject(new Error("database recovery did not retry")), 250))
    ]);
  } finally {
    stopDatabaseRecovery();
  }

  assert.equal(initializationAttempts, 2);
  assert.equal(ready, true);
});
