import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createLoginLimiters, normalizedLoginEmail, safeClientIpKey } from "../server/middleware/loginRateLimit.js";
import { parseTrustProxy } from "../server/config/trustProxy.js";

async function withLoginServer(run) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  const { accountFailures, ipFailures, accountSuccesses } = createLoginLimiters();
  app.post("/login", accountFailures, ipFailures, accountSuccesses, (req, res) => {
    if (req.body.succeeds) {
      const key = `account:${normalizedLoginEmail(req) || "invalid"}`;
      res.once("finish", () => accountFailures.resetKey(key));
    }
    res.status(req.body.succeeds ? 200 : 401).json({ ok: Boolean(req.body.succeeds) });
  });
  app.post("/refresh", (_req, res) => res.json({ ok: true }));

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function login(baseUrl, { email = " Admin@Example.com ", succeeds = true, ip = "203.0.113.40" } = {}) {
  return fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ email, succeeds })
  });
}

test("1, 3, 20, 100, and 500 successful logins are accepted", async () => {
  await withLoginServer(async (baseUrl) => {
    const checkpoints = new Set([1, 3, 20, 100, 500]);
    for (let attempt = 1; attempt <= 500; attempt += 1) {
      const response = await login(baseUrl);
      assert.equal(response.status, 200, `successful login ${attempt} should work`);
      if (checkpoints.has(attempt)) assert.equal(response.status, 200);
    }
    assert.equal((await login(baseUrl)).status, 429);
  });
});

test("successful login resets account failures without clearing the IP abuse history", async () => {
  await withLoginServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await login(baseUrl, { succeeds: false })).status, 401);
    }
    assert.equal((await login(baseUrl)).status, 200);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      assert.equal((await login(baseUrl, { succeeds: false })).status, 401);
    }
    assert.equal((await login(baseUrl, { succeeds: false })).status, 429);
  });
});

test("IP abuse protection separates clients and does not limit refresh traffic", async () => {
  await withLoginServer(async (baseUrl) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      assert.equal((await login(baseUrl, {
        email: `admin-${attempt}@example.invalid`,
        succeeds: false,
        ip: "203.0.113.50"
      })).status, 401);
    }
    assert.equal((await login(baseUrl, { email: "other@example.invalid", succeeds: false, ip: "198.51.100.9" })).status, 401);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      assert.equal((await fetch(`${baseUrl}/refresh`, { method: "POST" })).status, 200);
    }
  });
});

test("proxy configuration rejects wildcard trust and malformed client IPs cannot create arbitrary keys", () => {
  assert.equal(parseTrustProxy("1"), 1);
  assert.equal(parseTrustProxy("false"), false);
  assert.deepEqual(parseTrustProxy("loopback, 10.0.0.0/8"), ["loopback", "10.0.0.0/8"]);
  assert.throws(() => parseTrustProxy("true"), /TRUST_PROXY/);
  assert.throws(() => parseTrustProxy("*"), /TRUST_PROXY/);
  assert.equal(safeClientIpKey({ ip: "malformed", socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
});

test("React login uses one guarded form submit and disables during submission", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../src/App.jsx", import.meta.url), "utf8"));
  assert.match(source, /if \(submittingRef\.current\) return;/);
  assert.match(source, /submittingRef\.current = true;/);
  assert.match(source, /submittingRef\.current = false;/);
  assert.match(source, /<form className="auth-card" onSubmit=\{submit\}>/);
  assert.match(source, /disabled=\{submitting\}/);
  assert.doesNotMatch(source, /onClick=\{submit\}/);
  assert.match(source, /Your saved records have not been removed/);
  assert.match(source, /const appointmentsRequest = Promise\.allSettled\(appointmentBatch\)/);
  assert.match(source, /api\("\/appointments\?page=1&limit=50"\)/);
  assert.match(source, /appointments: allResult\.status === "fulfilled" \? allResult\.value\.appointments \|\| \[\] : current\.appointments/);
  assert.match(source, /Loading appointments…/);
});
