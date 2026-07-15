import { recordMetric } from "../services/monitoringService.js";

export function requestTimeout(timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30000)) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        recordMetric("requestTimeouts", { method: req.method, path: req.path });
        res.status(503).json({ message: "Request timed out." });
      }
    }, timeoutMs);

    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));
    next();
  };
}

export function accessLogger(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    if (res.statusCode >= 400) {
      recordMetric(res.statusCode === 401 ? "authFailures" : "apiErrors", {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs)
      });
    }
    const slowThreshold = Number(process.env.SLOW_REQUEST_MS || 2000);
    if (durationMs >= slowThreshold) {
      console.warn(
        JSON.stringify({
          level: "warning",
          message: "Slow request",
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(durationMs),
          timestamp: new Date().toISOString()
        })
      );
    }
  });
  next();
}
