import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const styles = fs.readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const packageJson = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("patient choices display human labels while stable IDs remain transport-only", () => {
  assert.match(app, /consent_accept:\s*"I Agree"/);
  assert.match(app, /consent_reject:\s*"I Do Not Agree"/);
  assert.match(app, /booking_confirm:\s*"Confirm Appointment"/);
  assert.match(app, /text:\s*meta\.displayText \|\| message/);
  assert.match(app, /humanOptionLabel\(item, language\)/);
  assert.match(app, /actionId:\s*item\.value/);
  assert.match(app, /messageType:\s*"poll_selection"/);
  assert.match(app, /interactionIdsRef\.current/);
  assert.doesNotMatch(app, /addMessage\(\{ from: "patient", text: message \}\)/);
});

test("patient-name entry uses the normal dynamic chat composer with frontend validation", () => {
  assert.match(app, /placeholder:\s*urdu \? "مریض کا مکمل نام لکھیں…" : "Enter patient’s full name…"/);
  assert.match(app, /Patient name is required/);
  assert.match(app, /Please enter a valid full name/);
  assert.match(app, /composeInputRef\.current\?\.focus\(\)/);
  assert.match(app, /className="chat-compose"/);
  assert.match(app, /latestBotMessage\?\.inputConfig\?\.placeholder/);
  assert.match(app, /onSubmit=\{activeTask \? submitTask/);
  assert.doesNotMatch(app, /<form className="focused-task-form"/);
});

test("navigation, scrolling, refresh recovery, and duplicate-submit controls preserve conversation hierarchy", () => {
  assert.match(app, /CHAT_NAVIGATION_ACTIONS = new Set\(\["navigation_back", "main_menu"\]\)/);
  assert.match(app, /className="task-back-button message-back"/);
  assert.match(app, /className="chat-header-back"/);
  assert.match(app, /className="chat-menu-button"/);
  assert.match(app, /if \(sendingRef\.current\) return false/);
  assert.match(app, /submittedValues\[activeTask\.key\]/);
  assert.match(app, /messagesEndRef\.current\?\.scrollIntoView/);
  assert.match(app, /fetch\("\/api\/public\/chat\/resume"/);
  assert.doesNotMatch(app, /className="completed-choice-summary"/);
});

test("mobile, RTL, focus, safe-area, and reduced-motion rules are present", () => {
  assert.match(styles, /@media \(max-width: 340px\)/);
  assert.match(styles, /height:\s*100dvh/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /html\[dir="rtl"\] \.task-back-button/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(styles, /min-height:\s*48px/);
  assert.match(styles, /\.chat-message\.bot\.consent-card/);
  assert.match(styles, /\.chat-footer/);
  assert.match(styles, /\.chat-privacy/);
  assert.match(app, /className="attachment-button"/);
});

test("the real-browser patient UI script is available as an explicit guarded check", () => {
  assert.equal(packageJson.scripts["test:patient-ui"], "npm run build && node scripts/patient-ui-check.js");
  assert.equal(packageJson.scripts["test:browser"], "npm run test:patient-ui");
  const script = fs.readFileSync(new URL("../scripts/patient-ui-check.js", import.meta.url), "utf8");
  assert.match(script, /acquireDisposableTestMongo/);
  const databaseHarness = fs.readFileSync(new URL("../scripts/lib/test-mongodb.js", import.meta.url), "utf8");
  assert.match(databaseHarness, /must end with _test/);
  assert.match(script, /mobileViewports: \[412, 375, 320\]/);
  assert.match(script, /fullEnglishBooking: true/);
  assert.match(script, /urduRtl: true/);
});
