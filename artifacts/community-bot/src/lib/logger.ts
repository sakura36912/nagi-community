const isProduction = process.env.NODE_ENV === "production";

function log(level: "info" | "warn" | "error", msg: string, meta?: unknown) {
  const entry = { level, time: new Date().toISOString(), msg, ...(meta ? { meta } : {}) };
  if (isProduction) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));
  } else {
    // eslint-disable-next-line no-console
    console.log(`[${entry.time}] ${level.toUpperCase()} ${msg}`, meta ?? "");
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) => log("info", msg, meta),
  warn: (msg: string, meta?: unknown) => log("warn", msg, meta),
  error: (msg: string, meta?: unknown) => log("error", msg, meta),
};
