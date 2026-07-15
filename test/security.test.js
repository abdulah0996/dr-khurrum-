import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { requireRole, publicUser, signAccessToken } from "../server/middleware/auth.js";
import { rejectParameterPollution, requestId, sanitizeInput } from "../server/middleware/security.js";
import { doctorProfile } from "../server/services/clinicConfigService.js";
import { passwordSchema, phoneSchema } from "../server/utils/validation.js";

function responseRecorder() {
  return {
    statusCode: 200,
    payload: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    }
  };
}

test("role middleware blocks a receptionist from Super Admin operations", () => {
  const middleware = requireRole("Super Admin");
  const denied = responseRecorder();
  let nextCalled = false;
  middleware({ user: { role: "Receptionist" } }, denied, () => {
    nextCalled = true;
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(nextCalled, false);

  const allowed = responseRecorder();
  middleware({ user: { role: "Super Admin" } }, allowed, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("access tokens use constrained claims and public users never expose password hashes", () => {
  const previous = process.env.JWT_ACCESS_SECRET;
  process.env.JWT_ACCESS_SECRET = "j".repeat(32);
  try {
    const user = {
      userId: "USR-QA",
      name: "QA Admin",
      email: "qa-admin@example.invalid",
      role: "Super Admin",
      status: "Active",
      passwordHash: "must-not-leak"
    };
    const token = signAccessToken(user);
    const payload = jwt.verify(token, process.env.JWT_ACCESS_SECRET, {
      algorithms: ["HS256"],
      issuer: "dr-khurrum-whatsapp-chatbot",
      audience: "clinic-staff"
    });
    assert.equal(payload.userId, user.userId);
    assert.equal(payload.role, "Super Admin");
    assert.equal(Object.hasOwn(publicUser(user), "passwordHash"), false);
  } finally {
    if (previous === undefined) delete process.env.JWT_ACCESS_SECRET;
    else process.env.JWT_ACCESS_SECRET = previous;
  }
});

test("request sanitization strips MongoDB operators, dotted keys, scripts, and polluted query arrays", () => {
  const req = {
    path: "/api/test",
    body: { "$where": "danger", "profile.name": "<script>alert(1)</script>Safe" },
    query: {},
    params: {}
  };
  sanitizeInput(req, {}, () => {});
  assert.equal(req.body.where, "danger");
  assert.equal(req.body.profile_name, "Safe");
  assert.equal(Object.hasOwn(req.body, "$where"), false);

  const pollutedResponse = responseRecorder();
  rejectParameterPollution({ path: "/api/test", query: { key: ["one", "two"] } }, pollutedResponse, () => {});
  assert.equal(pollutedResponse.statusCode, 400);
});

test("request identifiers are bounded and sensitive input validation fails safely", () => {
  const response = responseRecorder();
  const req = { headers: { "x-request-id": "x".repeat(200) } };
  requestId(req, response, () => {});
  assert.equal(req.id.length, 80);
  assert.equal(response.headers["x-request-id"].length, 80);

  assert.equal(phoneSchema.safeParse("abc").success, false);
  assert.equal(phoneSchema.safeParse("+123").success, false);
  assert.equal(phoneSchema.safeParse("+92 (300) 123-4567").success, true);
  assert.equal(passwordSchema.safeParse("short").success, false);
  assert.equal(passwordSchema.safeParse("Strong-Password-123").success, true);
});

test("doctor profile service returns only the verified public qualification", () => {
  const profile = doctorProfile();
  assert.equal(profile.nameEn, "Dr. Khurrum Mansoor");
  assert.equal(profile.qualificationsEn, "MBBS");
  assert.equal(Object.hasOwn(profile, "pendingQualifications"), false);
  assert.doesNotMatch(JSON.stringify(profile), /FCPS/);
});
