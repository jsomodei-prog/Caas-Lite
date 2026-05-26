/**
 * src/middleware/apiKeyAuth.ts
 *
 * API Key Authentication Middleware — Session 1 (Phase 16)
 *
 * Provides a second authentication pathway alongside JWT tokens. Clients
 * that have been issued a tenant API key can authenticate any request by
 * sending:
 *
 *   Authorization: Bearer aitw_<base64url-encoded-key>
 *
 * Key format (generated at issuance):
 *   'aitw_' + crypto.randomBytes(24).toString('base64url')
 *
 * Storage:
 *   The full plaintext key is NEVER stored. On issuance the platform stores:
 *     api_key_prefix  — first 12 characters of the full key string (e.g. "aitw_abc123x")
 *                       used as a fast lookup index; not a secret.
 *     api_key_hash    — argon2id hash of the full key; used to verify.
 *
 * Verification flow:
 *   1. Extract key from Authorization header.
 *   2. Take first 12 chars as lookup prefix.
 *   3. SELECT accounts row WHERE api_key_prefix = ? AND status != 'suspended'.
 *   4. argon2.verify(row.api_key_hash, full_key).
 *   5. On success: attach tenant context to req; call next().
 *   6. On failure: 401 with a clear error message.
 *
 * Composition:
 *   This middleware is designed to be composed with the existing JWT middleware
 *   (requireAccessToken in auth.ts). It runs FIRST. If the Authorization header
 *   starts with "Bearer aitw_", this middleware claims the request. Otherwise it
 *   calls next() without setting any context, allowing JWT auth to proceed.
 *
 *   Mount order in route definitions:
 *     router.get("/some-route", apiKeyOrJwt, requireTenantContext, handler);
 *
 *   Where apiKeyOrJwt = [apiKeyAuthMiddleware, requireAccessToken] and
 *   requireTenantContext checks that either source populated req.caasTenantId.
 *
 * Sets on req (mirrors the fields set by requireAccessToken in auth.ts):
 *   req.caasTenantId   — tenant_id from the matched accounts row
 *   req.caasAuthMethod — "api_key" (allows downstream to differentiate)
 *   req.caasApiTier    — tier from accounts (LITE | GROWTH | ENTERPRISE)
 *
 * Does NOT set:
 *   req.caasUserId     — API key auth is tenant-level, not user-level
 *   req.caasRole       — no user role concept for SDK/API-key callers
 *
 * Security notes:
 *   - argon2.verify is the authoritative check; the prefix is only for DB lookup.
 *   - An invalid prefix (no matching row) returns the same 401 as a wrong key
 *     to prevent prefix enumeration.
 *   - Suspended accounts are excluded from the lookup query, not checked post-lookup,
 *     so the 401 for a suspended account is indistinguishable from a wrong key.
 *     This is intentional: we don't want to tell a bad actor that the key is valid
 *     but the account is suspended.
 *   - Timing: argon2.verify runs on every request; the argon2id parameters
 *     (memoryCost, timeCost) from auth.ts are reused here to maintain the same
 *     brute-force cost. If no account is found we skip verify and return 401
 *     immediately — no constant-time dummy verify needed because the prefix
 *     is not a secret (it's the first 12 chars of the public-facing key).
 */

import type { Request, Response, NextFunction } from "express";
import type { Database as DB } from "better-sqlite3";
import argon2 from "argon2";

// ─── Types ────────────────────────────────────────────────────────────────────

/** The accounts row fields needed for API key verification. */
interface AccountsKeyRow {
  tenant_id:    string;
  tier:         string;
  api_key_hash: string;
}

// Extend Express Request to carry API key auth context.
declare global {
  namespace Express {
    interface Request {
      /** Tenant ID — set by either JWT auth or API key auth. */
      caasTenantId?: string;
      /** "jwt" | "api_key" — set by auth middleware, used for audit logging. */
      caasAuthMethod?: "jwt" | "api_key";
      /** Tier from the accounts row — set by API key auth. */
      caasApiTier?: string;
    }
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** All CaaS-issued API keys begin with this sentinel prefix. */
const API_KEY_SENTINEL = "aitw_";

/** Number of characters stored as the lookup prefix. Must match issuance. */
const API_KEY_PREFIX_LENGTH = 12;

// ─── Helper ───────────────────────────────────────────────────────────────────

function getDb(req: Request): DB {
  const db = (req.app.locals as { db?: DB }).db;
  if (!db) throw new Error("[apiKeyAuth] Database handle not found on app.locals.db");
  return db;
}

// ─── Middleware ───────────────────────────────────────────────────────────────

/**
 * Middleware that authenticates requests carrying a tenant API key.
 *
 * If the Authorization header does not start with "Bearer aitw_", this
 * middleware is a no-op (calls next() without touching the request). This
 * makes it safe to place before requireAccessToken — JWT auth handles all
 * requests that aren't API-key authenticated.
 *
 * Usage:
 *   import { apiKeyAuthMiddleware } from "../middleware/apiKeyAuth";
 *   router.get("/route", apiKeyAuthMiddleware, requireAccessToken, handler);
 *   // requireAccessToken will only run if apiKeyAuthMiddleware did not set
 *   // req.caasTenantId (i.e. no API key was provided or it was invalid).
 */
export async function apiKeyAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  // Fast path: not an API key request. Pass through to JWT middleware.
  if (!authHeader?.startsWith(`Bearer ${API_KEY_SENTINEL}`)) {
    next();
    return;
  }

  // Extract the full key (everything after "Bearer ").
  const fullKey = authHeader.slice("Bearer ".length).trim();

  // Guard: key must be long enough to have a meaningful prefix + hash target.
  if (fullKey.length < API_KEY_PREFIX_LENGTH + 4) {
    res.status(401).json({ error: "Invalid API key format" });
    return;
  }

  const prefix = fullKey.slice(0, API_KEY_PREFIX_LENGTH);

  const db = getDb(req);

  // Look up the account by prefix. Exclude suspended accounts so the response
  // is indistinguishable from a wrong key (no information leakage).
  const account = db
    .prepare(
      `SELECT tenant_id, tier, api_key_hash
       FROM accounts
       WHERE api_key_prefix = ? AND status != 'suspended'`
    )
    .get(prefix) as AccountsKeyRow | undefined;

  if (!account) {
    // No matching prefix or account is suspended.
    // Return 401 without revealing which case it is.
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  // Verify the full key against the stored argon2 hash.
  let valid: boolean;
  try {
    valid = await argon2.verify(account.api_key_hash, fullKey);
  } catch (err) {
    console.error("[apiKeyAuth] argon2.verify error:", err);
    res.status(500).json({ error: "API key verification error" });
    return;
  }

  if (!valid) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  // ── Authentication successful ──────────────────────────────────────────────
  // Attach tenant context to the request. Downstream middleware and handlers
  // read these fields without caring whether auth was JWT or API key.
  req.caasTenantId  = account.tenant_id;
  req.caasAuthMethod = "api_key";
  req.caasApiTier   = account.tier;

  // Mirror the X-CaaS-Tier header so the rate limiter resolves the correct
  // bucket without requiring the SDK caller to send the header manually.
  // The rate limiter reads req.headers["x-caas-tier"] (lowercase) via
  // resolveTier() in rateLimiter.ts.
  req.headers["x-caas-tier"] = account.tier;

  next();
}

// ─── Require-Tenant Guard ─────────────────────────────────────────────────────

/**
 * Middleware that blocks requests where neither JWT nor API key auth has
 * populated req.caasTenantId. Use this as the final auth gate on routes that
 * accept both authentication methods.
 *
 * Usage (route supports both JWT and API key):
 *   router.post(
 *     "/api/v1/ingest/events",
 *     apiKeyAuthMiddleware,   // 1. try API key
 *     requireAccessToken,     // 2. try JWT (no-op if API key already authed)
 *     requireTenantContext,   // 3. fail if neither worked
 *     handler
 *   );
 *
 * Note: requireAccessToken (in auth.ts) already returns 401 if the header is
 * present but invalid. requireTenantContext only catches the case where NO
 * authorization header was sent at all, or where the API key middleware
 * silently passed through (non-aitw_ prefix) and requireAccessToken was not
 * mounted. It is belt-and-suspenders.
 */
export function requireTenantContext(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.caasTenantId) {
    res.status(401).json({
      error: "Authentication required",
      hint: "Send a valid Bearer JWT or tenant API key (Authorization: Bearer aitw_...).",
    });
    return;
  }
  next();
}
