import { Router } from "express";
import { SYSTEM_COPY } from "../config/clinic.js";
import { getDoctorProfile, listLocations, listSchedules } from "../services/clinicConfigService.js";
import { getAvailability, getUpcomingAvailableDates } from "../services/slotService.js";
import { handleChatMessage, resumeChatSession } from "../services/chatbotService.js";
import { dateSchema } from "../utils/validation.js";

const router = Router();

router.get("/info", async (_req, res, next) => {
  try {
    res.json({
      product: SYSTEM_COPY,
      doctor: await getDoctorProfile(),
      locations: await listLocations({ activeOnly: true }),
      schedules: await listSchedules()
    });
  } catch (error) {
    next(error);
  }
});

router.get("/locations", async (_req, res, next) => {
  try {
    res.json({ locations: await listLocations({ activeOnly: true }) });
  } catch (error) {
    next(error);
  }
});

router.get("/slots/dates", async (req, res, next) => {
  try {
    const dates = await getUpcomingAvailableDates(String(req.query.locationId || ""), Number(req.query.count || 6));
    res.json({ dates });
  } catch (error) {
    next(error);
  }
});

router.get("/slots", async (req, res, next) => {
  try {
    const date = dateSchema.parse(req.query.date);
    const locationId = String(req.query.locationId || "");
    const availability = await getAvailability({ locationId, date });
    res.json(availability);
  } catch (error) {
    next(error);
  }
});

router.post("/chat/message", async (req, res, next) => {
  try {
    const reply = await handleChatMessage(req.body, { includeErrors: process.env.NODE_ENV !== "production" });
    res.json({ reply });
  } catch (error) {
    next(error);
  }
});

router.post("/chat/resume", async (req, res, next) => {
  try {
    const reply = await resumeChatSession(req.body);
    res.json({ reply });
  } catch (error) {
    next(error);
  }
});

export default router;
