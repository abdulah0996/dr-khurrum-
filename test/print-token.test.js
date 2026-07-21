import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildTokenFields } from "../src/lib/printToken.js";

test("print token contains operational appointment details without medical or phone data", () => {
  const appointment = {
    appointmentId: "KHR-20260725-PRINT1",
    patientName: "Test Patient",
    age: 30,
    gender: "Female",
    normalizedPhone: "+923000000001",
    reasonForVisit: "private medical reason",
    doctorName: "Dr. Khurrum Mansoor",
    locationNameEn: "Nighat Medical Complex",
    date: "2026-07-25",
    time: "10:30",
    tokenNumber: 10
  };
  const serialized = JSON.stringify(buildTokenFields(appointment));
  assert.match(serialized, /Test Patient|KHR-20260725-PRINT1|Dr\. Khurrum Mansoor|Nighat Medical Complex/);
  assert.match(serialized, /\+92 324 4754566/);
  assert.doesNotMatch(serialized, /private medical reason|923000000001/);
});

test("appointment lists expose Print Token actions for active appointments", () => {
  const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  assert.match(app, /title="Print Token"/);
  assert.match(app, /<Printer size=\{15\} \/> Print/);
  assert.match(app, /printAppointmentToken\(appointment/);
  assert.match(app, /\["Booked", "Rescheduled"\]\.includes\(appointment\.status\)/);
});
