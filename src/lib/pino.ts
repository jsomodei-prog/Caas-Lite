/**
 * src/lib/pino.ts
 *
 * Pino-based structured logger for slice-3 platform concerns: HTTP request
 * logging, cron jobs, error handler, shutdown orchestrator.
 *
 * This module is INTENTIONALLY separate from src/lib/logger.ts. That file
 * exports a minimal `logger` with a `(message, meta)` signature used by the
 * policy engine, verification engine, and trial-expiry middleware — 38+ call
 * sites that predate this slice. We don't migrate them here; slice 6 can
 * decide whether to unify on pino across the codebase.
 *
 * Until then, two loggers coexist:
 *
 *   - logger from ./logger      — engine code, signature (msg, meta), emits
 *                                  { timestamp, level, message, ...meta }
 *   - pinoLogger from ./pino    — platform code, signature (meta, msg),
 *                                  emits pino's default JSON shape (uses
 *                                  "msg" not "message")
 *
 * Log shippers that grep for "message" will only see engine logs; greps for
 * "msg" will only see platform logs. Documenting this so the gotcha is
 * visible. Slice 6 review item.
 *
 * Design notes carried over from the original slice-3 logger module:
 *   - Redact paths are conservative-but-broad. Pino redaction is path-based,
 *     not regex. We list common credential field names; *.password matches
 *     foo.password but NOT foo.bar.password — for deeply nested payloads we
 *     redact containers (req.body, *.metadata, *.payload) outright.
 *   - In test, we pin level to `silent` unless LOG_LEVEL is set explicitly.
 *     The 124 tests already produce migration/badge console noise; adding
 *     pino on top would make failures unreadable.
 *   - In production, default JSON output (one event per line) for ingestion
 *     by log shippers. pino-pretty is optional and detected at runtime.
 *   - We do NOT log req.body. Bodies frequently contain secrets (auth, HMAC
 *     rotation, queue payloads).
 */

import pino, { type Logger, type LoggerOptions } from "pino";

const REDACT_PATHS = [
  // Standard HTTP auth surfaces
  "req.headers.authorization",
  "req.headers.cookie",
  "req.headers['x-api-key']",
  "request.headers.authorization",
  "request.headers.cookie",
  "headers.authorization",
  "headers.cookie",

  // Common credential field names at one level deep
  "*.password",
  "*.passwd",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.apiKey",
  "*.api_key",
  "*.secret",
  "*.hmac",
  "*.hmacSecret",
  "*.hmac_secret",
  "*.privateKey",
  "*.private_key",

  // Suffix matches actually seen in this codebase. Slice 6: re-grep for
  // _secret / _key and extend.
  "*.dev_hmac_secret",
  "*.payout_hmac_secret",
  "*.badge_hmac_secret_current",
  "*.jwt_access_secret",
  "*.jwt_refresh_secret",
  "*.seed_super_admin_password",

  // Bodies / metadata — redact wholesale rather than enumerate inner shapes.
  "req.body.payload",
  "req.body.metadata",
  "req.body",
];

function buildOptions(): LoggerOptions {
  const isTest = process.env.NODE_ENV === "test";
  const isProd = process.env.NODE_ENV === "production";

  const level =
    process.env.LOG_LEVEL
    ?? (isTest ? "silent" : isProd ? "info" : "debug");

  const base: LoggerOptions = {
    level,
    base: { service: "caas-lite" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
      remove: false,
    },
    serializers: {
      err: pino.stdSerializers.err,
      req: (req: { method?: string; url?: string; id?: string; headers?: Record<string, unknown> }) => ({
        method: req.method,
        url:    req.url,
        id:     req.id,
        headers: req.headers ? {
          "x-tenant-id":  req.headers["x-tenant-id"],
          "x-caas-role":  req.headers["x-caas-role"],
          "x-caas-tier":  req.headers["x-caas-tier"],
          "user-agent":   req.headers["user-agent"],
          "content-type": req.headers["content-type"],
        } : undefined,
      }),
    },
  };

  if (!isProd && !isTest && process.env.LOG_PRETTY === "true") {
    try {
      require.resolve("pino-pretty");
      base.transport = {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
      };
    } catch {
      // pino-pretty not installed — silent fallback to JSON.
    }
  }

  return base;
}

/** Pino root logger for platform concerns. Renamed from the slice-3 draft. */
export const pinoLogger: Logger = pino(buildOptions());

/**
 * Component-scoped child logger.
 *
 *   const log = childLogger("cron");
 *   log.info({ schedule: "0 2 * * *" }, "Scheduled backup");
 */
export function childLogger(component: string, extra?: Record<string, unknown>): Logger {
  return pinoLogger.child({ component, ...(extra ?? {}) });
}

/**
 * Centralizes the `{ err }` binding pattern. Calling `log.error(err, "msg")`
 * loses the stack because pino treats the first string arg as the message —
 * if `err` is passed first as an Error, pino has no Error serializer hook
 * for that position. Always go through this helper for errors.
 */
export function logError(log: Logger, msg: string, err: unknown, extra?: Record<string, unknown>): void {
  log.error({ err, ...(extra ?? {}) }, msg);
}
