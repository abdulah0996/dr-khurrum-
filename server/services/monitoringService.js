const counters = new Map();

export function recordMetric(name, metadata = {}) {
  const key = String(name || "unknown").slice(0, 80);
  const current = counters.get(key) || { count: 0, lastRecordedAt: "", lastMetadata: {} };
  counters.set(key, {
    count: current.count + 1,
    lastRecordedAt: new Date().toISOString(),
    lastMetadata: {
      method: String(metadata.method || "").slice(0, 12),
      path: String(metadata.path || "").split("?")[0].slice(0, 160),
      status: Number(metadata.status || 0),
      durationMs: Number(metadata.durationMs || 0)
    }
  });
}

export function getMetricsSnapshot() {
  return Object.fromEntries(counters.entries());
}

export function resetMetrics() {
  counters.clear();
}
