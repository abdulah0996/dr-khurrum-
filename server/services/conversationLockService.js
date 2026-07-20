import crypto from "node:crypto";
import { models } from "../models/index.js";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withConversationLock(normalizedPhone, callback, { waitMs = 10000, leaseMs = 60000, heartbeatMs = Math.max(1000, Math.floor(leaseMs / 3)) } = {}) {
  if (models.ConversationLock.db.readyState !== 1) return callback();
  const owner = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  while (Date.now() <= deadline) {
    const now = new Date();
    try {
      const lock = await models.ConversationLock.findOneAndUpdate(
        { normalizedPhone, $or: [{ lockedUntil: { $lte: now } }, { owner }] },
        { $set: { owner, lockedUntil: new Date(now.getTime() + leaseMs) } },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true }
      ).lean();
      if (lock?.owner === owner) {
        let renewalError = null;
        const heartbeat = setInterval(() => {
          models.ConversationLock.updateOne(
            { normalizedPhone, owner, lockedUntil: { $gt: new Date() } },
            { $set: { lockedUntil: new Date(Date.now() + leaseMs) } }
          ).then((result) => {
            if (!result?.matchedCount) renewalError = new Error("The conversation lock lease was lost.");
          }).catch((error) => { renewalError = error; });
        }, heartbeatMs);
        heartbeat.unref?.();
        try {
          const result = await callback();
          if (renewalError) {
            const error = new Error("The conversation could not be saved safely. Please retry this message.");
            error.status = 503;
            throw error;
          }
          return result;
        } finally {
          clearInterval(heartbeat);
          await models.ConversationLock.updateOne(
            { normalizedPhone, owner },
            { $set: { lockedUntil: new Date(0) }, $unset: { owner: 1 } }
          ).catch(() => {});
        }
      }
    } catch (error) {
      if (error?.code !== 11000) throw error;
    }
    await wait(40);
  }
  const error = new Error("The conversation is busy. Please retry this message.");
  error.status = 503;
  throw error;
}
