import test from "node:test";
import assert from "node:assert/strict";
import { signAccessToken } from "../server/middleware/auth.js";
import { models } from "../server/models/index.js";

process.env.NODE_ENV = "test";

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

test("staff-user deletion removes another account and protects administrator access", async () => {
  const originalFindOne = models.User.findOne;
  const originalCountDocuments = models.User.countDocuments;
  const originalDeleteOne = models.User.deleteOne;
  const originalAuditCreate = models.AuditLog.create;
  const currentUser = {
    userId: "USR-CURRENT-ADMIN",
    name: "Current Admin",
    email: "current@example.invalid",
    role: "Super Admin",
    status: "Active"
  };
  const users = new Map([
    [currentUser.userId, currentUser],
    ["USR-OLD-ADMIN", { userId: "USR-OLD-ADMIN", email: "old@example.invalid", role: "Super Admin", status: "Active" }],
    ["USR-LAST-ADMIN", { userId: "USR-LAST-ADMIN", email: "last@example.invalid", role: "Super Admin", status: "Active" }]
  ]);
  const deleted = [];
  const auditEntries = [];
  let activeSuperAdminCount = 2;

  models.User.findOne = (filter) => ({ lean: async () => users.get(filter.userId) || null });
  models.User.countDocuments = async () => activeSuperAdminCount;
  models.User.deleteOne = async (filter) => {
    deleted.push(filter);
    return { acknowledged: true, deletedCount: 1 };
  };
  models.AuditLog.create = async (entry) => {
    auditEntries.push(entry);
    return entry;
  };

  const token = signAccessToken(currentUser);
  const remove = (userId) => fetch(`${baseUrl}/api/users/${userId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` }
  });

  try {
    const removed = await remove("USR-OLD-ADMIN");
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { deletedUserId: "USR-OLD-ADMIN" });
    assert.deepEqual(deleted, [{ userId: "USR-OLD-ADMIN" }]);
    assert.equal(auditEntries.at(-1).action, "Staff user deleted");
    assert.deepEqual(auditEntries.at(-1).metadata, { email: "old@example.invalid", role: "Super Admin" });

    const selfDelete = await remove(currentUser.userId);
    assert.equal(selfDelete.status, 409);
    assert.match((await selfDelete.json()).message, /currently signed in/i);

    activeSuperAdminCount = 1;
    const lastAdminDelete = await remove("USR-LAST-ADMIN");
    assert.equal(lastAdminDelete.status, 409);
    assert.match((await lastAdminDelete.json()).message, /last active Super Admin/i);

    const missingDelete = await remove("USR-MISSING");
    assert.equal(missingDelete.status, 404);
    assert.match((await missingDelete.json()).message, /not found/i);
    assert.equal(deleted.length, 1);
  } finally {
    models.User.findOne = originalFindOne;
    models.User.countDocuments = originalCountDocuments;
    models.User.deleteOne = originalDeleteOne;
    models.AuditLog.create = originalAuditCreate;
  }
});
