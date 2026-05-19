/**
 * tests/setup.ts
 * Runs before every test file. Sets env vars that production code requires
 * but that tests should not need a real value for.
 *
 * These are deterministic test-only values. NEVER use them in any
 * environment that isn't a Jest test run — they're known-public.
 *
 * If you see one of these strings in a production log or .env file,
 * something has gone very wrong. They exist purely because production
 * code reads process.env at module-load time, before test code runs.
 */

process.env.NODE_ENV            = process.env.NODE_ENV ?? "test";

// Auth secrets — required by src/routes/auth.ts at module load.
process.env.JWT_ACCESS_SECRET   = process.env.JWT_ACCESS_SECRET  ?? "test-only-access-secret-do-not-ship";
process.env.JWT_REFRESH_SECRET  = process.env.JWT_REFRESH_SECRET ?? "test-only-refresh-secret-do-not-ship";

// Badge HMAC secret — used by src/lib/badge-secrets.ts. Tests for rotation
// override this via withSecrets() in the badge-rotation test.
process.env.BADGE_HMAC_SECRET_CURRENT = process.env.BADGE_HMAC_SECRET_CURRENT ?? "test-only-badge-secret-do-not-ship";

// Super-admin password used to mint JWTs in test helpers.
process.env.SEED_SUPER_ADMIN_PASSWORD = process.env.SEED_SUPER_ADMIN_PASSWORD ?? "TestOnlyPasswordDoNotShip!12345";

// Payout HMAC, if any module under test reads it at module-load time.
process.env.PAYOUT_HMAC_SECRET   = process.env.PAYOUT_HMAC_SECRET ?? "test-only-payout-secret-do-not-ship";

// Disable the recompute scheduler timer so tests don't run background work.
process.env.RECOMPUTE_SCHEDULER_ENABLED = process.env.RECOMPUTE_SCHEDULER_ENABLED ?? "false";
