const REQUIRED_ALWAYS = [
  "MONGODB_URI",
  "JWT_ACCESS_SECRET",
  "JWT_REFRESH_SECRET",
  "COOKIE_SECRET",
  "ADMIN_BOOTSTRAP_TOKEN"
];

const CORE_WHATSAPP_KEYS = [
  "WHATSAPP_API_VERSION",
  "WHATSAPP_ACCESS_TOKEN",
  "WHATSAPP_PHONE_NUMBER_ID",
  "WHATSAPP_BUSINESS_ACCOUNT_ID",
  "WHATSAPP_VERIFY_TOKEN",
  "META_APP_SECRET"
];

const OPTIONAL_WHATSAPP_TEMPLATES = [
  "WHATSAPP_TEMPLATE_APPOINTMENT_CONFIRMATION",
  "WHATSAPP_TEMPLATE_APPOINTMENT_REMINDER",
  "WHATSAPP_TEMPLATE_RESCHEDULE_CONFIRMATION",
  "WHATSAPP_TEMPLATE_CANCELLATION_CONFIRMATION"
];

const REQUIRED_PRODUCTION_DEPLOYMENT = ["APP_BASE_URL", "CLIENT_BASE_URL", "API_BASE_URL", "CORS_ALLOWED_ORIGINS"];

function looksMissing(value = "") {
  const normalized = String(value).trim().toLowerCase();
  return !normalized || normalized.includes("replace") || normalized.includes("change-me") || normalized.includes("<");
}

function longEnoughSecret(key, value = "") {
  if (!key.includes("SECRET") && key !== "COOKIE_SECRET" && key !== "ADMIN_BOOTSTRAP_TOKEN") return true;
  return value.length >= 32;
}

function isHttpUrl(value = "", requireHttps = false) {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && (!requireHttps || url.protocol === "https:");
  } catch {
    return false;
  }
}

const NUMERIC_RULES = {
  PORT: [1, 65535],
  TRUST_PROXY: [0, 10],
  MONGODB_CONNECT_RETRIES: [1, 10],
  MONGODB_MAX_POOL_SIZE: [1, 200],
  MONGODB_MIN_POOL_SIZE: [0, 200],
  MONGODB_SERVER_SELECTION_TIMEOUT_MS: [100, 300000],
  MONGODB_SOCKET_TIMEOUT_MS: [100, 300000],
  MONGODB_HEARTBEAT_FREQUENCY_MS: [500, 300000],
  RATE_LIMIT_WINDOW_MS: [1000, 86400000],
  RATE_LIMIT_MAX: [1, 100000],
  REQUEST_TIMEOUT_MS: [1000, 300000],
  HEADERS_TIMEOUT_MS: [1000, 310000],
  KEEP_ALIVE_TIMEOUT_MS: [100, 300000],
  WHATSAPP_RETRY_ATTEMPTS: [0, 5],
  WHATSAPP_HTTP_TIMEOUT_MS: [1000, 120000],
  SLOW_REQUEST_MS: [100, 300000]
};

export function whatsappConfigured(env = process.env) {
  return CORE_WHATSAPP_KEYS.every((key) => !looksMissing(env[key] || ""));
}

export function validateEnvironment(env = process.env) {
  const errors = [];
  const warnings = [];
  const production = env.NODE_ENV === "production";
  const whatsappRequired = String(env.WHATSAPP_REQUIRED || "false").trim().toLowerCase() === "true";

  if (env.WHATSAPP_REQUIRED && !/^(?:true|false)$/i.test(String(env.WHATSAPP_REQUIRED).trim())) {
    errors.push("WHATSAPP_REQUIRED must be true or false.");
  }

  Object.entries(NUMERIC_RULES).forEach(([key, [minimum, maximum]]) => {
    if (env[key] === undefined || env[key] === "") return;
    const value = Number(env[key]);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      errors.push(`${key} must be an integer between ${minimum} and ${maximum}.`);
    }
  });

  REQUIRED_ALWAYS.forEach((key) => {
    const value = env[key] || "";
    if (looksMissing(value)) {
      if (production) errors.push(`${key} is required.`);
      else warnings.push(`${key} is not configured yet. Using a local development fallback.`);
    } else if (production && !longEnoughSecret(key, value)) {
      errors.push(`${key} must be at least 32 characters.`);
    }
  });

  if (production) {
    REQUIRED_PRODUCTION_DEPLOYMENT.forEach((key) => {
      if (looksMissing(env[key] || "")) errors.push(`${key} is required in production.`);
    });
    if (whatsappRequired) {
      CORE_WHATSAPP_KEYS.forEach((key) => {
        if (looksMissing(env[key] || "")) errors.push(`${key} is required when WHATSAPP_REQUIRED=true.`);
      });
    }
  }

  if (env.MONGODB_URI && !/^mongodb(?:\+srv)?:\/\//i.test(env.MONGODB_URI)) {
    errors.push("MONGODB_URI must be a valid MongoDB connection URI.");
  }

  if (env.WHATSAPP_API_VERSION && !/^v\d+\.\d+$/.test(env.WHATSAPP_API_VERSION)) {
    errors.push("WHATSAPP_API_VERSION must use a value such as v25.0.");
  }

  for (const key of ["APP_BASE_URL", "CLIENT_BASE_URL", "API_BASE_URL"]) {
    if (env[key] && !isHttpUrl(env[key], production)) {
      errors.push(`${key} must be a valid ${production ? "HTTPS" : "HTTP(S)"} URL${production ? " in production" : ""}.`);
    }
  }

  if (env.CORS_ALLOWED_ORIGINS) {
    const origins = env.CORS_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
    if (production && origins.includes("*")) {
      errors.push("CORS_ALLOWED_ORIGINS must be restricted in production.");
    }
    if (origins.some((origin) => origin !== "*" && (!isHttpUrl(origin, production) || new URL(origin).origin !== origin.replace(/\/$/, "")))) {
      errors.push("CORS_ALLOWED_ORIGINS must contain only comma-separated web origins without paths.");
    }
    if (new Set(origins).size !== origins.length) {
      errors.push("CORS_ALLOWED_ORIGINS must not contain duplicates.");
    }
  }

  if (production && looksMissing(env.DEFAULT_TIMEZONE || "")) {
    errors.push("DEFAULT_TIMEZONE is required in production.");
  } else if (env.DEFAULT_TIMEZONE && env.DEFAULT_TIMEZONE !== "Asia/Karachi") {
    errors.push("DEFAULT_TIMEZONE must be Asia/Karachi for the verified production schedule.");
  }

  const minimumPool = Number(env.MONGODB_MIN_POOL_SIZE);
  const maximumPool = Number(env.MONGODB_MAX_POOL_SIZE);
  if (Number.isFinite(minimumPool) && Number.isFinite(maximumPool) && minimumPool > maximumPool) {
    errors.push("MONGODB_MIN_POOL_SIZE must not exceed MONGODB_MAX_POOL_SIZE.");
  }

  if (!whatsappConfigured(env)) {
    warnings.push(
      whatsappRequired
        ? "WhatsApp is required but its core configuration is incomplete."
        : "WhatsApp core configuration is missing. Web booking remains available, but messages will be skipped until Meta credentials are configured."
    );
  } else {
    OPTIONAL_WHATSAPP_TEMPLATES.forEach((key) => {
      if (looksMissing(env[key] || "")) {
        warnings.push(`Optional WhatsApp template key ${key} is not configured.`);
      }
    });
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    checkedAt: new Date().toISOString(),
    whatsappConfigured: whatsappConfigured(env),
    whatsappRequired
  };
}
