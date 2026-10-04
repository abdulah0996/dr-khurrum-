import test from "node:test";
import assert from "node:assert/strict";
import { todayIso } from "../src/lib/format.js";

test("frontend today uses the clinic's Asia/Karachi calendar date", () => {
  assert.equal(todayIso(new Date("2026-10-04T18:59:59.000Z")), "2026-10-04");
  assert.equal(todayIso(new Date("2026-10-04T19:00:00.000Z")), "2026-10-05");
  assert.equal(todayIso(new Date("2026-10-04T21:36:00.000Z")), "2026-10-05");
});
