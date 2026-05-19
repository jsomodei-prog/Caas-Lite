/**
 * src/middleware/cors.ts
 * CORS configuration.
 *
 * Two profiles:
 *   1. defaultCors      — deny-by-default with an env-driven allow-list.
 *                         Used for everything except the badge endpoint.
 *   2. permissiveCors   — `Access-Control-Allow-Origin: *`. Used ONLY by
 *                         the public badge endpoint, since trust badges
 *                         are intentionally embeddable on any customer
 *                         site without per-origin allow-listing.
 *
 * Env var:
 *   CORS_ALLOWED_ORIGINS  — comma-separated list of full origins (with
 *                           protocol). Example:
 *                             https://dashboard.caas.example.com,https://staging.dashboard.caas.example.com
 *   Empty/unset means: no cross-origin requests allowed except to the
 *   badge endpoint (which has its own permissive handler).
 *
 * Why not the `cors` npm package: that's a fine package, but our config
 * is simple enough that a 30-line module is clearer than configuring
 * the cors package's many knobs. Less surface area to misconfigure.
 */

import type { Request, Response, NextFunction } from "express";

// ─── Allow-list resolution ────────────────────────────────────────────────────

function getAllowedOrigins(): Set<string> {
  const raw = process.env.CORS_ALLOWED_ORIGINS ?? "";
  return new Set(
    raw.split(",")
       .map(s => s.trim())
       .filter(s => s.length > 0)
  );
}

// Cached at process start. Restart to pick up changes.
let allowedOrigins: Set<string> | null = null;
function origins(): Set<string> {
  if (!allowedOrigins) allowedOrigins = getAllowedOrigins();
  return allowedOrigins;
}

/** Test/utility hook. */
export function invalidateCorsCache(): void {
  allowedOrigins = null;
}

// ─── Middlewares ──────────────────────────────────────────────────────────────

/**
 * Strict CORS. If the request has an Origin header:
 *   - In allow-list → echo it back, allow credentials, allow common methods
 *   - Not in allow-list → no Access-Control-Allow-Origin set; browser
 *     enforces same-origin policy and blocks the request.
 *
 * If no Origin header (server-to-server call), the middleware is a no-op
 * (no CORS headers needed for non-browser callers).
 *
 * Preflight (OPTIONS) requests are answered immediately with 204 when
 * the origin is allowed; rejected with 403 when not.
 */
export function defaultCors(req: Request, res: Response, next: NextFunction): void {
  // Skip the badge endpoint entirely. It has its own permissiveCors handler
  // mounted on the route, which echoes any origin (badges are intentionally
  // embeddable on customer sites we don't pre-register).
  //
  // Without this skip, an OPTIONS preflight for a badge path with an Origin
  // we don't recognise would get 403'd here before permissiveCors could
  // respond — defeating the entire point of the public badge endpoint.
  if (req.path.startsWith("/api/v1/badge/") || req.path === "/api/v1/badge") {
    next();
    return;
  }

  const origin = req.header("origin");
  if (!origin) { next(); return; }

  if (origins().has(origin)) {
    res.setHeader("Access-Control-Allow-Origin",      origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods",     "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers",     "Authorization, Content-Type");
    res.setHeader("Vary",                              "Origin");
  } else {
    // Origin set but not allowed. Don't emit Access-Control-Allow-*; browser
    // will block on its own. For preflight, return 403 so the client sees
    // a definitive answer rather than a CORS-block-only confusion.
    if (req.method === "OPTIONS") {
      res.status(403).json({ error: "Origin not allowed" });
      return;
    }
  }

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
}

/**
 * Permissive CORS for the public badge endpoint. Echoes any origin.
 * Used because badges embed on customer sites whose origins we don't
 * pre-register.
 *
 * Does NOT set Allow-Credentials — a permissive CORS that allows
 * credentials would let any site read the badge response with the
 * embedder's cookies, which is undesired even though badge data is
 * low-sensitivity. With no credentials, the worst case is that a
 * site reads public badge state, which is the point.
 */
export function permissiveCors(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  next();
}
