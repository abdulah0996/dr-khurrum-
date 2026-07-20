import { models } from "../models/index.js";
import { makePublicId } from "../utils/time.js";

export async function acquireInvariantLock(scope, session) {
  return models.Counter.findOneAndUpdate(
    { scope },
    {
      $inc: { value: 1 },
      $setOnInsert: { counterId: makePublicId("LCK") }
    },
    { upsert: true, returnDocument: "after", session, setDefaultsOnInsert: true }
  );
}

export function removesSuperAdminAccess(user, updates) {
  if (!user || user.role !== "Super Admin" || user.status !== "Active") return false;
  return updates.role === "Receptionist" || updates.status === "Inactive";
}
