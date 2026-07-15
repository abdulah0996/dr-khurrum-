import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTIONS,
  buildInteractiveContent,
  buildTextFallback,
  normalizeChatAction,
  parseIncomingMessage
} from "../server/services/interactiveMessageService.js";
import { classifyEmergencyReason } from "../server/services/emergencyClassificationService.js";
import { buildWhatsAppPayload } from "../server/services/whatsappService.js";
import { generateScheduleSlots, resolveScheduleForDate } from "../server/services/slotService.js";
import { blockedSlotSchema, scheduleSchema, specialScheduleSchema } from "../server/utils/validation.js";

const baseSchedule = {
  active: true,
  timezone: "Asia/Karachi",
  workingDays: ["Monday"],
  openingTime: "09:00",
  closingTime: "12:00",
  slotDurationMinutes: 30,
  dailyLimit: 20,
  dayRules: [
    {
      day: "Monday",
      working: true,
      openingTime: "09:00",
      closingTime: "12:00",
      slotDurationMinutes: 30,
      dailyLimit: 10,
      breaks: [
        { breakId: "first", startTime: "10:00", endTime: "10:30" },
        { breakId: "second", startTime: "11:00", endTime: "11:30" }
      ]
    }
  ]
};

test("stable WhatsApp action IDs take precedence over translated titles", () => {
  const parsed = parseIncomingMessage({ interactive: { button_reply: { id: ACTIONS.book, title: "اپائنٹمنٹ بک کریں" } } });
  assert.equal(parsed.actionId, ACTIONS.book);
  assert.equal(parsed.text, ACTIONS.book);
  assert.equal(normalizeChatAction(ACTIONS.book), "1");
  assert.equal(normalizeChatAction("location:LOC-QA"), "LOC-QA");
  assert.equal(normalizeChatAction("date:2026-07-20"), "2026-07-20");
  assert.equal(normalizeChatAction("time:10:30"), "10:30");
  assert.equal(normalizeChatAction("clinic_LOC-QA"), "LOC-QA");
  assert.equal(normalizeChatAction("date_2026-07-20"), "2026-07-20");
  assert.equal(normalizeChatAction("slot_2026-07-20_10-30"), "10:30");
  assert.equal(normalizeChatAction(ACTIONS.back), "back");
  assert.equal(normalizeChatAction(ACTIONS.slotsMore), "slots_more");
  assert.equal(normalizeChatAction(ACTIONS.slotsPrevious), "slots_previous");
});

test("WhatsApp payloads use reply buttons for three choices and a list for larger menus", () => {
  const buttonOptions = [
    { label: "Male", value: ACTIONS.genderMale },
    { label: "Female", value: ACTIONS.genderFemale },
    { label: "Other", value: ACTIONS.genderOther }
  ];
  const content = buildInteractiveContent({ text: "Choose", options: buttonOptions });
  assert.equal(content.type, "button");
  assert.equal(content.action.buttons[0].reply.id, ACTIONS.genderMale);

  const menu = Array.from({ length: 9 }, (_, index) => ({ label: `Option ${index + 1}`, value: `action_${index + 1}` }));
  const payload = buildWhatsAppPayload({ normalizedPhone: "+923001234567", text: "Menu", options: menu, language: "en" });
  assert.equal(payload.type, "interactive");
  assert.equal(payload.interactive.type, "list");
  assert.equal(payload.interactive.action.sections[0].rows.length, 9);
  assert.doesNotMatch(payload.interactive.body.text, /1\. Option/);
  assert.match(buildTextFallback("Menu", menu), /1\. Option 1/);
});

test("routine symptoms never become emergencies without serious context", () => {
  const routineReasons = [
    "FEVER", "fever", "mild fever", "fever for two days", "headache", "back pain", "stomach pain", "weakness", "nausea",
    "vomiting", "infection", "irregular periods", "pregnancy checkup", "routine checkup", "follow-up", "general consultation",
    "abdominal discomfort", "menstrual problem"
  ];
  for (const reason of routineReasons) {
    assert.deepEqual(classifyEmergencyReason(reason), { category: "routine", isEmergency: false, matchedRules: [] });
  }
  assert.equal(classifyEmergencyReason("bleeding").category, "needs_attention");
  assert.equal(classifyEmergencyReason("pain").isEmergency, false);
  assert.equal(classifyEmergencyReason("pregnancy").isEmergency, false);
});

test("clear serious warning signs trigger emergency classification", () => {
  const emergencies = [
    "heavy vaginal bleeding",
    "cannot breathe",
    "loss of consciousness",
    "seizure",
    "severe chest pain",
    "pregnancy with heavy bleeding and fainting",
    "severe abdominal pain with heavy bleeding",
    "rapidly worsening life-threatening condition"
  ];
  for (const reason of emergencies) {
    const result = classifyEmergencyReason(reason);
    assert.equal(result.category, "emergency", reason);
    assert.equal(result.isEmergency, true, reason);
    assert.ok(result.matchedRules.length > 0, reason);
  }
});

test("weekday schedules support multiple breaks and special dates override closed weekends", () => {
  const monday = resolveScheduleForDate(baseSchedule, "2026-07-20");
  assert.deepEqual(generateScheduleSlots(monday, "2026-07-20"), ["09:00", "09:30", "10:30", "11:30"]);

  const saturday = resolveScheduleForDate(baseSchedule, "2026-07-18");
  assert.equal(generateScheduleSlots(saturday, "2026-07-18").length, 0);

  const special = resolveScheduleForDate(baseSchedule, "2026-07-18", {
    active: true,
    specialScheduleId: "SPC-QA",
    working: true,
    openingTime: "10:00",
    closingTime: "11:30",
    slotDurationMinutes: 30,
    dailyLimit: 3,
    breaks: []
  });
  assert.deepEqual(generateScheduleSlots(special, "2026-07-18"), ["10:00", "10:30", "11:00"]);
});

test("extended scheduling validation accepts ranges and rejects overlapping breaks", () => {
  assert.equal(blockedSlotSchema.safeParse({ locationId: "LOC-QA", date: "2026-07-20", dateEnd: "2026-07-22", fullDay: true, reason: "Doctor leave" }).success, true);
  assert.equal(blockedSlotSchema.safeParse({ locationId: "LOC-QA", date: "2026-07-22", dateEnd: "2026-07-20", fullDay: true, reason: "Doctor leave" }).success, false);

  const invalidRule = {
    workingDays: ["Monday"],
    openingTime: "09:00",
    closingTime: "17:00",
    slotDurationMinutes: 30,
    dailyLimit: 10,
    dayRules: [{ day: "Monday", working: true, openingTime: "09:00", closingTime: "17:00", slotDurationMinutes: 30, dailyLimit: 10, breaks: [
      { breakId: "a", startTime: "12:00", endTime: "13:30" },
      { breakId: "b", startTime: "13:00", endTime: "14:00" }
    ] }]
  };
  assert.equal(scheduleSchema.safeParse(invalidRule).success, false);
  assert.equal(specialScheduleSchema.safeParse({ locationId: "LOC-QA", date: "2026-07-20", working: false, openingTime: "09:00", closingTime: "17:00", slotDurationMinutes: 15, dailyLimit: 10, breaks: [] }).success, true);
});
