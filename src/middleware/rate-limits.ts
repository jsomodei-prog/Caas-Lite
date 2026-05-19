/**
 * src/middleware/rate-limits.ts
 * Centralized rate-limit factories for all API surfaces.
 *
 * Each exported function returns an express middleware. Use the most
 * specific one for a given route; the `defaultLimiter` exists as a
 * catch-all but routes should normally pick their own profile.
 *
 * Keys:
 *   - per-IP    for unauthenticated endpoints
 *   - per-JWT   for endpoints behind requireAccessToken
 *   - per-API-key for the pilot ingest endpoint
 *
 * All limiters return RFC 6585 standard 429 with Retry-After.
 *
 * Tuning:
 *   Numbers below are starting points for the pilot. Expect to revisit
 *   based on real traffic. The pattern (stricter on auth, generous on
 *   read, very strict on admin) is more important than the exact numbers.
 *
 * Test mode:
 *   When NODE_ENV=test, all limits are effectively disabled (set to 100k).
 *   This prevents test parallelism from hitting the limiter and producing
 *   flaky 429s in unrelated assertions.
 */

import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import type { Request } from "express";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const IS_TEST = process.env.NODE_ENV === "test";
const TEST_INFINITY = 100_000;   // effectively unlimited for test runs

const ONE_MINUTE = 60 * 1000;
const ONE_HOUR   = 60 * ONE_MINUTE;

/**
 * Base options that every limiter shares.
 *   - standardHeaders: emit RateLimit-* headers (RFC draft)
 *   - legacyHeaders:   suppress old X-RateLimit-* (just adds noise)
 *   - skipFailedRequests: don't count 5xx responses (server fault, not user fault)
 *   - skipSuccessfulRequests: false — success WOULD count, this is "everything counts"
 *
 * Each profile below overrides max, windowMs, and keyGenerator.
 */
const baseOptions: Partial<Options> = {
  standardHeaders:        true,
  legacyHeaders:          false,
  skipFailedRequests:     true,
  skipSuccessfulRequests: false,
};

// ─── Key extractors ───────────────────────────────────────────────────────────

/**
 * Extracts a stable per-JWT-subject key. Used for endpoints behind
 * requireAccessToken — different tenants/users get separate buckets so
 * one noisy tenant can't exhaust another's quota.
 *
 * Falls back to IP if no subject is present (shouldn't happen on an
 * authenticated route, but defensive).
 */
function jwtSubjectKey(req: Request): string {
  const user = (req as Request & { user?: { id?: string; sub?: string } }).user;
  return user?.id ?? user?.sub ?? ipKey(req);
}

/**
 * Extracts a stable per-API-key key from the Authorization header.
 * Uses the first 16 chars of the bearer token — enough entropy to
 * separate accounts without storing the full key in rate-limiter
 * memory (which is in-process and visible in heap dumps).
 */
function apiKeyKey(req: Request): string {
  const auth = req.header("authorization") ?? "";
  const match = auth.match(/^Bearer\s+(\S+)/i);
  if (!match) return ipKey(req);
  return `key:${match[1].slice(0, 16)}`;
}

/**
 * Per-IP. Respects trust proxy setting (already configured to 1 in server.ts).
 *
 * Uses express-rate-limit's built-in ipKeyGenerator helper which correctly
 * normalizes IPv6 addresses to their /64 prefix. A custom key generator
 * that just returned req.ip would let IPv6 clients bypass limits by
 * varying their address representation (multiple equivalent forms of the
 * same address would each get a separate bucket).
 */
function ipKey(req: Request): string {
  return ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "unknown");
}

// ─── Profiles ────────────────────────────────────────────────────────────────

/**
 * Login endpoint: strict per-IP. Defense against credential stuffing.
 * 10 per minute is enough for legitimate retries (typo, wrong password)
 * but kills any brute-force attempt quickly.
 */
export const authLoginLimiter = rateLimit({
  ...baseOptions,
  windowMs:        ONE_MINUTE,
  max:             IS_TEST ? TEST_INFINITY : 10,
  keyGenerator:    ipKey,
  message:         { error: "Too many login attempts" },
});

/**
 * Token refresh: per-IP but more permissive. Real users hit this often
 * (every ~15min if the token TTL is short). 60/min/IP is the equivalent
 * of one refresh per second sustained, which only a buggy client would do.
 */
export const authRefreshLimiter = rateLimit({
  ...baseOptions,
  windowMs:        ONE_MINUTE,
  max:             IS_TEST ? TEST_INFINITY : 60,
  keyGenerator:    ipKey,
});

/**
 * Pilot ingest: per-API-key. 600/min = 10 req/sec sustained, which
 * comfortably handles the SDK's default 1-sec batch interval even with
 * burst traffic. An over-the-limit key gets backoff (the SDK silently
 * retries on next interval).
 */
export const pilotIngestLimiter = rateLimit({
  ...baseOptions,
  windowMs:        ONE_MINUTE,
  max:             IS_TEST ? TEST_INFINITY : 600,
  keyGenerator:    apiKeyKey,
});

/**
 * Public badge endpoint: per-IP. Embedders poll every 30 seconds by
 * default, so a single IP fronting 300 customer sites would do 600
 * requests/minute. The limit accommodates that with headroom.
 *
 * Note: this is per-IP, not per-tenant. If you have a customer whose
 * site has heavy CDN egress through one IP, you may need to revisit.
 */
export const badgeLimiter = rateLimit({
  ...baseOptions,
  windowMs:        ONE_MINUTE,
  max:             IS_TEST ? TEST_INFINITY : 600,
  keyGenerator:    ipKey,
});

/**
 * Admin endpoints: per-JWT-subject. Admin actions should be rare —
 * 20/min is plenty for human operators, painfully slow for automation
 * trying to brute-force. External cron callers should use a single
 * long-lived admin JWT and stay well below this limit.
 */
export const adminLimiter = rateLimit({
  ...baseOptions,
  windowMs:        ONE_MINUTE,
  max:             IS_TEST ? TEST_INFINITY : 20,
  keyGenerator:    jwtSubjectKey,
});

/**
 * Default for everything else (most authenticated CRUD). 300/min/JWT.
 * Generous enough that no normal app will hit it; cuts off runaway
 * clients.
 */
export const defaultAuthLimiter = rateLimit({
  ...baseOptions,
  windowMs:        ONE_MINUTE,
  max:             IS_TEST ? TEST_INFINITY : 300,
  keyGenerator:    jwtSubjectKey,
});

/**
 * Heavy-hand global: 5000 req/hour/IP across ALL endpoints. Applied
 * at the app level as a final safety net. A misbehaving client that
 * somehow bypasses per-endpoint limits still hits this wall.
 */
export const globalSafetyLimiter = rateLimit({
  ...baseOptions,
  windowMs:        ONE_HOUR,
  max:             IS_TEST ? TEST_INFINITY : 5000,
  keyGenerator:    ipKey,
});
