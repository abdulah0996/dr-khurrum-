import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ensureRuntimeDefaults } from "./config/runtime.js";
import { validateEnvironment } from "./config/validation.js";
import { connectDatabase, databaseHealth, disconnectDatabase } from "./db/connection.js";
import { authenticate } from "./middleware/auth.js";
import { rejectParameterPollution, requestId, sanitizeInput, securityHeaders } from "./middleware/security.js";
import appointmentsRoutes from "./routes/appointments.js";
import authRoutes from "./routes/auth.js";
import publicRoutes from "./routes/public.js";
import settingsRoutes from "./routes/settings.js";
import slotsRoutes from "./routes/slots.js";
import usersRoutes from "./routes/users.js";
import whatsappRoutes from "./routes/whatsapp.js";
import { ensureClinicConfiguration } from "./services/clinicConfigService.js";
import { getWhatsAppStatus } from "./services/whatsappService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
export const app = express();
const port = process.env.PORT && isNaN(Number(process.env.PORT)) ? process.env.PORT : Number(process.env.PORT || 4000);
let server;
ensureRuntimeDefaults();
let startupValidation = validateEnvironment();
let databaseDisabled = false;

function allowedOrigins() {
  const configured = String(process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  return ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4000"];
}

const generalLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000),
  limit: Number(process.env.RATE_LIMIT_MAX || 300),
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith("/api/whatsapp/webhook")
});

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const chatLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const bookingLimiter = rateLimit({ windowMs: 60 * 1000, limit: 12, standardHeaders: true, legacyHeaders: false });
const lookupLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
const sendLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

app.disable("x-powered-by");
app.set("trust proxy", Number(process.env.TRUST_PROXY || 1));
app.use(requestId);
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
  })
);
app.use(securityHeaders);
app.use(
  "/api",
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins().includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    credentials: true
  })
);
app.use(
  express.json({
    limit: process.env.JSON_BODY_LIMIT || "512kb",
    verify: (req, _res, buffer) => {
      req.rawBody = buffer;
    }
  })
);
app.use(rejectParameterPollution);
app.use(sanitizeInput);
app.use(generalLimiter);
app.use((req, res, next) => {
  if (databaseDisabled && req.path.startsWith("/api") && req.path !== "/api/health") {
    return res.status(503).json({ message: "Database connection is not available. Please try again later." });
  }
  return next();
});

app.get("/api/health", (_req, res) => {
  const database = databaseHealth();
  const whatsapp = getWhatsAppStatus();
  const healthy = startupValidation.ok && database.ready;
  res.status(healthy ? 200 : 503).json({
    status: healthy ? "ok" : "degraded",
    product: "Dr. Khurrum Mansoor WhatsApp AI Appointment Chatbot",
    version: packageJson.version,
    environment: process.env.NODE_ENV || "development",
    mongoConnected: database.ready,
    whatsappConfigured: whatsapp.configured,
    configurationOk: startupValidation.ok,
    uptimeSeconds: Math.round(process.uptime())
  });
});

app.use("/api/auth", authLimiter, authRoutes);
app.use("/api/public/chat", chatLimiter);
app.use("/api/public", publicRoutes);
app.use("/api/whatsapp/webhook", webhookLimiter);
app.use("/api/whatsapp/send", sendLimiter);
app.use("/api/whatsapp", whatsappRoutes);
app.use("/api", authenticate);
app.use("/api", adminLimiter);
app.use("/api/appointments/lookup", lookupLimiter);
app.use("/api/appointments", bookingLimiter, appointmentsRoutes);
app.use("/api/slots", slotsRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/users", usersRoutes);

const distPath = path.join(__dirname, "..", "dist");
if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get(/^\/(?!api|assets).*/, (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

app.use((err, _req, res, _next) => {
  const status = err.status || (err.name === "ZodError" ? 422 : 500);
  const productionServerError = process.env.NODE_ENV === "production" && status >= 500;
  const payload = {
    message: err.name === "ZodError" ? "Validation failed." : productionServerError ? "Something went wrong." : err.message || "Something went wrong."
  };
  if (err.name === "ZodError") {
    payload.details = err.issues?.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  } else if (process.env.NODE_ENV !== "production" && status >= 500) {
    payload.details = err.stack;
  }
  res.status(status).json(payload);
});

async function start() {
  startupValidation = validateEnvironment();
  startupValidation.warnings.forEach((warning) => console.warn(warning));
  if (!startupValidation.ok) {
    throw new Error(`Startup validation failed: ${startupValidation.errors.join(" ")}`);
  }

  databaseDisabled = true;
  await new Promise((resolve, reject) => {
    server = app.listen(port, () => {
      const address = typeof port === "string" ? port : `http://localhost:${port}`;
      console.log(`Dr. Khurrum Mansoor WhatsApp appointment chatbot API listening on ${address}`);
      resolve();
    });
    server.once("error", reject);
  });
  server.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
  server.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS || 35000);
  server.keepAliveTimeout = Number(process.env.KEEP_ALIVE_TIMEOUT_MS || 5000);

  try {
    const database = await connectDatabase();
    databaseDisabled = !database.connected;
    if (database.connected) {
      await ensureClinicConfiguration();
    } else {
      console.warn("MongoDB is unavailable. The website remains online and API routes will return 503 until the database connection is restored.");
    }
  } catch (error) {
    databaseDisabled = true;
    console.error("Database initialization failed after the HTTP server started:", error.message);
  }
}

async function shutdown(signal, exitCode = 0) {
  console.log(`${signal} received. Shutting down appointment chatbot API...`);
  await new Promise((resolve) => {
    if (!server) return resolve();
    return server.close(resolve);
  });
  await disconnectDatabase();
  process.exit(exitCode);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  shutdown("uncaughtException", 1);
});

if (process.env.NODE_ENV !== "test") {
  start().catch((error) => {
    console.error("Failed to start appointment chatbot API:", error.message);
    process.exit(1);
  });
}
