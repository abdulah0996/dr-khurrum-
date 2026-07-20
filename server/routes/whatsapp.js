import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { handleChatMessage } from "../services/chatbotService.js";
import {
  getWhatsAppStatus,
  completeWebhookEvent,
  failWebhookEvent,
  isOptOutMessage,
  listMessageLogs,
  logMessage,
  markOptOut,
  recordWebhookEvent,
  sendWhatsAppText,
  updateMessageStatus,
  upsertInboundConsent,
  verifyMetaSignature
} from "../services/whatsappService.js";
import { compactText, normalizePhone } from "../utils/time.js";
import { chatMessageSchema } from "../utils/validation.js";
import { DOCTOR } from "../config/clinic.js";
import { parseIncomingMessage } from "../services/interactiveMessageService.js";

const router = Router();

router.get("/status", authenticate, (_req, res) => {
  res.json({ whatsapp: getWhatsAppStatus() });
});

router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"] || req.query["hub_mode"];
  const token = req.query["hub.verify_token"] || req.query["hub_verify_token"];
  const challenge = req.query["hub.challenge"] || req.query["hub_challenge"];

  if (mode === "subscribe" && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

function detectLanguage(text = "") {
  return /[\u0600-\u06FF]/.test(text) ? "ur" : "en";
}

function optOutConfirmation(language = "en") {
  const contact = DOCTOR.contact
    ? language === "ur" ? ` ریسیپشن رابطہ: \u2066${DOCTOR.contact}\u2069` : ` Reception contact: ${DOCTOR.contact}.`
    : "";
  return language === "ur"
    ? `آپ کو غیر ضروری WhatsApp پیغامات نہیں بھیجے جائیں گے۔${contact}`
    : `You will not receive non-essential WhatsApp messages.${contact}`;
}

export function extractIncomingText(message = {}) {
  return compactText(parseIncomingMessage(message).text, 1000);
}

export async function processWebhookPayload(payload) {
  const entries = payload?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};

      for (const status of value.statuses || []) {
        await updateMessageStatus(status.id, status.status);
      }

      for (const message of value.messages || []) {
        const event = await recordWebhookEvent(message.id, message.type || "message");
        if (!event.accepted) {
          continue;
        }
        try {
          const rawFrom = message.from;
          const phone = normalizePhone(rawFrom);
          const text = extractIncomingText(message);
          if (!/^\+\d{10,15}$/.test(phone) || !text) {
            await completeWebhookEvent(message.id);
            continue;
          }
          const language = detectLanguage(text);

          await logMessage({
            phone,
            messageType: "patient_message",
            messageBody: text,
            direction: "Incoming",
            status: "received",
            providerMessageId: message.id
          });

          if (isOptOutMessage(text)) {
            await markOptOut({ phone, language });
            const sent = await sendWhatsAppText({
              to: phone,
              text: optOutConfirmation(language),
              messageType: "opt_out_confirmation",
              language,
              operational: true,
              ignoreOptOut: true,
              patientInitiated: true
            });
            if (!sent.sent) throw new Error("WhatsApp opt-out confirmation was not delivered.");
          } else {
            await upsertInboundConsent({ phone, language, text });
            const reply = await handleChatMessage({ phone, message: text, interactionId: message.id });
            const sent = await sendWhatsAppText({
              to: phone,
              text: reply.text,
              messageType: "chatbot_reply",
              appointmentId: reply.appointment?.appointmentId || "",
              language,
              options: reply.options || [],
              patientInitiated: true
            });
            if (!sent.sent) throw new Error("WhatsApp chatbot reply was not delivered.");
          }
          await completeWebhookEvent(message.id);
        } catch (error) {
          await failWebhookEvent(message.id, error);
          throw error;
        }
      }
    }
  }
}

router.post("/webhook", async (req, res, next) => {
  try {
    if (process.env.NODE_ENV === "production" || process.env.META_APP_SECRET) {
      const isSignatureValid = verifyMetaSignature(req);
      if (!isSignatureValid) {
        return res.status(403).json({ message: "Invalid Meta signature." });
      }
    }

    await processWebhookPayload(req.body);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

router.get("/logs", authenticate, async (req, res, next) => {
  try {
    res.json({ messageLogs: await listMessageLogs(req.query.limit) });
  } catch (error) {
    next(error);
  }
});

router.post("/send", authenticate, async (req, res, next) => {
  try {
    const parsed = chatMessageSchema.parse({ phone: req.body.phone, message: req.body.message || req.body.text || "", language: req.body.language || "en" });
    const result = await sendWhatsAppText({
      to: parsed.phone,
      text: parsed.message,
      messageType: "manual_message",
      actor: req.user || null,
      language: parsed.language || "en"
    });
    res.json({ whatsapp: result });
  } catch (error) {
    next(error);
  }
});

export default router;
