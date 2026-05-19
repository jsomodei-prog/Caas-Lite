/**
 * tests/helpers/auth.ts
 * Test bootstrap: seed a super-admin user and mint a real JWT against
 * the running app. Use this in any test file that needs an authenticated
 * business-plane caller.
 *
 *   import { mintSuperAdminToken } from "./helpers/auth";
 *
 *   beforeAll(async () => {
 *     dbPath = path.join(os.tmpdir(), `test-${Date.now()}.db`);
 *     app    = createApp(dbPath);
 *     SUPER_ADMIN_JWT = await mintSuperAdminToken(app);
 *   });
 *
 * Why a helper rather than a global Jest setup:
 *   - createApp() creates a fresh DB per test file. A global setup
 *     wouldn't know which DB to seed against.
 *   - Future test files can call this with their own app/dbPath.
 *   - When a second test file needs the same token shape, we extract
 *     to a global setup at that point — not before.
 *
 * The seeded user matches scripts/seed-super-admin.ts:
 *   - tenant_id:   '__platform__'
 *   - username:    'platform-admin'
 *   - role:        'Executive'
 *   - plane:       'business' / 'global_super_admin'
 *   - password:    randomly generated per test run, used only here
 */

import request  from "supertest";
import argon2   from "argon2";
import crypto   from "crypto";
import type { Express } from "express";
import type { Database as DB } from "better-sqlite3";
import { createApp } from "../../src/server";

// ─── Constants ────────────────────────────────────────────────────────────────

export const TEST_PLATFORM_TENANT = "__platform__";
export const TEST_SUPER_ADMIN_USERNAME = "platform-admin";
export const TEST_SUPER_ADMIN_EMAIL    = "admin@platform.local";

// Argon2 options mirror src/routes/users.ts so any login flow that
// re-verifies against the hash sees compatible parameters.
const ARGON2_OPTIONS: argon2.Options & { raw: false } = {
  type:        argon2.argon2id,
  memoryCost:  19_456,
  timeCost:    2,
  parallelism: 1,
  raw:         false,
};

// ─── App Factory for Tests ────────────────────────────────────────────────────

/**
 * Wraps createApp() with test-appropriate settings:
 *   - RECOMPUTE_SCHEDULER_ENABLED=false so the in-process timer doesn't
 *     fire during test runs (noisy logs, plus we don't want background
 *     writes interfering with assertions).
 *
 * Restores the env var after createApp() returns so subsequent code paths
 * (e.g. nested app instances in the same test) aren't affected.
 *
 * Use this in every Phase 15 test file instead of importing createApp
 * directly.
 */
export function createTestApp(dbPath: string): Express {
  const prior = process.env.RECOMPUTE_SCHEDULER_ENABLED;
  process.env.RECOMPUTE_SCHEDULER_ENABLED = "false";
  try {
    return createApp(dbPath);
  } finally {
    if (prior === undefined) delete process.env.RECOMPUTE_SCHEDULER_ENABLED;
    else                      process.env.RECOMPUTE_SCHEDULER_ENABLED = prior;
  }
}

// ─── Core ─────────────────────────────────────────────────────────────────────

/**
 * Seeds a global super-admin row and returns a freshly-minted JWT for it.
 * Idempotent: if the row already exists (e.g. another helper call earlier
 * in the same test process), the password is rotated and a fresh JWT is
 * returned. Returns the access_token string only — refresh tokens are
 * not used in test contexts.
 *
 * Throws on any unexpected outcome. Tests should let this throw so the
 * failure surfaces clearly; do not catch.
 */
export async function mintSuperAdminToken(app: Express): Promise<string> {
  const db = (app.locals as { db: DB }).db;
  if (!db) {
    throw new Error("mintSuperAdminToken: app.locals.db is not set");
  }

  // Generate a fresh password for this test run. Length is well above
  // the seed script's 12-char minimum.
  const password = `test-${crypto.randomBytes(16).toString("hex")}`;
  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
  const now = new Date().toISOString();

  // Check whether plane columns exist. If a future migration drops them,
  // this assertion produces a clear error instead of a confusing INSERT failure.
  const userCols = new Set(
    (db.prepare("PRAGMA table_info(users)").all() as { name: string }[])
      .map(r => r.name)
  );
  for (const col of ["control_plane", "plane_role", "plane_tenant_scope", "plane_assigned_at"]) {
    if (!userCols.has(col)) {
      throw new Error(`mintSuperAdminToken: users.${col} missing — migrations not run?`);
    }
  }

  // Upsert the super-admin row. Mirrors scripts/seed-super-admin.ts.
  const existing = db.prepare(
    "SELECT id FROM users WHERE tenant_id = ? AND username = ?"
  ).get(TEST_PLATFORM_TENANT, TEST_SUPER_ADMIN_USERNAME) as { id: string } | undefined;
  const userId = existing?.id ?? crypto.randomUUID();

  db.prepare(`
    INSERT INTO users (
      id, tenant_id, username, email, password_hash, role,
      failed_attempts, locked,
      created_at, updated_at,
      control_plane, plane_role, plane_tenant_scope, plane_assigned_at
    ) VALUES (
      ?, ?, ?, ?, ?, 'Executive',
      0, 0,
      ?, ?,
      'business', 'global_super_admin', NULL, ?
    )
    ON CONFLICT(tenant_id, username) DO UPDATE SET
      password_hash      = excluded.password_hash,
      role               = 'Executive',
      failed_attempts    = 0,
      locked             = 0,
      locked_until       = NULL,
      control_plane      = 'business',
      plane_role         = 'global_super_admin',
      plane_tenant_scope = NULL,
      plane_assigned_at  = excluded.plane_assigned_at,
      updated_at         = excluded.updated_at
  `).run(
    userId, TEST_PLATFORM_TENANT,
    TEST_SUPER_ADMIN_USERNAME, TEST_SUPER_ADMIN_EMAIL,
    passwordHash,
    now, now,
    now
  );

  // Mint JWT via the real /auth/login endpoint. This is intentional:
  // we exercise the same code path users hit, so any future regression
  // in the login flow breaks every Phase 15 test that uses this helper.
  const res = await request(app)
    .post("/auth/login")
    .send({
      username:  TEST_SUPER_ADMIN_USERNAME,
      password,
      tenant_id: TEST_PLATFORM_TENANT,
    });

  if (res.status !== 200) {
    throw new Error(
      `mintSuperAdminToken: login failed (HTTP ${res.status}): ${JSON.stringify(res.body)}`
    );
  }
  const token = (res.body as { access_token?: string }).access_token;
  if (!token) {
    throw new Error("mintSuperAdminToken: login response missing access_token");
  }
  return token;
}
