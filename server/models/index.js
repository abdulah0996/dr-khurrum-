import mongoose from "mongoose";
import { APPOINTMENT_STATUSES, STAFF_ROLES } from "../config/clinic.js";

const schemaOptions = {
  timestamps: true,
  versionKey: false
};

const publicId = {
  type: String,
  required: true,
  unique: true,
  index: true,
  trim: true
};

export const UserSchema = new mongoose.Schema(
  {
    userId: publicId,
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: STAFF_ROLES, required: true, index: true },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active", index: true },
    failedLoginAttempts: { type: Number, default: 0 },
    lastFailedLoginAt: Date,
    lockUntil: Date,
    lastLoginAt: Date,
    tokenVersion: { type: Number, default: 0 }
  },
  schemaOptions
);

export const ClinicLocationSchema = new mongoose.Schema(
  {
    locationId: publicId,
    slug: { type: String, required: true, unique: true, trim: true, index: true },
    nameEn: { type: String, required: true, trim: true },
    nameUr: { type: String, required: true, trim: true },
    addressEn: { type: String, required: true, trim: true },
    addressUr: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true, index: true },
    country: { type: String, trim: true },
    phone: { type: String, trim: true },
    googleMapLink: { type: String, trim: true },
    consultationMode: { type: String, trim: true },
    consultationFee: { type: Number, min: 0, default: null },
    timezone: { type: String, default: "Asia/Karachi" },
    active: { type: Boolean, default: true, index: true }
  },
  schemaOptions
);

const ScheduleBreakSchema = new mongoose.Schema(
  {
    breakId: { type: String, required: true, trim: true },
    startTime: { type: String, required: true },
    endTime: { type: String, required: true },
    labelEn: { type: String, trim: true, default: "Break" },
    labelUr: { type: String, trim: true, default: "وقفہ" }
  },
  { _id: false }
);

const DayRuleSchema = new mongoose.Schema(
  {
    day: { type: String, required: true },
    working: { type: Boolean, default: false },
    openingTime: { type: String, default: "09:00" },
    closingTime: { type: String, default: "14:00" },
    slotDurationMinutes: { type: Number, min: 5, max: 120, default: 10 },
    dailyLimit: { type: Number, min: 1, max: 200, default: 30 },
    breaks: { type: [ScheduleBreakSchema], default: [] }
  },
  { _id: false }
);

export const ScheduleRuleSchema = new mongoose.Schema(
  {
    ruleId: publicId,
    locationId: { type: String, required: true, index: true },
    workingDays: [{ type: String, required: true }],
    openingTime: { type: String, required: true },
    closingTime: { type: String, required: true },
    breakStart: { type: String, default: "" },
    breakEnd: { type: String, default: "" },
    breakReasonEn: { type: String, default: "" },
    breakReasonUr: { type: String, default: "" },
    slotDurationMinutes: { type: Number, default: 10 },
    dailyLimit: { type: Number, default: 30 },
    timezone: { type: String, default: "Asia/Karachi" },
    dayRules: { type: [DayRuleSchema], default: [] },
    active: { type: Boolean, default: true, index: true }
  },
  schemaOptions
);

ScheduleRuleSchema.index({ locationId: 1, active: 1 });

export const BlockedSlotSchema = new mongoose.Schema(
  {
    blockedSlotId: publicId,
    locationId: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    dateEnd: { type: String, default: "", index: true },
    startTime: { type: String, default: "" },
    endTime: { type: String, default: "" },
    fullDay: { type: Boolean, default: false, index: true },
    reason: { type: String, required: true, trim: true },
    reasonUr: { type: String, trim: true, default: "" },
    leaveType: { type: String, enum: ["Leave", "Holiday", "Emergency", "Maintenance", "Other"], default: "Other" },
    requiresReschedule: { type: Boolean, default: false },
    createdBy: { type: String, default: "System" },
    active: { type: Boolean, default: true, index: true }
  },
  schemaOptions
);

BlockedSlotSchema.index({ locationId: 1, date: 1, active: 1 });

export const SpecialScheduleSchema = new mongoose.Schema(
  {
    specialScheduleId: publicId,
    locationId: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    working: { type: Boolean, default: false },
    openingTime: { type: String, default: "09:00" },
    closingTime: { type: String, default: "14:00" },
    slotDurationMinutes: { type: Number, min: 5, max: 120, default: 10 },
    dailyLimit: { type: Number, min: 1, max: 200, default: 32 },
    breaks: { type: [ScheduleBreakSchema], default: [] },
    labelEn: { type: String, trim: true, default: "Special schedule" },
    labelUr: { type: String, trim: true, default: "خصوصی اوقات" },
    createdBy: { type: String, default: "System" },
    active: { type: Boolean, default: true, index: true }
  },
  schemaOptions
);

SpecialScheduleSchema.index({ locationId: 1, date: 1 }, { unique: true });

export const DoctorProfileSchema = new mongoose.Schema(
  {
    doctorProfileId: publicId,
    profileKey: { type: String, required: true, unique: true, default: "primary", index: true },
    nameEn: { type: String, required: true, trim: true },
    nameUr: { type: String, required: true, trim: true },
    qualificationsEn: { type: String, required: true, trim: true },
    qualificationsUr: { type: String, required: true, trim: true },
    specialtyEn: { type: String, required: true, trim: true },
    specialtyUr: { type: String, required: true, trim: true },
    biographyEn: { type: String, trim: true, default: "" },
    biographyUr: { type: String, trim: true, default: "" },
    receptionPhone: { type: String, trim: true, default: "" },
    pendingQualifications: { type: [String], default: [] },
    languages: { type: [String], default: [] },
    services: {
      type: [
        new mongoose.Schema(
          {
            serviceId: { type: String, required: true, trim: true },
            titleEn: { type: String, required: true, trim: true },
            titleUr: { type: String, trim: true, default: "" }
          },
          { _id: false }
        )
      ],
      default: []
    },
    profileImage: { type: String, trim: true, default: "" },
    active: { type: Boolean, default: true, index: true }
  },
  schemaOptions
);

export const PatientSchema = new mongoose.Schema(
  {
    patientId: publicId,
    identityKey: { type: String, trim: true },
    fullName: { type: String, required: true, trim: true, index: true },
    phone: { type: String, required: true, trim: true },
    normalizedPhone: { type: String, required: true, trim: true },
    age: { type: Number, min: 1, max: 120 },
    gender: { type: String, enum: ["Male", "Female", "Other"], required: true },
    city: { type: String, trim: true },
    reasonForVisit: { type: String, trim: true, maxlength: 500 },
    consentAccepted: { type: Boolean, default: false },
    consentAcceptedAt: Date,
    consentSource: { type: String, enum: ["WhatsApp", "WhatsApp Cloud API", "Reception", "Patient Web Chat"] },
    consentRecordedBy: { type: String, trim: true, default: "" }
  },
  schemaOptions
);

PatientSchema.index({ normalizedPhone: 1 });
PatientSchema.index(
  { identityKey: 1 },
  { unique: true, partialFilterExpression: { identityKey: { $type: "string", $gt: "" } } }
);

export const AppointmentSchema = new mongoose.Schema(
  {
    appointmentId: publicId,
    patientId: { type: String, required: true, index: true },
    patientName: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    normalizedPhone: { type: String, required: true, trim: true, index: true },
    age: { type: Number, min: 1, max: 120 },
    gender: { type: String, enum: ["Male", "Female", "Other"], required: true },
    city: { type: String, trim: true },
    locationId: { type: String, required: true, index: true },
    locationNameEn: { type: String, required: true },
    locationNameUr: { type: String, required: true },
    doctorName: { type: String, default: "Dr. Khurrum Mansoor" },
    date: { type: String, required: true, index: true },
    time: { type: String, required: true },
    tokenNumber: { type: Number, required: true },
    status: { type: String, enum: APPOINTMENT_STATUSES, default: "Booked", index: true },
    reasonForVisit: { type: String, trim: true, maxlength: 500 },
    source: {
      type: String,
      enum: ["WhatsApp", "WhatsApp Cloud API", "Reception", "Patient Web Chat"],
      default: "WhatsApp",
      index: true
    },
    cancelledReason: { type: String, trim: true },
    cancelledAt: Date,
    cancelledBy: String,
    cancelledSource: { type: String, enum: ["Patient", "Admin", "System"] },
    visitedAt: Date,
    visitedBy: String,
    noShowAt: Date,
    noShowBy: String,
    noShowReason: { type: String, trim: true, maxlength: 250 },
    rescheduleHistory: [
      {
        fromLocationId: String,
        fromDate: String,
        fromTime: String,
        fromTokenNumber: Number,
        toLocationId: String,
        toDate: String,
        toTime: String,
        toTokenNumber: Number,
        changedAt: Date,
        changedBy: String
      }
    ],
    requiresReschedule: { type: Boolean, default: false, index: true },
    rescheduleReason: { type: String, trim: true, default: "" }
  },
  schemaOptions
);

AppointmentSchema.index(
  { locationId: 1, date: 1, time: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["Booked", "Rescheduled"] } }
  }
);
AppointmentSchema.index({ date: -1, time: -1, _id: -1 });
AppointmentSchema.index({ status: 1, date: -1, time: -1 });
AppointmentSchema.index({ locationId: 1, date: -1, time: -1 });
AppointmentSchema.index(
  { patientId: 1, date: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["Booked", "Rescheduled"] } }
  }
);
AppointmentSchema.index(
  { locationId: 1, date: 1, tokenNumber: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ["Booked", "Rescheduled"] } }
  }
);
AppointmentSchema.index({ patientName: "text", normalizedPhone: "text", appointmentId: "text" });

export const MessageLogSchema = new mongoose.Schema(
  {
    messageLogId: publicId,
    phone: { type: String, trim: true, index: true },
    normalizedPhone: { type: String, trim: true, index: true },
    appointmentId: { type: String, trim: true, index: true },
    idempotencyKey: { type: String, trim: true },
    messageType: { type: String, trim: true, index: true },
    messageBody: { type: String, trim: true },
    direction: { type: String, enum: ["Incoming", "Outgoing", "Status"], index: true },
    status: { type: String, trim: true, index: true },
    providerMessageId: { type: String, trim: true },
    error: { type: String, trim: true },
    retryCount: { type: Number, default: 0 },
    rawPayload: mongoose.Schema.Types.Mixed
  },
  schemaOptions
);

MessageLogSchema.index({ createdAt: -1 });
MessageLogSchema.index(
  { providerMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerMessageId: { $type: "string", $gt: "" } }
  }
);
MessageLogSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } }
  }
);

export const NotificationOutboxSchema = new mongoose.Schema(
  {
    notificationId: publicId,
    appointmentId: { type: String, required: true, trim: true, index: true },
    notificationType: { type: String, required: true, enum: ["ADMIN_NEW_APPOINTMENT_ALERT"], index: true },
    recipientPhone: { type: String, required: true, trim: true },
    templateName: { type: String, required: true, trim: true },
    templateLanguage: { type: String, required: true, trim: true },
    templateParameters: { type: [String], required: true, validate: (values) => values.length === 6 },
    status: {
      type: String,
      enum: ["queued", "sending", "sent", "delivered", "read", "failed", "dead_letter"],
      default: "queued",
      index: true
    },
    providerMessageId: { type: String, trim: true, default: "" },
    attemptCount: { type: Number, default: 0, min: 0 },
    nextRetryAt: { type: Date, default: Date.now, index: true },
    lockedAt: Date,
    lockExpiresAt: { type: Date, index: true },
    lastAttemptAt: Date,
    sentAt: Date,
    deliveredAt: Date,
    readAt: Date,
    failedAt: Date,
    failureCode: { type: String, trim: true, default: "" },
    failureMessageSafe: { type: String, trim: true, default: "" }
  },
  schemaOptions
);

NotificationOutboxSchema.index(
  { appointmentId: 1, notificationType: 1, recipientPhone: 1 },
  { unique: true }
);
NotificationOutboxSchema.index({ status: 1, nextRetryAt: 1, lockExpiresAt: 1 });
NotificationOutboxSchema.index(
  { providerMessageId: 1 },
  { unique: true, partialFilterExpression: { providerMessageId: { $type: "string", $gt: "" } } }
);

export const AuditLogSchema = new mongoose.Schema(
  {
    auditLogId: publicId,
    actorUserId: { type: String, default: "System", index: true },
    actorRole: { type: String, default: "System" },
    action: { type: String, required: true, index: true },
    module: { type: String, required: true, index: true },
    targetType: { type: String, trim: true },
    targetId: { type: String, trim: true, index: true },
    ipAddress: String,
    userAgent: String,
    metadata: mongoose.Schema.Types.Mixed
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

AuditLogSchema.index({ createdAt: -1 });

export const WhatsAppConsentSchema = new mongoose.Schema(
  {
    consentId: publicId,
    phone: { type: String, required: true, trim: true },
    normalizedPhone: { type: String, required: true, trim: true },
    optedIn: { type: Boolean, default: true },
    source: { type: String, trim: true },
    language: { type: String, enum: ["en", "ur"], default: "en" },
    nonEssentialOptOut: { type: Boolean, default: false, index: true },
    failureCount: { type: Number, default: 0 },
    lastOptInAt: Date,
    lastOptOutAt: Date,
    lastFailureAt: Date,
    lastMessageAt: Date
  },
  schemaOptions
);

WhatsAppConsentSchema.index({ normalizedPhone: 1 }, { unique: true });

export const WebhookEventSchema = new mongoose.Schema(
  {
    eventId: publicId,
    provider: { type: String, required: true, index: true },
    providerEventId: { type: String, required: true, index: true },
    eventType: { type: String, trim: true },
    status: { type: String, enum: ["received", "processing", "completed", "failed", "retrying", "dead_letter"], default: "received", index: true },
    attempts: { type: Number, default: 0 },
    lockedAt: Date,
    completedAt: Date,
    nextRetryAt: Date,
    lastError: { type: String, trim: true, default: "" },
    processedAt: Date
  },
  schemaOptions
);

WebhookEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });
WebhookEventSchema.index({ status: 1, lockedAt: 1 });

export const ConversationLockSchema = new mongoose.Schema(
  {
    normalizedPhone: { type: String, required: true, unique: true, index: true },
    owner: { type: String, required: true },
    lockedUntil: { type: Date, required: true, index: true }
  },
  schemaOptions
);

export const AuthSessionSchema = new mongoose.Schema(
  {
    authSessionId: publicId,
    userId: { type: String, required: true, index: true },
    familyId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    tokenVersion: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true },
    lastUsedAt: Date,
    revokedAt: Date,
    revokeReason: { type: String, trim: true, default: "" },
    replacedByHash: { type: String, trim: true, default: "" }
  },
  schemaOptions
);

AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ChatSessionSchema = new mongoose.Schema(
  {
    chatSessionId: publicId,
    normalizedPhone: { type: String, required: true, unique: true, index: true },
    language: { type: String, enum: ["en", "ur"], default: "en" },
    step: { type: String, default: "language" },
    draft: { type: mongoose.Schema.Types.Mixed, default: {} },
    processedInteractions: {
      type: [
        new mongoose.Schema(
          {
            interactionId: { type: String, required: true, trim: true },
            actionId: { type: String, trim: true, default: "" },
            reply: { type: mongoose.Schema.Types.Mixed, required: true },
            processedAt: { type: Date, default: Date.now }
          },
          { _id: false }
        )
      ],
      default: []
    },
    lastMessageAt: Date
  },
  schemaOptions
);

export const CounterSchema = new mongoose.Schema(
  {
    counterId: publicId,
    scope: { type: String, required: true, unique: true, index: true },
    value: { type: Number, default: 0 }
  },
  schemaOptions
);

export const models = {
  User: mongoose.models.User || mongoose.model("User", UserSchema),
  ClinicLocation: mongoose.models.ClinicLocation || mongoose.model("ClinicLocation", ClinicLocationSchema),
  ScheduleRule: mongoose.models.ScheduleRule || mongoose.model("ScheduleRule", ScheduleRuleSchema),
  BlockedSlot: mongoose.models.BlockedSlot || mongoose.model("BlockedSlot", BlockedSlotSchema),
  SpecialSchedule: mongoose.models.SpecialSchedule || mongoose.model("SpecialSchedule", SpecialScheduleSchema),
  DoctorProfile: mongoose.models.DoctorProfile || mongoose.model("DoctorProfile", DoctorProfileSchema),
  Patient: mongoose.models.Patient || mongoose.model("Patient", PatientSchema),
  Appointment: mongoose.models.Appointment || mongoose.model("Appointment", AppointmentSchema),
  MessageLog: mongoose.models.MessageLog || mongoose.model("MessageLog", MessageLogSchema),
  NotificationOutbox: mongoose.models.NotificationOutbox || mongoose.model("NotificationOutbox", NotificationOutboxSchema),
  AuditLog: mongoose.models.AuditLog || mongoose.model("AuditLog", AuditLogSchema),
  WhatsAppConsent: mongoose.models.WhatsAppConsent || mongoose.model("WhatsAppConsent", WhatsAppConsentSchema),
  WebhookEvent: mongoose.models.WebhookEvent || mongoose.model("WebhookEvent", WebhookEventSchema),
  ConversationLock: mongoose.models.ConversationLock || mongoose.model("ConversationLock", ConversationLockSchema),
  AuthSession: mongoose.models.AuthSession || mongoose.model("AuthSession", AuthSessionSchema),
  ChatSession: mongoose.models.ChatSession || mongoose.model("ChatSession", ChatSessionSchema),
  Counter: mongoose.models.Counter || mongoose.model("Counter", CounterSchema)
};
