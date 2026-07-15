import { compactText } from "../utils/time.js";

const EMERGENCY_RULES = [
  { id: "heavy_vaginal_bleeding", pattern: /\bheavy\s+vaginal\s+bleeding\b/i },
  { id: "uncontrolled_bleeding", pattern: /\buncontrolled\s+bleeding\b/i },
  { id: "loss_of_consciousness", pattern: /\b(loss|lost)\s+of\s+consciousness\b|\bunconscious\b/i },
  { id: "fainting_heavy_bleeding", all: [/\bfaint(?:ing|ed)?\b/i, /\bheavy\s+bleeding\b/i] },
  { id: "seizure", pattern: /\bseizures?\b|\bconvulsions?\b/i },
  { id: "cannot_breathe", pattern: /\b(cannot|can't|unable\s+to)\s+breathe\b/i },
  { id: "severe_breathing_difficulty", pattern: /\bsevere\s+(breathing\s+difficulty|difficulty\s+breathing|shortness\s+of\s+breath)\b/i },
  { id: "severe_chest_pain", pattern: /\bsevere\s+chest\s+pain\b/i },
  { id: "severe_abdominal_pain_with_bleeding", all: [/\bsevere\s+(abdominal|pelvic|stomach)\s+pain\b/i, /\bheavy\s+bleeding\b/i] },
  { id: "pregnancy_bleeding_fainting", all: [/\bpregnan(?:t|cy)\b/i, /\bheavy\s+bleeding\b/i, /\bfaint(?:ing|ed)?\b/i] },
  { id: "rapidly_worsening_life_threatening", all: [/\brapidly\s+(worsening|getting\s+worse)\b/i, /\blife[- ]threatening\b/i] },
  { id: "explicit_life_threatening_emergency", pattern: /\blife[- ]threatening\s+(condition|emergency)\b|\bmedical\s+emergency\b/i },
  { id: "urdu_heavy_bleeding", pattern: /بہت\s+زیادہ.*خون|شدید.*خون.*آنا/u },
  { id: "urdu_unconscious", pattern: /بے\s*ہوشی|ہوش\s+کھو/u },
  { id: "urdu_cannot_breathe", pattern: /سانس.*نہیں.*آ|سانس.*شدید.*دشواری/u },
  { id: "urdu_seizure", pattern: /دور[ہ|ے].*پڑ/u }
];

const ATTENTION_RULES = [
  { id: "bleeding_without_emergency_context", pattern: /\bbleeding\b|خون/u },
  { id: "severe_non_specific_pain", pattern: /\bsevere\s+pain\b|شدید\s+درد/u },
  { id: "persistent_vomiting", pattern: /\bpersistent\s+vomiting\b|مسلسل\s+الٹی/u }
];

function matchesRule(text, rule) {
  if (rule.pattern) return rule.pattern.test(text);
  return rule.all?.every((pattern) => pattern.test(text));
}

export function classifyEmergencyReason(input = "") {
  const text = compactText(input, 500);
  const emergencyMatches = EMERGENCY_RULES.filter((rule) => matchesRule(text, rule)).map((rule) => rule.id);
  if (emergencyMatches.length) {
    return { category: "emergency", isEmergency: true, matchedRules: emergencyMatches };
  }

  const attentionMatches = ATTENTION_RULES.filter((rule) => matchesRule(text, rule)).map((rule) => rule.id);
  if (attentionMatches.length) {
    return { category: "needs_attention", isEmergency: false, matchedRules: attentionMatches };
  }

  return { category: "routine", isEmergency: false, matchedRules: [] };
}
