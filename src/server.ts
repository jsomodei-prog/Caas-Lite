/**
 * src/server.ts
 * HTTP bootloader for the CaaS platform.
 *
 * Mounts all routers, including the four Phase 15 additions:
 *   /api/v1/accounts          provisioning (JWT, business-plane gated)
 *   /api/v1/pilot             Listen Mode SDK ingest (API-key auth)
 *   /api/v1/insurance         warranty state machine (JWT)
 *   /api/v1/pov               PoV statements (JWT)
 *
 * Pre-Phase-15 routers (auth, users, regulatory) are mounted alongside.
 * If those router files already mount under different prefixes in your
 * existing server, adapt the prefix arguments below — the createXxxRouter()
 * factory functions don't bind paths themselves.
 *
 * Boot order matters:
 *   1. openDatabase() runs all migrations BEFORE we bind any routes,
 *      so handlers can assume the schema is current.
 *   2. app.locals.db is set before any router is created/mounted, so
 *      getDb(req) inside handlers always returns a live connection.
 *
 * TODO(phase15): structured logging, request IDs, graceful shutdown,
 *   metrics endpoint. None of those are blocking for the pilot.
 */

import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import { openDatabase } from "./db/migrate";

import { createAuthRouter }        from "./routes/auth";
import { createUsersRouter }       from "./routes/users";
import { createProvisioningRouter } from "./routes/provisioning";
import { createPilotIngestRouter }  from "./routes/pilot-ingest";
import { createInsuranceRouter }    from "./routes/insurance";
import { createPovBillingRouter }   from "./routes/pov-billing";
import { createBadgeRouter }        from "./routes/badge";
import { createAdminRouter }        from "./routes/admin";
import { startScheduler }           from "./lib/recompute-scheduler";
import { detectAndApplyRotation }   from "./lib/badge-rotation";
import { defaultCors, permissiveCors } from "./middleware/cors";
import {
  globalSafetyLimiter,
  defaultAuthLimiter,
  pilotIngestLimiter,
  badgeLimiter,
  adminLimiter,
  authLoginLimiter,
  authRefreshLimiter,
} from "./middleware/rate-limits";

// Phase 14 regulatory router. Path may differ in your repo — adapt the
// import if so. Skipped here only if the export name doesn't match.
// import { createRegulatoryRouter } from "./routes/regulatory";

// ─── App Factory ──────────────────────────────────────────────────────────────

/**
 * Builds the Express app with all routers mounted and the DB attached.
 * Exported so tests can import the app directly (with a test DB) without
 * binding to a port.
 */
export function createApp(dbPath?: string): express.Express {
  const app = express();
  const db  = openDatabase(dbPath);

  // Make the DB available to every handler via req.app.locals.db.
  app.locals.db = db;

  // Boot-time secret rotation detection. If BADGE_HMAC_SECRET has changed
  // since last boot, every badge gets resigned with the new secret before
  // any HTTP traffic is served. No-op on unchanged secret.
  detectAndApplyRotation(db);

  // Trust the first proxy hop for req.ip (set X-Forwarded-For correctly
  // upstream). MUST be set before any rate limiter, since limiters key
  // on req.ip. If your deployment has multiple proxies, increase this.
  app.set("trust proxy", 1);

  // ── Security headers ──────────────────────────────────────────────────────
  // Helmet sets sane defaults: X-Content-Type-Options, X-Frame-Options,
  // Referrer-Policy, and (in production) HSTS. CSP is restrictive — the
  // badge route opts out of it via a route-local override since the SVG
  // endpoint doesn't render HTML.
  app.use(helmet({
    // HSTS only in production. Setting it in dev would persist in browsers
    // even after switching back to HTTP, which breaks local development.
    hsts: process.env.NODE_ENV === "production"
      ? { maxAge: 31_536_000, includeSubDomains: true }
      : false,
    // We're an API; relax CSP to "default-src 'none'" which is restrictive
    // but doesn't break JSON responses. Browser-facing endpoints (badge)
    // override this per-route.
    contentSecurityPolicy: {
      directives: { defaultSrc: ["'none'"] },
    },
    // Crossorigin-Resource-Policy: same-origin would break the badge embed
    // pattern. Set to cross-origin for compatibility; the badge route is
    // the only thing this affects in practice.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }));

  // ── Global rate-limit safety net ──────────────────────────────────────────
  // Per-endpoint limiters do most of the work; this is the last line of
  // defense against a misbehaving client that bypasses the specific limits.
  app.use(globalSafetyLimiter);

  // ── CORS ──────────────────────────────────────────────────────────────────
  // Strict allow-list driven by CORS_ALLOWED_ORIGINS env var. Badge route
  // installs its own permissive handler since trust badges are embedded
  // on customer sites we don't pre-register.
  app.use(defaultCors);

  // JSON body parsing. 256KB cap — the pilot ingest endpoint enforces
  // its own 8KB-per-decision limit internally, so the app-level cap just
  // protects against pathological single payloads.
  app.use(express.json({ limit: "256kb" }));

  // Health endpoint, unauthenticated, no DB hit. Useful for load balancers.
  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ status: "ok", time: new Date().toISOString() });
  });

  // ── Phase 11 / 12 / 14 routers ─────────────────────────────────────────────
  // Auth endpoints get per-path limiters BEFORE the router is mounted, so
  // limits apply even if the router's internal handler order changes.
  // Note: the auth router must mount these paths exactly as /login and /refresh.
  app.use("/auth/login",            authLoginLimiter);
  app.use("/auth/refresh",          authRefreshLimiter);
  app.use("/auth",                  createAuthRouter());
  app.use("/api/v1/users",          defaultAuthLimiter, createUsersRouter());
  // app.use("/api/v1/regulatory",  createRegulatoryRouter());  // uncomment when wiring up

  // ── Phase 15 routers ──────────────────────────────────────────────────────
  app.use("/api/v1/accounts",       defaultAuthLimiter, createProvisioningRouter());
  app.use("/api/v1/pilot",          pilotIngestLimiter, createPilotIngestRouter());
  app.use("/api/v1/insurance",      defaultAuthLimiter, createInsuranceRouter());
  app.use("/api/v1/pov",            defaultAuthLimiter, createPovBillingRouter());
  // Badge is public; permissiveCors overrides the strict defaultCors above.
  app.use("/api/v1/badge",          permissiveCors, badgeLimiter, createBadgeRouter());
  app.use("/api/v1/admin",          adminLimiter,    createAdminRouter());

  // Start the periodic recompute timer. Disabled in tests and in
  // multi-instance setups via RECOMPUTE_SCHEDULER_ENABLED=false.
  startScheduler(app);

  // ── Error sink ────────────────────────────────────────────────────────────
  // Final-fallback error handler. Real production should log structured
  // errors with request IDs; here we just keep responses consistent.
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error("[server] Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

// ─── Standalone Entry ─────────────────────────────────────────────────────────

// Run this file directly with `node src/server.js` (post-compile) to bind
// to PORT. Tests import createApp() and skip listen() entirely.
if (require.main === module) {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const app  = createApp();
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on :${port}`);
  });
}

export default createApp;
