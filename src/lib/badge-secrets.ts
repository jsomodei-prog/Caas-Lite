/**
 * src/lib/badge-secrets.ts
 * Secret resolution for badge signing and verification.
 *
 * Supports a rolling rotation pattern using two env vars:
 *
 *   BADGE_HMAC_SECRET_CURRENT   — used for SIGNING new badges and as the
 *                                 primary verification key.
 *   BADGE_HMAC_SECRET_PREVIOUS  — accepted only for VERIFICATION, so
 *                                 signatures minted under the old secret
 *                                 still validate during the cutover window.
 *
 * Legacy support: if neither rotation variable is set, falls back to
 * BADGE_HMAC_SECRET (the original single-secret variable). This keeps
 * pre-rotation deployments working without forced env-file changes.
 *
 * Dev fallback: in absence of any explicit secret, uses a fixed dev string.
 * NEVER ship to production without setting at least BADGE_HMAC_SECRET_CURRENT.
 *
 * Boot-time rotation detection:
 *   getCurrentSecretFingerprint() returns sha256 of the current secret.
 *   On boot, this is compared against the value stored in secret_state
 *   table. Mismatch triggers automatic resign of all badge rows.
 */

import crypto from "crypto";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEV_FALLBACK_SECRET = "dev-only-badge-secret-do-not-ship";

// ─── Resolution ───────────────────────────────────────────────────────────────

interface ResolvedSecrets {
  /** Used for signing new badges and verification. Always non-empty. */
  current: string;
  /** Optional second secret accepted for verification only. */
  previous: string | null;
  /** True iff using DEV_FALLBACK_SECRET (i.e. nothing was set in env). */
  isDevFallback: boolean;
}

/**
 * Reads env at call time. Cached per process — env doesn't change after
 * startup. If you need to force a re-read (tests), call invalidateCache().
 */
let cached: ResolvedSecrets | null = null;

export function getBadgeSecrets(): ResolvedSecrets {
  if (cached) return cached;

  const explicitCurrent  = process.env.BADGE_HMAC_SECRET_CURRENT;
  const explicitPrevious = process.env.BADGE_HMAC_SECRET_PREVIOUS;
  const legacy           = process.env.BADGE_HMAC_SECRET;

  let current: string;
  let previous: string | null = null;
  let isDevFallback = false;

  if (explicitCurrent && explicitCurrent.length > 0) {
    current  = explicitCurrent;
    previous = explicitPrevious && explicitPrevious.length > 0 ? explicitPrevious : null;
  } else if (legacy && legacy.length > 0) {
    current  = legacy;
    previous = null;
  } else {
    current  = DEV_FALLBACK_SECRET;
    isDevFallback = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[badge-secrets] No BADGE_HMAC_SECRET_CURRENT or BADGE_HMAC_SECRET set. " +
      "Falling back to dev secret. DO NOT USE IN PRODUCTION."
    );
  }

  cached = { current, previous, isDevFallback };
  return cached;
}

/** Test/utility hook — re-reads env on next getBadgeSecrets() call. */
export function invalidateCache(): void {
  cached = null;
}

// ─── Signing ─────────────────────────────────────────────────────────────────

/**
 * Computes HMAC signature using the CURRENT secret. Used by syncBadge.
 */
export function signBadgeState(
  tenantId: string,
  badgeState: string,
  stateChangedAt: string
): string {
  const { current } = getBadgeSecrets();
  return hmac(current, tenantId, badgeState, stateChangedAt);
}

/**
 * Verifies a presented signature against the CURRENT secret first, then
 * falls back to PREVIOUS if set. Constant-time comparison.
 *
 * Returns:
 *   - "current"   : signature was minted under the current secret
 *   - "previous"  : signature was minted under the previous secret (rotation
 *                   in progress — embedder needs to refresh their pin)
 *   - "invalid"   : signature does not match either secret
 *
 * Callers use the return value to decide:
 *   - Both "current" and "previous" → allow the request
 *   - Optionally surface "previous" in a header so consumers can detect
 *     the need to refresh.
 */
export type SignatureMatch = "current" | "previous" | "invalid";

export function verifyBadgeSignature(
  presented: string,
  tenantId: string,
  badgeState: string,
  stateChangedAt: string
): SignatureMatch {
  const { current, previous } = getBadgeSecrets();

  const expectedCurrent = hmac(current, tenantId, badgeState, stateChangedAt);
  if (safeEqual(presented, expectedCurrent)) return "current";

  if (previous) {
    const expectedPrevious = hmac(previous, tenantId, badgeState, stateChangedAt);
    if (safeEqual(presented, expectedPrevious)) return "previous";
  }

  return "invalid";
}

// ─── Rotation Detection ──────────────────────────────────────────────────────

/**
 * Returns a stable identifier for the current secret, without revealing
 * the secret itself. Used by boot-time rotation detection — compared
 * against the value stored in the secret_state table.
 *
 * Using sha256 instead of the secret directly means a DB dump reveals
 * nothing useful: you can't extract the secret from a hash, but you can
 * tell "is this the same secret as last boot?"
 */
export function getCurrentSecretFingerprint(): string {
  const { current } = getBadgeSecrets();
  return crypto.createHash("sha256").update(current).digest("hex");
}

// ─── Internals ───────────────────────────────────────────────────────────────

function hmac(secret: string, ...parts: string[]): string {
  return crypto
    .createHmac("sha256", secret)
    .update(parts.join("|"))
    .digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
