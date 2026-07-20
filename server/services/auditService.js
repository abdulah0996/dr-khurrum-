import { models } from "../models/index.js";
import { makePublicId } from "../utils/time.js";
import { recordMetric } from "./monitoringService.js";

export async function addAuditLog({ actor = null, action, module, targetType = "", targetId = "", metadata = {}, req = null }) {
  return models.AuditLog.create({
    auditLogId: makePublicId("AUD"),
    actorUserId: actor?.userId || actor?.id || "System",
    actorRole: actor?.role || "System",
    action,
    module,
    targetType,
    targetId,
    ipAddress: req?.ip || "",
    userAgent: req?.headers?.["user-agent"] || "",
    metadata
  });
}

export async function addAuditLogSafely(details) {
  try {
    return await addAuditLog(details);
  } catch (error) {
    recordMetric("audit.write.failed", { path: String(details?.module || "Audit") });
    console.error("Audit log write failed", {
      action: String(details?.action || "").slice(0, 120),
      module: String(details?.module || "").slice(0, 80),
      targetId: String(details?.targetId || "").slice(0, 80),
      error: String(error?.message || "Audit write failed").replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[redacted]").slice(0, 300)
    });
    return null;
  }
}

export async function listAuditLogs(limit = 200) {
  return models.AuditLog.find({}).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 500)).lean();
}
