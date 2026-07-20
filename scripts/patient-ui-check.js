import "dotenv/config";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { acquireDisposableTestMongo } from "./lib/test-mongodb.js";

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await delay(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  constructor(webSocketUrl) {
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.socket = new WebSocket(webSocketUrl);
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      for (const handler of this.handlers.get(message.method) || []) handler(message.params);
    });
  }

  on(method, handler) {
    this.handlers.set(method, [...(this.handlers.get(method) || []), handler]);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const result = await client.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Browser evaluation failed");
  return result.result.value;
}

async function waitFor(client, expression, message, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, `Boolean(${expression})`)) return;
    await delay(80);
  }
  throw new Error(`Timed out: ${message}`);
}

async function setValue(client, selector, value) {
  const changed = await evaluate(client, `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.focus();
    return true;
  })()`);
  assert.equal(changed, true, `Could not find field ${selector}`);
}

async function clickText(client, text, scope = ".chat-message") {
  const clicked = await evaluate(client, `(() => {
    const buttons = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})];
    const button = buttons.find((item) => !item.disabled && item.innerText.includes(${JSON.stringify(text)}));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  assert.equal(clicked, true, `Could not click ${text}`);
}

async function viewportCheck(client, width, height = 900) {
  await client.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height });
  await delay(80);
  const result = await evaluate(client, `(() => {
    const shell = document.querySelector(".phone-shell");
    const task = [...document.querySelectorAll(".chat-message.task-prompt")].at(-1);
    const input = document.querySelector(".chat-compose input");
    const footer = document.querySelector(".chat-footer");
    const shellRect = shell?.getBoundingClientRect();
    const taskRect = task?.getBoundingClientRect();
    const inputRect = input?.getBoundingClientRect();
    const footerRect = footer?.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      noDocumentOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      shellFits: Boolean(shellRect && shellRect.left >= -0.5 && shellRect.right <= window.innerWidth + 0.5),
      taskFits: Boolean(taskRect && taskRect.left >= -0.5 && taskRect.right <= window.innerWidth + 0.5),
      inputVisible: Boolean(inputRect && inputRect.top >= 0 && inputRect.bottom <= window.innerHeight),
      footerVisible: Boolean(footerRect && footerRect.top >= 0 && footerRect.bottom <= window.innerHeight + 0.5)
    };
  })()`);
  assert.equal(result.innerWidth, width, `${width}px viewport was not applied`);
  assert.equal(result.noDocumentOverflow, true, `${width}px document overflows horizontally`);
  assert.equal(result.shellFits, true, `${width}px phone shell overflows`);
  assert.equal(result.taskFits, true, `${width}px task card overflows`);
  assert.equal(result.inputVisible, true, `${width}px active input is not visible`);
  assert.equal(result.footerVisible, true, `${width}px footer is not fully visible`);
}

async function runBrowserJourney(baseUrl, chromePath, phones) {
  const debugPort = await freePort();
  const profileDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "khurrum-ui-chrome-"));
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-allow-origins=*",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDirectory}`,
    "--window-size=1280,900",
    "about:blank"
  ], { stdio: "ignore" });
  let client;
  let delayNextRequest = false;
  const chatRequests = [];
  const browserErrors = [];
  try {
    await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`);
    const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(`${baseUrl}/patient-chat`)}`, { method: "PUT" }).then((response) => response.json());
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.open();
    client.on("Runtime.exceptionThrown", (event) => browserErrors.push(event.exceptionDetails?.text || "Runtime exception"));
    client.on("Runtime.consoleAPICalled", (event) => {
      if (event.type === "error") browserErrors.push(event.args?.map((item) => item.value || item.description).join(" ") || "Console error");
    });
    client.on("Fetch.requestPaused", (event) => {
      (async () => {
        if (event.request.url.includes("/api/public/chat/message")) {
          try {
            chatRequests.push(JSON.parse(event.request.postData || "{}"));
          } catch {}
        }
        if (delayNextRequest) {
          delayNextRequest = false;
          await delay(350);
        }
        await client.send("Fetch.continueRequest", { requestId: event.requestId });
      })().catch((error) => browserErrors.push(error.message));
    });
    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/public/chat/message", requestStage: "Request" }] })
    ]);
    await waitFor(client, `document.readyState === "complete" && document.querySelector(".phone-shell")`, "patient chat to load");

    assert.equal(await evaluate(client, "document.documentElement.scrollWidth <= window.innerWidth"), true, "desktop page overflows horizontally");
    await client.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 900, deviceScaleFactor: 1, mobile: true, screenWidth: 412, screenHeight: 900 });
    await setValue(client, ".session-phone-field input", phones[0]);
    await clickText(client, "English");
    await waitFor(client, `[...document.querySelectorAll(".chat-message button")].some((button) => button.innerText.includes("Book Appointment"))`, "English main menu");
    assert.equal((await evaluate(client, "document.body.innerText")).includes("language_english"), false, "internal language ID is visible");
    await clickText(client, "Book Appointment");
    await waitFor(client, `[...document.querySelectorAll(".chat-message button")].some((button) => button.innerText.includes("I Agree"))`, "consent card");
    assert.equal((await evaluate(client, "document.body.innerText")).includes("consent_accept"), false, "internal consent ID is visible");
    assert.equal(await evaluate(client, `document.querySelectorAll(".chat-options .primary-choice").length`), 1, "consent has more than one primary action");
    assert.equal(await evaluate(client, `document.querySelectorAll(".consent-card").length`), 1, "consent card was duplicated");

    const requestsBeforeConsent = chatRequests.length;
    delayNextRequest = true;
    const doubleClick = await evaluate(client, `(() => {
      const button = [...document.querySelectorAll(".chat-message button")].find((item) => item.innerText.includes("I Agree"));
      if (!button) return false;
      button.click();
      button.click();
      return true;
    })()`);
    assert.equal(doubleClick, true, "Consent button was not available");
    await waitFor(client, `document.querySelector(".chat-thread")?.getAttribute("aria-busy") === "true"`, "loading state after consent selection");
    assert.equal(await evaluate(client, `Boolean(document.querySelector(".chat-options button.selected"))`), true, "selected consent state was not visible while saving");
    await waitFor(client, `document.querySelector('[placeholder="Enter patient’s full name…"]')`, "conversational patient-name input");
    await delay(120);
    assert.equal(await evaluate(client, `document.activeElement?.getAttribute("placeholder") === "Enter patient’s full name…"`), true, "patient-name input did not receive focus");
    assert.equal(await evaluate(client, `document.querySelector(".chat-compose .send-button")?.disabled`), true, "empty name can be sent");
    assert.equal(await evaluate(client, `[...document.querySelectorAll(".chat-message.patient")].filter((item) => item.innerText.includes("I Agree")).length`), 1, "double click sent consent twice");
    assert.equal(await evaluate(client, `document.querySelectorAll(".completed-choice-summary").length`), 0, "standalone Selected card is visible");
    assert.equal(await evaluate(client, `[...document.querySelectorAll(".consent-card button")].every((item) => item.disabled)`), true, "consent options did not stay disabled");
    assert.equal(await evaluate(client, `[...document.querySelectorAll(".chat-message.bot")].filter((item) => item.innerText.includes("What is the patient’s full name?")).length`), 1, "patient-name prompt was duplicated");
    assert.equal(chatRequests.slice(requestsBeforeConsent).filter((item) => item.actionId === "consent_accept").length, 1, "double click created duplicate consent API requests");
    assert.equal(chatRequests.at(-1)?.messageType, "poll_selection", "consent was not sent as a poll selection");
    assert.ok(chatRequests.at(-1)?.interactionId, "consent interaction ID is missing");
    assert.equal(await evaluate(client, `[...document.querySelectorAll(".chat-options button")].some((item) => item.innerText.trim() === "Main Menu")`), false, "Main Menu is rendered as a large choice");

    for (const width of [412, 375, 320]) await viewportCheck(client, width);
    await client.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 900, deviceScaleFactor: 1, mobile: true, screenWidth: 412, screenHeight: 900 });

    await setValue(client, '[placeholder="Enter patient’s full name…"]', "<script>alert(1)</script>");
    await evaluate(client, `document.querySelector(".chat-compose .send-button")?.click()`);
    await waitFor(client, `document.querySelector(".inline-field-error")?.innerText.includes("valid full name")`, "unsafe-name validation message");
    await setValue(client, '[placeholder="Enter patient’s full name…"]', "12345");
    await evaluate(client, `document.querySelector(".chat-compose .send-button")?.click()`);
    await waitFor(client, `document.querySelector(".inline-field-error")?.innerText.includes("valid full name")`, "inline invalid-name message");
    await setValue(client, '[placeholder="Enter patient’s full name…"]', "Abdullah Khan");
    await waitFor(client, `document.querySelector(".chat-compose .send-button")?.disabled === false`, "valid name to enable Send");
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await client.send("Input.dispatchKeyEvent", { type: "char", key: "Enter", code: "Enter", text: "\r", unmodifiedText: "\r" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitFor(client, `document.querySelector('[placeholder="Enter patient’s phone number…"]')`, "contact-information input");
    assert.equal(await evaluate(client, `[...document.querySelectorAll(".chat-message.patient")].filter((item) => item.innerText.includes("Abdullah Khan")).length`), 1, "patient name bubble was duplicated");
    assert.equal(await evaluate(client, `document.querySelectorAll(".focused-task-form").length`), 0, "embedded patient form is still rendered");

    await clickText(client, "Back", ".chat-message");
    await waitFor(client, `document.querySelector('[placeholder="Enter patient’s full name…"]')?.value === "Abdullah Khan"`, "Back to prefilled name");
    await evaluate(client, `document.querySelector(".chat-compose .send-button")?.click()`);
    await waitFor(client, `document.querySelector('[placeholder="Enter patient’s phone number…"]')`, "contact field after Back");

    await evaluate(client, `location.reload()`);
    await waitFor(client, `document.readyState === "complete" && document.querySelector('[placeholder="Enter patient’s phone number…"]')`, "persisted phone step after refresh");
    assert.equal(await evaluate(client, `document.querySelectorAll(".chat-message.bot").length`), 1, "resume seeded duplicate bot messages");
    assert.equal(await evaluate(client, `document.body.innerText.includes("phone number")`), true, "refreshed session did not restore the phone step");
    assert.equal(await evaluate(client, `document.querySelector('[placeholder="Enter patient’s phone number…"]')?.value === ${JSON.stringify(phones[0])}`), true, "booking phone was not prefilled after refresh");
    await evaluate(client, `document.querySelector(".chat-compose .send-button")?.click()`);

    await waitFor(client, `document.querySelector('[placeholder="Enter patient’s age…"]')`, "age input");
    await setValue(client, '[placeholder="Enter patient’s age…"]', "30");
    await evaluate(client, `document.querySelector(".chat-compose .send-button")?.click()`);
    await waitFor(client, `[...document.querySelectorAll(".chat-message button")].some((button) => button.innerText.trim().startsWith("Female"))`, "gender choices");
    await clickText(client, "Female");
    await waitFor(client, `document.querySelector('[placeholder="Enter city…"]')`, "city input");
    await setValue(client, '[placeholder="Enter city…"]', "Jhang");
    await evaluate(client, `document.querySelector(".chat-compose .send-button")?.click()`);
    await waitFor(client, `document.querySelector('[placeholder="Describe the concern…"]')`, "reason input");
    await setValue(client, '[placeholder="Describe the concern…"]', "FEVER");
    await evaluate(client, `document.querySelector(".chat-compose .send-button")?.click()`);
    await waitFor(client, `document.body.innerText.includes("Reason Recorded") && [...document.querySelectorAll(".chat-message button")].some((button) => button.innerText.includes("Nighat Medical Complex"))`, "FEVER to continue to clinic");
    const feverText = await evaluate(client, "document.body.innerText");
    assert.equal(/medicine|medication|diagnos|nearest hospital emergency/i.test(feverText), false, "FEVER produced medical or emergency guidance");
    await clickText(client, "Nighat Medical Complex");
    await waitFor(client, `document.querySelector(".date-options button")`, "date choices");
    assert.equal(await evaluate(client, `(() => { const button = document.querySelector(".date-options button:not(:disabled)"); if (!button) return false; button.click(); return true; })()`), true, "available date could not be selected");
    await waitFor(client, `document.querySelector(".time-options button")`, "time choices");
    await evaluate(client, `document.querySelector(".time-options button:not(:disabled)")?.click()`);
    await waitFor(client, `document.body.innerText.includes("Please confirm appointment") && document.body.innerText.includes("Token:")`, "appointment summary with token");
    assert.equal((await evaluate(client, "document.body.innerText")).includes("slot_"), false, "internal slot ID is visible");
    await clickText(client, "Confirm Appointment");
    await waitFor(client, `document.body.innerText.includes("Appointment Confirmed")`, "appointment confirmation", 20000);
    const appointmentId = await evaluate(client, `(() => {
      const confirmation = [...document.querySelectorAll(".chat-message.bot.success")].at(-1)?.innerText || "";
      return confirmation.match(/KHR-\\d{8}-[A-Z0-9]+/)?.[0] || "";
    })()`);
    assert.match(appointmentId, /^KHR-\d{8}-[A-Z0-9]+$/, "appointment ID is missing from the confirmation");
    assert.equal(await evaluate(client, `[...document.querySelectorAll(".chat-message.bot.success")].at(-1)?.innerText.includes("Save this ID")`), true, "appointment ID saving guidance is missing");

    const screenshot = await client.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const screenshotPath = path.join(os.tmpdir(), "khurrum-patient-ux-412.png");
    fs.writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));

    await clickText(client, "Check Appointment");
    await waitFor(client, `document.querySelector('[placeholder="Enter appointment reference…"]')`, "appointment ID lookup input");
    await setValue(client, '[placeholder="Enter appointment reference…"]', appointmentId);
    await evaluate(client, `document.querySelector(".chat-compose .send-button")?.click()`);
    await waitFor(client, `document.querySelector('[placeholder="Enter booking phone number…"]')`, "lookup phone input");
    await setValue(client, '[placeholder="Enter booking phone number…"]', phones[0]);
    await evaluate(client, `document.querySelector(".chat-compose .send-button")?.click()`);
    await waitFor(client, `document.body.innerText.includes("Your appointment details:") && document.body.innerText.includes(${JSON.stringify(appointmentId)}) && document.body.innerText.includes("Status: Booked")`, "successful appointment lookup with displayed ID");

    await evaluate(client, `localStorage.clear(); location.href = ${JSON.stringify(`${baseUrl}/patient-chat?urdu-check=1`)}`);
    await waitFor(client, `document.readyState === "complete" && document.querySelector(".session-phone-field input")`, "Urdu test reload");
    await setValue(client, ".session-phone-field input", phones[1]);
    await clickText(client, "اردو");
    await waitFor(client, `document.documentElement.dir === "rtl" && document.body.innerText.includes("اپائنٹمنٹ بک کریں")`, "Urdu menu and RTL layout");
    await clickText(client, "اپائنٹمنٹ بک کریں");
    await waitFor(client, `[...document.querySelectorAll(".chat-message button")].some((button) => button.innerText.includes("میں متفق ہوں"))`, "Urdu consent choices");
    await clickText(client, "میں متفق ہوں");
    await waitFor(client, `document.querySelector('[placeholder="مریض کا مکمل نام لکھیں…"]')`, "Urdu patient-name input");
    await delay(120);
    assert.equal(await evaluate(client, `document.activeElement?.getAttribute("placeholder") === "مریض کا مکمل نام لکھیں…"`), true, "Urdu name input did not receive focus");
    await viewportCheck(client, 375);
    assert.deepEqual(browserErrors, [], `Browser console errors: ${browserErrors.join(" | ")}`);

    return { screenshotPath };
  } catch (error) {
    if (client) {
      const body = await evaluate(client, "document.body.innerText").catch(() => "Browser body unavailable");
      console.error("Patient UI state at failure:\n", String(body).slice(-3000));
    }
    throw error;
  } finally {
    client?.close();
    chrome.kill();
    await delay(200);
    try {
      fs.rmSync(profileDirectory, { recursive: true, force: true });
    } catch {}
  }
}

async function cleanupQaData(phones) {
  const { connectDatabase, disconnectDatabase } = await import("../server/db/connection.js");
  const { models } = await import("../server/models/index.js");
  await connectDatabase();
  const appointments = await models.Appointment.find({ normalizedPhone: { $in: phones } }).select("appointmentId patientId").lean();
  const appointmentIds = appointments.map((item) => item.appointmentId);
  const patientIds = appointments.map((item) => item.patientId);
  const clinic = await models.ClinicLocation.findOne({ slug: "nighat-medical-complex-jhang" }).select("locationId").lean();
  await Promise.all([
    models.Appointment.deleteMany({ normalizedPhone: { $in: phones } }),
    models.Patient.deleteMany({ $or: [{ patientId: { $in: patientIds } }, { normalizedPhone: { $in: phones } }] }),
    models.ChatSession.deleteMany({ normalizedPhone: { $in: phones } }),
    models.WhatsAppConsent.deleteMany({ normalizedPhone: { $in: phones } }),
    models.AuditLog.deleteMany({ targetId: { $in: appointmentIds } })
  ]);
  if (clinic?.locationId) {
    await models.ScheduleRule.deleteMany({ locationId: clinic.locationId });
    await models.ClinicLocation.deleteMany({ locationId: clinic.locationId });
  }
  await models.DoctorProfile.deleteMany({ profileKey: "primary" });
  await disconnectDatabase();
}

async function run() {
  const chromePath = findChrome();
  assert.ok(chromePath, "Chrome or Chromium was not found. Set CHROME_PATH to run the patient UI check.");
  assert.ok(fs.existsSync(path.resolve("dist/index.html")), "Run npm run build before the patient UI check.");
  const disposableMongo = await acquireDisposableTestMongo({ databaseName: "khurrum_patient_ui_test" });
  const { uri, databaseName } = disposableMongo;

  process.env.MONGODB_URI = uri;
  process.env.NODE_ENV = "development";
  const suffix = Date.now().toString().slice(-8);
  const phones = [`+9230${suffix}`, `+9231${suffix}`];
  let server;
  const serverOutput = [];
  try {
    const { setupClinic } = await import("./setup-clinic.js");
    const { disconnectDatabase } = await import("../server/db/connection.js");
    await setupClinic();
    await disconnectDatabase();

    const port = await freePort();
    server = spawn(process.execPath, ["server/index.js"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), MONGODB_URI: uri, NODE_ENV: "development" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout.on("data", (chunk) => serverOutput.push(chunk.toString()));
    server.stderr.on("data", (chunk) => serverOutput.push(chunk.toString()));
    await waitForHttp(`http://127.0.0.1:${port}/api/health`, 60000);
    const result = await runBrowserJourney(`http://127.0.0.1:${port}`, chromePath, phones);
    console.log("Patient UI browser checks passed", {
      database: databaseName,
      desktop: true,
      mobileViewports: [412, 375, 320],
      conversationalNameInput: true,
      validationAndEnterSubmit: true,
      doubleSubmitProtection: true,
      duplicateApiRequestProtection: true,
      loadingAndSelectedStates: true,
      noStandaloneSelectedCard: true,
      refreshRestoresPersistedStep: true,
      unsafeInputRejected: true,
      backPreservesValue: true,
      internalIdsHidden: true,
      fullEnglishBooking: true,
      appointmentIdDisplayed: true,
      appointmentLookupWithDisplayedId: true,
      feverContinues: true,
      urduRtl: true,
      consoleErrors: 0,
      screenshot: result.screenshotPath
    });
  } catch (error) {
    if (serverOutput.length) {
      const safeOutput = serverOutput.join("").replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[redacted MongoDB URI]");
      console.error("Patient UI test server output:\n", safeOutput.slice(-4000));
    }
    throw error;
  } finally {
    if (server && !server.killed) server.kill();
    await delay(300);
    await cleanupQaData(phones).catch((error) => console.error("Patient UI cleanup failed:", error.message));
    await disposableMongo.stop();
  }
}

run().catch((error) => {
  console.error("Patient UI browser checks failed:", error.message);
  process.exitCode = 1;
});
