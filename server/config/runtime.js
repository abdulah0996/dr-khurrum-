import crypto from "node:crypto";

function randomSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export function ensureDevelopmentDefaults(env = process.env) {
  if (env.NODE_ENV === "production") return env;

  env.NODE_ENV = env.NODE_ENV || "development";
  env.JWT_ACCESS_SECRET = env.JWT_ACCESS_SECRET || randomSecret();
  env.JWT_REFRESH_SECRET = env.JWT_REFRESH_SECRET || randomSecret();
  env.COOKIE_SECRET = env.COOKIE_SECRET || randomSecret();
  env.ADMIN_BOOTSTRAP_TOKEN = env.ADMIN_BOOTSTRAP_TOKEN || randomSecret();
  return env;
}