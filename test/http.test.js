import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { signAccessToken } from "../server/middleware/auth.js";
import { models } from "../server/models/index.js";

process.env.NODE_ENV = "test";
process.env.WHATSAPP_VERIFY_TOKEN = "qa-verify-token";
process.env.META_APP_SECRET = "f".repeat(32);

const { app } = await import("../server/index.js");

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test("degraded health uses a failing readiness status without exposing database details", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.equal(body.status, "degraded");
  assert.equal(body.mongoConnected, false);
  assert.equal(Object.hasOwn(body, "host"), false);
  assert.equal(Object.hasOwn(body, "lastError"), false);
});

test("HTTP security headers, request IDs, authentication, and parameter pollution controls are active", async () => {
  const health = await fetch(`${baseUrl}/api/health`, { headers: { "x-request-id": "qa-request-1" } });
  assert.equal(health.headers.get("x-request-id"), "qa-request-1");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");
  assert.equal(health.headers.get("x-powered-by"), null);

  const protectedResponse = await fetch(`${baseUrl}/api/settings`);
  assert.equal(protectedResponse.status, 401);
  assert.equal((await protectedResponse.json()).message, "Authentication required.");

  const polluted = await fetch(`${baseUrl}/api/health?key=one&key=two`);
  assert.equal(polluted.status, 400);
});

test("Meta webhook verification accepts only the configured challenge and valid HMAC signature", async () => {
  const validChallenge = await fetch(
    `${baseUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=qa-verify-token&hub.challenge=12345`
  );
  assert.equal(validChallenge.status, 200);
  assert.equal(await validChallenge.text(), "12345");

  const invalidChallenge = await fetch(
    `${baseUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345`
  );
  assert.equal(invalidChallenge.status, 403);

  const payload = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
  const signature = `sha256=${crypto.createHmac("sha256", process.env.META_APP_SECRET).update(payload).digest("hex")}`;
  const accepted = await fetch(`${baseUrl}/api/whatsapp/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": signature },
    body: payload
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true });

  const rejected = await fetch(`${baseUrl}/api/whatsapp/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=invalid" },
    body: payload
  });
  assert.equal(rejected.status, 403);
});

test("production HTTPS enforcement rejects a forwarded HTTP request", async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const response = await fetch(`${baseUrl}/api/health`, { headers: { "x-forwarded-proto": "http" } });
    assert.equal(response.status, 403);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test("health endpoint remains responsive under a controlled 50-request burst", async () => {
  const startedAt = performance.now();
  const responses = await Promise.all(Array.from({ length: 50 }, () => fetch(`${baseUrl}/api/health`)));
  const elapsedMs = performance.now() - startedAt;
  assert.equal(responses.every((response) => response.status === 503), true);
  assert.ok(elapsedMs < 5000, `Health burst took ${Math.round(elapsedMs)}ms`);
});

test("authentication and request-body abuse controls reject repeated and oversized requests", async () => {
  const attempts = [];
  for (let index = 0; index < 21; index += 1) {
    attempts.push(await fetch(`${baseUrl}/api/auth/me`));
  }
  assert.equal(attempts.slice(0, 20).every((response) => response.status === 401), true);
  assert.equal(attempts[20].status, 429);

  const oversized = await fetch(`${baseUrl}/api/whatsapp/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value: "x".repeat(513 * 1024) })
  });
  assert.equal(oversized.status, 413);
});

test("public clinic information omits internal pending qualifications", async () => {
  const originalLocationFind = models.ClinicLocation.find;
  const originalScheduleFind = models.ScheduleRule.find;
  models.ClinicLocation.find = () => ({ sort: () => ({ lean: async () => [] }) });
  models.ScheduleRule.find = () => ({ sort: () => ({ lean: async () => [] }) });
  try {
    const response = await fetch(`${baseUrl}/api/public/info`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.doctor.qualificationsEn, "MBBS");
    assert.equal(Object.hasOwn(body.doctor, "pendingQualifications"), false);
    assert.doesNotMatch(JSON.stringify(body), /FCPS/);
  } finally {
    models.ClinicLocation.find = originalLocationFind;
    models.ScheduleRule.find = originalScheduleFind;
  }
});

test("Receptionist authorization cannot mutate verified clinic settings", async () => {
  const originalFindOne = models.User.findOne;
  const receptionist = {
    userId: "USR-QA-RECEPTION",
    name: "QA Reception",
    email: "qa-reception@example.invalid",
    role: "Receptionist",
    status: "Active"
  };
  models.User.findOne = () => ({ lean: async () => receptionist });
  try {
    const token = signAccessToken(receptionist);
    const response = await fetch(`${baseUrl}/api/settings/schedules/LOC-QA`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    assert.equal(response.status, 403);
    const blocked = await fetch(`${baseUrl}/api/slots/blocked`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ locationId: "LOC-QA", date: "2026-07-20", fullDay: true, reason: "Unauthorized" })
    });
    assert.equal(blocked.status, 403);
    const doctorImpact = await fetch(`${baseUrl}/api/settings/doctor/impact`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({})
    });
    assert.equal(doctorImpact.status, 403);
  } finally {
    models.User.findOne = originalFindOne;
  }
});
