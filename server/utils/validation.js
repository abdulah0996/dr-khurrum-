import { z } from "zod";
import { APPOINTMENT_STATUSES, STAFF_ROLES } from "../config/clinic.js";
import { compactText, normalizePhone, toMinutes } from "./time.js";

const text = (max = 160) =>
  z
    .string()
    .trim()
    .transform((value) => compactText(value, max));

export function isValidPatientName(value = "") {
  const normalized = compactText(value, 100);
  if (normalized.length < 2 || normalized.length > 100) return false;
  return /^[\p{L}\p{M}][\p{L}\p{M}\s.'\u2019-]*$/u.test(normalized);
}

export const languageSchema = z.enum(["en", "ur"]).catch("en");

export const phoneSchema = z
  .string()
  .trim()
  .transform(normalizePhone)
  .refine((value) => /^\+\d{10,15}$/.test(value), "Please enter a valid phone number.");

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Please enter a valid date.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Please enter a valid date.");
export const timeSchema = z
  .string()
  .regex(/^\d{2}:\d{2}$/, "Please enter a valid time.")
  .refine((value) => toMinutes(value) !== null, "Please enter a valid time.");
export const objectIdSchema = z.string().trim().min(12).max(40);

export const appointmentCreateSchema = z
  .object({
    fullName: text(100).refine(isValidPatientName, "Please enter a valid patient name."),
    phone: phoneSchema,
    age: z.coerce.number().int().min(1).max(120),
    gender: z.enum(["Male", "Female", "Other"]),
    city: text(80).refine((value) => value.length >= 2, "City is required."),
    reasonForVisit: text(500).refine((value) => value.length >= 3, "Reason for visit is required."),
    locationId: z.string().trim().min(1).max(80),
    date: dateSchema,
    time: timeSchema,
    language: languageSchema.optional(),
    source: z.enum(["WhatsApp", "WhatsApp Cloud API", "Reception", "Patient Web Chat"]).optional(),
    consentAccepted: z.coerce.boolean().refine(Boolean, "Patient consent is required.")
  })
  .strict();

export const appointmentLookupSchema = z
  .object({
    appointmentId: z.string().trim().min(6).max(40),
    phone: phoneSchema
  })
  .strict();

export const appointmentRescheduleSchema = z
  .object({
    appointmentId: z.string().trim().min(6).max(40),
    phone: phoneSchema,
    locationId: z.string().trim().min(1).max(80),
    date: dateSchema,
    time: timeSchema,
    language: languageSchema.optional()
  })
  .strict();

export const appointmentCancelSchema = z
  .object({
    appointmentId: z.string().trim().min(6).max(40),
    phone: phoneSchema,
    reason: text(250).refine((value) => value.length >= 2, "Cancellation reason is required."),
    language: languageSchema.optional()
  })
  .strict();

export const adminStatusSchema = z
  .object({
    status: z.enum(APPOINTMENT_STATUSES),
    reason: text(250).optional()
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(1).max(256)
  })
  .strict();

export const passwordSchema = z
  .string()
  .min(12)
  .max(128)
  .regex(/[a-z]/, "Password must include a lowercase letter.")
  .regex(/[A-Z]/, "Password must include an uppercase letter.")
  .regex(/\d/, "Password must include a number.")
  .regex(/[^A-Za-z0-9]/, "Password must include a symbol.");

export const bootstrapSchema = z
  .object({
    token: z.string().min(16),
    name: text(100).refine((value) => value.length >= 2),
    email: z.string().trim().toLowerCase().email(),
    password: passwordSchema
  })
  .strict();

export const userCreateSchema = z
  .object({
    name: text(100).refine((value) => value.length >= 2),
    email: z.string().trim().toLowerCase().email(),
    password: passwordSchema,
    role: z.enum(STAFF_ROLES),
    status: z.enum(["Active", "Inactive"]).default("Active")
  })
  .strict();

export const userUpdateSchema = z
  .object({
    name: text(100).optional(),
    email: z.string().trim().toLowerCase().email().optional(),
    password: passwordSchema.optional(),
    role: z.enum(STAFF_ROLES).optional(),
    status: z.enum(["Active", "Inactive"]).optional()
  })
  .strict();

export const locationSchema = z
  .object({
    nameEn: text(120),
    nameUr: text(120),
    addressEn: text(250),
    addressUr: text(250),
    city: text(80),
    country: text(80).optional(),
    phone: text(40).optional(),
    googleMapLink: z.string().trim().url().or(z.literal("")).optional(),
    consultationMode: text(80).optional(),
    consultationFee: z.coerce.number().min(0).nullable().optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
    active: z.coerce.boolean().optional()
  })
  .strict();

const weekdays = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const scheduleBreakSchema = z
  .object({
    breakId: z.string().trim().min(1).max(80),
    startTime: timeSchema,
    endTime: timeSchema,
    labelEn: text(120).optional(),
    labelUr: text(120).optional()
  })
  .strict();

const dayRuleSchema = z
  .object({
    day: z.enum(weekdays),
    working: z.coerce.boolean(),
    openingTime: timeSchema,
    closingTime: timeSchema,
    slotDurationMinutes: z.coerce.number().int().min(5).max(120),
    dailyLimit: z.coerce.number().int().min(1).max(200),
    breaks: z.array(scheduleBreakSchema).max(8).default([])
  })
  .strict()
  .superRefine((rule, context) => {
    if (!rule.working) return;
    const opening = toMinutes(rule.openingTime);
    const closing = toMinutes(rule.closingTime);
    if (closing <= opening) {
      context.addIssue({ code: "custom", path: ["closingTime"], message: "Closing time must be after opening time." });
      return;
    }
    const sortedBreaks = [...rule.breaks].sort((left, right) => toMinutes(left.startTime) - toMinutes(right.startTime));
    sortedBreaks.forEach((item, index) => {
      const start = toMinutes(item.startTime);
      const end = toMinutes(item.endTime);
      if (end <= start || start < opening || end > closing) {
        context.addIssue({ code: "custom", path: ["breaks", index], message: "Break must be ordered and within clinic hours." });
      }
      if (index && start < toMinutes(sortedBreaks[index - 1].endTime)) {
        context.addIssue({ code: "custom", path: ["breaks", index], message: "Breaks must not overlap." });
      }
    });
  });

export const scheduleSchema = z
  .object({
    workingDays: z.array(z.enum(weekdays)).min(1).max(7),
    openingTime: timeSchema,
    closingTime: timeSchema,
    breakStart: timeSchema.or(z.literal("")).optional(),
    breakEnd: timeSchema.or(z.literal("")).optional(),
    breakReasonEn: text(120).optional(),
    breakReasonUr: text(120).optional(),
    slotDurationMinutes: z.coerce.number().int().min(5).max(120),
    dailyLimit: z.coerce.number().int().min(1).max(200),
    timezone: z.string().trim().min(1).max(80).optional(),
    dayRules: z.array(dayRuleSchema).max(7).optional(),
    active: z.coerce.boolean().optional()
  })
  .strict()
  .superRefine((schedule, context) => {
    const opening = toMinutes(schedule.openingTime);
    const closing = toMinutes(schedule.closingTime);
    if (opening === null || closing === null) return;
    if (closing <= opening) {
      context.addIssue({ code: "custom", path: ["closingTime"], message: "Closing time must be after opening time." });
      return;
    }
    if (new Set(schedule.workingDays).size !== schedule.workingDays.length) {
      context.addIssue({ code: "custom", path: ["workingDays"], message: "Working days must not contain duplicates." });
    }
    if (schedule.dayRules && new Set(schedule.dayRules.map((rule) => rule.day)).size !== schedule.dayRules.length) {
      context.addIssue({ code: "custom", path: ["dayRules"], message: "Only one schedule is allowed for each weekday." });
    }

    const hasBreakStart = Boolean(schedule.breakStart);
    const hasBreakEnd = Boolean(schedule.breakEnd);
    if (hasBreakStart !== hasBreakEnd) {
      context.addIssue({ code: "custom", path: [hasBreakStart ? "breakEnd" : "breakStart"], message: "Both break start and end times are required." });
      return;
    }

    let breakMinutes = 0;
    if (hasBreakStart && hasBreakEnd) {
      const breakStart = toMinutes(schedule.breakStart);
      const breakEnd = toMinutes(schedule.breakEnd);
      if (breakStart === null || breakEnd === null) return;
      if (breakStart < opening || breakEnd > closing || breakEnd <= breakStart) {
        context.addIssue({ code: "custom", path: ["breakEnd"], message: "Break times must be ordered and within clinic hours." });
        return;
      }
      if ((breakStart - opening) % schedule.slotDurationMinutes !== 0 || (breakEnd - opening) % schedule.slotDurationMinutes !== 0) {
        context.addIssue({ code: "custom", path: ["breakStart"], message: "Break times must align with slot boundaries." });
      }
      breakMinutes = breakEnd - breakStart;
    }

    const availableMinutes = closing - opening - breakMinutes;
    if (availableMinutes <= 0 || availableMinutes % schedule.slotDurationMinutes !== 0) {
      context.addIssue({ code: "custom", path: ["slotDurationMinutes"], message: "Clinic hours must divide into complete appointment slots." });
      return;
    }
    if (schedule.dailyLimit > availableMinutes / schedule.slotDurationMinutes) {
      context.addIssue({ code: "custom", path: ["dailyLimit"], message: "Daily limit exceeds the number of available slots." });
    }
  });

export const blockedSlotSchema = z
  .object({
    locationId: z.string().trim().min(1).max(80),
    date: dateSchema,
    dateEnd: dateSchema.or(z.literal("")).optional(),
    startTime: timeSchema.or(z.literal("")).optional(),
    endTime: timeSchema.or(z.literal("")).optional(),
    fullDay: z.coerce.boolean().default(false),
    reason: text(250).refine((value) => value.length >= 2, "Reason is required."),
    reasonUr: text(250).optional(),
    leaveType: z.enum(["Leave", "Holiday", "Emergency", "Maintenance", "Other"]).optional(),
    requiresReschedule: z.coerce.boolean().optional()
  })
  .strict()
  .superRefine((block, context) => {
    if (block.dateEnd && block.dateEnd < block.date) {
      context.addIssue({ code: "custom", path: ["dateEnd"], message: "End date must be on or after the start date." });
    }
    if (block.fullDay) return;
    if (!block.startTime || !block.endTime) {
      context.addIssue({ code: "custom", path: [!block.startTime ? "startTime" : "endTime"], message: "Start and end times are required for a partial-day block." });
      return;
    }
    if (toMinutes(block.endTime) <= toMinutes(block.startTime)) {
      context.addIssue({ code: "custom", path: ["endTime"], message: "End time must be after start time." });
    }
  });

export const specialScheduleSchema = z
  .object({
    locationId: z.string().trim().min(1).max(80),
    date: dateSchema,
    working: z.coerce.boolean(),
    openingTime: timeSchema,
    closingTime: timeSchema,
    slotDurationMinutes: z.coerce.number().int().min(5).max(120),
    dailyLimit: z.coerce.number().int().min(1).max(200),
    breaks: z.array(scheduleBreakSchema).max(8).default([]),
    labelEn: text(120).optional(),
    labelUr: text(120).optional(),
    active: z.coerce.boolean().optional()
  })
  .strict()
  .superRefine((value, context) => {
    const result = dayRuleSchema.safeParse({
      day: "Monday",
      working: value.working,
      openingTime: value.openingTime,
      closingTime: value.closingTime,
      slotDurationMinutes: value.slotDurationMinutes,
      dailyLimit: value.dailyLimit,
      breaks: value.breaks
    });
    if (!result.success) {
      for (const issue of result.error.issues) context.addIssue({ ...issue, path: issue.path.filter((part) => part !== "day") });
    }
  });

export const doctorProfileSchema = z
  .object({
    nameEn: text(120).refine((value) => value.length >= 2),
    nameUr: text(120).refine((value) => value.length >= 2),
    qualificationsEn: text(200).refine((value) => value.length >= 2),
    qualificationsUr: text(200).refine((value) => value.length >= 2),
    specialtyEn: text(160).refine((value) => value.length >= 2),
    specialtyUr: text(160).refine((value) => value.length >= 2),
    biographyEn: text(2000),
    biographyUr: text(2000),
    receptionPhone: phoneSchema,
    pendingQualifications: z.array(text(80).refine((value) => value.length >= 2)).max(20).default([]),
    languages: z.array(text(80).refine((value) => value.length >= 2)).max(20).default([]),
    services: z.array(z.object({
      serviceId: z.string().trim().min(1).max(80),
      titleEn: text(160).refine((value) => value.length >= 2),
      titleUr: text(160).optional()
    }).strict()).max(50).default([]),
    profileImage: z.string().trim().url().or(z.literal("")).default(""),
    active: z.coerce.boolean()
  })
  .strict();

export const chatMessageSchema = z
  .object({
    phone: phoneSchema,
    message: text(1000).optional().default(""),
    actionId: z.string().trim().min(1).max(200).optional(),
    interactionId: z.string().trim().min(8).max(120).regex(/^[A-Za-z0-9._:-]+$/).optional(),
    messageType: z.enum(["text", "poll_selection"]).optional(),
    language: languageSchema.optional()
  })
  .refine((value) => Boolean(value.message || value.actionId), { message: "A message or action is required." })
  .strict();

export function parseOrThrow(schema, input) {
  return schema.parse(input);
}
