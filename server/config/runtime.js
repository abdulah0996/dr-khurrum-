import crypto from "node:crypto";

export const PRODUCTION_ORIGIN = "https://admin.nighatmedicalcomplex.com";

function randomSecret() {
  return crypto.randomBytes(32).toString("hex");
}

export function ensureRuntimeDefaults(env = process.env) {
  env.NODE_ENV = env.NODE_ENV || "development";
  if (env.NODE_ENV !== "production") {
    env.JWT_ACCESS_SECRET = env.JWT_ACCESS_SECRET || randomSecret();
    env.JWT_REFRESH_SECRET = env.JWT_REFRESH_SECRET || randomSecret();
    env.COOKIE_SECRET = env.COOKIE_SECRET || randomSecret();
    env.ADMIN_BOOTSTRAP_TOKEN = env.ADMIN_BOOTSTRAP_TOKEN || randomSecret();
  }
  env.DEFAULT_TIMEZONE = env.DEFAULT_TIMEZONE || "Asia/Karachi";
  env.WHATSAPP_REQUIRED = env.WHATSAPP_REQUIRED || "false";

  if (env.NODE_ENV === "production") {
    env.APP_BASE_URL = env.APP_BASE_URL || PRODUCTION_ORIGIN;
    env.CLIENT_BASE_URL = env.CLIENT_BASE_URL || PRODUCTION_ORIGIN;
    env.API_BASE_URL = env.API_BASE_URL || `${PRODUCTION_ORIGIN}/api`;
    env.CORS_ALLOWED_ORIGINS = env.CORS_ALLOWED_ORIGINS || PRODUCTION_ORIGIN;
  }

  return env;
}
