/**
 * scripts/seed-super-admin.ts
 * Idempotent seed for the platform's global super admin.
 *
 * Inserts (or updates) a single user occupying the BUSINESS control plane
 * with plane_role 'global_super_admin'. Safe to run repeatedly:
 * uses ON CONFLICT(tenant_id, username) DO UPDATE so re-running with a
 * new password rotates the credential in place without creating a duplicate.
 *
 * Requires:
 *   SEED_SUPER_ADMIN_PASSWORD    (required, min 12 chars)
 *   SEED_SUPER_ADMIN_USERNAME    (optional, default: 'platform-admin')
 *   SEED_SUPER_ADMIN_EMAIL       (optional, default: 'admin@platform.local')
 *   DB_PATH                      (optional, default: /data/caas_evidence.db)
 *
 * Run:
 *   $env:SEED_SUPER_ADMIN_PASSWORD="..."; $env:DB_PATH="data\caas_evidence.db"
 *   npx ts-node --project tsconfig.json scripts/seed-super-admin.ts
 *
 * Phase 14 follow-up | depends on migrate.ts v4 + phase12_roles.ts v31
 */

import crypto from "crypto";
import argon2 from "argon2";
import { openDatabase } from "../src/db/migrate";

// ─── Constants ────────────────────────────────────────────────────────────────

// Reserved sentinel tenant for business-plane users. users.tenant_id is
// NOT NULL, but plane_tenant_scope is NULL for cross-tenant operators —
// this value satisfies the constraint without masquerading as a real tenant.
const PLATFORM_TENANT = "__platform__";

const DEFAULT_USERNAME = "platform-admin";
const DEFAULT_EMAIL    = "admin@platform.local";

// Match src/routes/users.ts exactly so credentials hashed here verify
// against the same argon2 parameters the login path uses.
const ARGON2_OPTIONS: argon2.Options & { raw: false } = {
  type:        argon2.argon2id,
  memoryCost:  19_456,
  timeCost:    2,
  parallelism: 1,
  raw:         false,
};

const MIN_PASSWORD_LENGTH = 12;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (!password) {
    console.error(
      "[seed-super-admin] SEED_SUPER_ADMIN_PASSWORD is not set.\n" +
      "  PowerShell:  $env:SEED_SUPER_ADMIN_PASSWORD = \"...\"\n" +
      "  bash:        export SEED_SUPER_ADMIN_PASSWORD='...'"
    );
    process.exit(1);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `[seed-super-admin] SEED_SUPER_ADMIN_PASSWORD must be at least ` +
      `${MIN_PASSWORD_LENGTH} characters (got ${password.length}).`
    );
    process.exit(1);
  }

  const username = process.env.SEED_SUPER_ADMIN_USERNAME ?? DEFAULT_USERNAME;
  const email    = process.env.SEED_SUPER_ADMIN_EMAIL    ?? DEFAULT_EMAIL;

  // openDatabase() runs all pending migrations on connect, so we are
  // guaranteed v4 (users) and v31 (plane columns) are present before insert.
  const db = openDatabase();

  // Sanity check: confirm the plane columns actually exist. If phase12_roles
  // has not been run yet against this DB, fail clearly rather than insert
  // a half-populated row.
  const userCols = new Set(
    (db.prepare("PRAGMA table_info(users)").all() as { name: string }[])
      .map(r => r.name)
  );
  for (const required of ["control_plane", "plane_role", "plane_tenant_scope", "plane_assigned_at"]) {
    if (!userCols.has(required)) {
      console.error(
        `[seed-super-admin] users.${required} is missing. Run ` +
        `phase12_roles migrations first (or unify the runners).`
      );
      db.close();
      process.exit(1);
    }
  }

  const passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
  const now          = new Date().toISOString();

  // Look up existing row first so we know whether this run is INSERT or UPDATE
  // for the log line at the end. ON CONFLICT handles both cases uniformly.
  const existing = db.prepare(
    "SELECT id FROM users WHERE tenant_id = ? AND username = ?"
  ).get(PLATFORM_TENANT, username) as { id: string } | undefined;

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
      email              = excluded.email,
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
    userId, PLATFORM_TENANT, username, email, passwordHash,
    now, now,
    now
  );

  // Read back so the operator can see exactly what landed in the DB.
  const row = db.prepare(`
    SELECT id, tenant_id, username, email, role,
           control_plane, plane_role, plane_tenant_scope,
           plane_assigned_at, created_at, updated_at
    FROM users
    WHERE tenant_id = ? AND username = ?
  `).get(PLATFORM_TENANT, username);

  console.log(
    `[seed-super-admin] ${existing ? "↻ updated" : "✓ created"} super admin:\n` +
    JSON.stringify(row, null, 2)
  );
  console.log(
    `\nLog in with username "${username}" against tenant "${PLATFORM_TENANT}".\n` +
    `Plane: business / global_super_admin (no tenant scope).`
  );

  db.close();
}

main().catch(err => {
  console.error("[seed-super-admin] Fatal:", err);
  process.exit(1);
});
