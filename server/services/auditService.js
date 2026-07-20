import { models } from "../models/index.js";
import { makePublicId } from "../utils/time.js";

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

export async function listAuditLogs(limit = 200) {
  return models.AuditLog.find({}).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 200, 500)).lean();
}
