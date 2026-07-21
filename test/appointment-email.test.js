import test from "node:test";
import assert from "node:assert/strict";
import { EmailNotificationOutboxSchema, models } from "../server/models/index.js";
import {
  appointmentEmailConfig,
  buildAppointmentEmail,
  processOneAppointmentEmail,
  queueAppointmentEmail,
  resetAppointmentEmailTransportForTests,
  setAppointmentEmailTransportForTests,
  validateAppointmentEmailConfig
} from "../server/services/appointmentEmailService.js";

const originalEnv = { ...process.env };

function configureEmail() {
  Object.assign(process.env, {
    EMAIL_APPOINTMENT_ALERT_ENABLED: "true",
    EMAIL_APPOINTMENT_ALERT_TO: "zubairsial4878@gmail.com",
    EMAIL_FROM_NAME: "Nighat Medical Complex",
    EMAIL_FROM_ADDRESS: "zubairsial4878@gmail.com",
    EMAIL_PROVIDER: "smtp",
    SMTP_HOST: "smtp.gmail.com",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_USER: "zubairsial4878@gmail.com",
    SMTP_PASSWORD: "abcd efgh ijkl mnop",
    ADMIN_PANEL_URL: "https://admin.nighatmedicalcomplex.com"
  });
}

function appointment() {
  return {
    appointmentId: "KHR-20260725-EMAIL1",
    patientName: "Email Test Patient",
    normalizedPhone: "+923000000001",
    doctorName: "Dr. Khurrum Mansoor",
    locationNameEn: "Nighat Medical Complex",
    date: "2026-07-25",
    time: "10:30",
    tokenNumber: 10,
    status: "Booked",
    source: "Website",
    reasonForVisit: "private medical reason"
  };
}

function query(value) {
  return { lean: async () => value };
}

test.afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  resetAppointmentEmailTransportForTests();
});

test("Gmail SMTP configuration is normalized and validated without exposing credentials", () => {
  configureEmail();
  const config = appointmentEmailConfig();
  assert.equal(config.to, "zubairsial4878@gmail.com");
  assert.equal(config.smtp.host, "smtp.gmail.com");
  assert.equal(config.smtp.port, 587);
  assert.equal(config.smtp.secure, false);
  assert.equal(config.smtp.password, "abcdefghijklmnop");
  assert.deepEqual(validateAppointmentEmailConfig(config), { ok: true, enabled: true });
});

test("appointment email contains the patient phone but excludes medical data", () => {
  configureEmail();
  const message = buildAppointmentEmail(appointment());
  assert.match(message.subject, /Email Test Patient/);
  assert.match(message.text, /KHR-20260725-EMAIL1/);
  assert.match(message.text, /Nighat Medical Complex/);
  assert.match(message.text, /\+92 324 4754566/);
  assert.match(message.text + message.html, /\+923000000001/);
  assert.doesNotMatch(message.text + message.html, /private medical reason|reasonForVisit/);
});

test("email outbox enforces one recipient notification per appointment", () => {
  const unique = EmailNotificationOutboxSchema.indexes().find(([fields, options]) =>
    fields.appointmentId === 1 && fields.recipientEmail === 1 && options.unique
  );
  assert.ok(unique);
});

test("confirmed appointment queues one email notification when enabled", async () => {
  configureEmail();
  const originalUpdate = models.EmailNotificationOutbox.updateOne;
  let captured;
  models.EmailNotificationOutbox.updateOne = async (...args) => {
    captured = args;
    return { upsertedCount: 1 };
  };
  try {
    const result = await queueAppointmentEmail(appointment());
    assert.equal(result.queued, true);
    assert.deepEqual(captured[0], {
      appointmentId: "KHR-20260725-EMAIL1",
      recipientEmail: "zubairsial4878@gmail.com"
    });
    assert.equal(captured[2].upsert, true);
  } finally {
    models.EmailNotificationOutbox.updateOne = originalUpdate;
  }
});

test("email worker sends both HTML and text then marks the durable job sent", async () => {
  configureEmail();
  const originalUpdate = models.EmailNotificationOutbox.findOneAndUpdate;
  const originalAppointment = models.Appointment.findOne;
  let call = 0;
  let payload;
  let finalUpdate;
  const job = {
    notificationId: "EML-TEST",
    appointmentId: "KHR-20260725-EMAIL1",
    recipientEmail: "zubairsial4878@gmail.com",
    status: "sending",
    attemptCount: 1
  };
  models.EmailNotificationOutbox.findOneAndUpdate = (_filter, update) => {
    call += 1;
    if (call === 2) finalUpdate = update;
    return query(call === 1 ? job : { ...job, status: "sent" });
  };
  models.Appointment.findOne = () => query(appointment());
  setAppointmentEmailTransportForTests({
    sendMail: async (message) => {
      payload = message;
      return { messageId: "gmail-test-message" };
    }
  });
  try {
    const result = await processOneAppointmentEmail({ appointmentId: job.appointmentId });
    assert.equal(result.status, "sent");
    assert.equal(payload.to, "zubairsial4878@gmail.com");
    assert.ok(payload.html);
    assert.ok(payload.text);
    assert.equal(finalUpdate.$set.providerMessageId, "gmail-test-message");
  } finally {
    models.EmailNotificationOutbox.findOneAndUpdate = originalUpdate;
    models.Appointment.findOne = originalAppointment;
  }
});
