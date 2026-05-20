/**
 * src/middleware/http-logger.ts
 *
 * Per-request structured logging.
 *
 * Why hand-rolled instead of pino-http:
 *   - We already have the request-id middleware that sets req.id; pino-http
 *     would re-implement it and we'd have two IDs.
 *   - We want one line per completed request, not pino-http's two-line
 *     incoming/outgoing pair, which doubles log volume for limited value.
 *   - Tight control over which fields land in the log: tenant, role, tier
 *     are useful; full headers and body are not.
 *
 * What this does:
 *   - On `res.finish` (request completed successfully), log at info.
 *   - On `res.close` without finish (client disconnected mid-response), log
 *     at warn — these are often noise but occasionally a sign of a slow
 *     handler or hung dependency.
 *   - Skip the noisy endpoints (health, metrics, dashboard static) to keep
 *     the signal-to-noise ratio bearable. Slice 5 audit-log endpoints stay
 *     logged; this is just for the high-frequency health-check chatter.
 *
 *   - Mount AFTER requestIdMiddleware so req.id is populated.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import { childLogger } from "../lib/pino";

const log = childLogger("http");

const SKIP_PATHS = new Set<string>([
  "/health",
  "/health/db",
  "/health/performance",
  "/healthz",
  "/readyz",
  "/metrics",
  "/dashboard",
  "/register",
]);

export function httpLoggerMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (SKIP_PATHS.has(req.path)) {
      return next();
    }

    const startNs = process.hrtime.bigint();
    let logged = false;

    const emit = (event: "finish" | "close"): void => {
      if (logged) return;
      logged = true;

      const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;

      const bindings = {
        req_id:    req.id,
        method:    req.method,
        path:      req.originalUrl ?? req.url,
        status:    res.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        tenant_id: req.headers["x-tenant-id"] ?? undefined,
        role:      req.headers["x-caas-role"] ?? undefined,
        tier:      req.headers["x-caas-tier"] ?? undefined,
      };

      if (event === "close" && !res.writableEnded) {
        // Client disconnected before the response finished writing.
        log.warn(bindings, "request aborted by client");
      } else if (res.statusCode >= 500) {
        log.error(bindings, "request completed with server error");
      } else if (res.statusCode >= 400) {
        log.warn(bindings, "request completed with client error");
      } else {
        log.info(bindings, "request completed");
      }
    };

    res.on("finish", () => emit("finish"));
    res.on("close",  () => emit("close"));

    next();
  };
}
