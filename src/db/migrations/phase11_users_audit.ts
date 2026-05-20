/**
 * src/db/migrations/phase11_users_audit.ts
 *
 * Migration v28: promotes the schema for `user_profiles` and `role_audit_log`
 * from inline DDL in src/routes/users.ts to the canonical migration system.
 *
 * Background (slice 6d):
 *   Until this migration, these two tables were created by an
 *   `ensureUserProfileTable(db)` helper called at handler entry in
 *   src/routes/users.ts. That meant the schema lived in route code, not in
 *   migrations. Consequences:
 *
 *     - Boot paths that don't load the users router (migration-only ops
 *       containers, tests that import a subset of the app) would silently
 *       not have these tables. /readyz could report "ready" while the
 *       schema was incomplete.
 *
 *     - Schema changes required editing route code AND migrations,
 *       creating two-source-of-truth drift.
 *
 *   This migration moves the tables to where they belong. The inline DDL
 *   in users.ts is deleted in the same commit (`ensureUserProfileTable`
 *   function removed; all call sites removed).
 *
 *   Both `CREATE TABLE` statements use `IF NOT EXISTS`, so this migration
 *   is safe to run against existing databases where the tables were
 *   previously created by the inline DDL. No data is touched.
 *
 * Why this is a sibling file rather than appended to migrate.ts directly:
 *   Matches the established pattern from
 *   src/db/migrations/phase15_commercial_activation.ts. Each phase's
 *   migrations get their own file, exported and spread into the canonical
 *   MIGRATIONS array in migrate.ts.
 *
 * Known follow-ups not covered by this migration (slice 6d-extended):
 *   The pattern of inline DDL in non-migration files appears to extend to
 *   `receipt_log`, `job_queue`, and `notification_log` — three tables
 *   declared in the now-dead `src/db/migrate-phase11.ts` but actually
 *   created elsewhere. Each needs the same audit + promotion treatment.
 *   Flagged for a follow-up migration pass.
 */

import type { Database as DB } from "better-sqlite3";

interface Migration {
  version:     number;
  description: string;
  up:          (db: DB) => void;
}

export const PHASE11_USERS_AUDIT_MIGRATIONS: Migration[] = [
  {
    version: 28,
    description: "Phase 11 — promote user_profiles + role_audit_log from inline DDL to migrations",
    up(db: DB): void {
      // ── user_profiles ────────────────────────────────────────────────────
      // Body is identical to the version that lived in
      // src/routes/users.ts:ensureUserProfileTable. The `IF NOT EXISTS`
      // means this is a no-op on DBs that were previously seeded by the
      // route-file's inline DDL.
      db.prepare(`
        CREATE TABLE IF NOT EXISTS user_profiles (
          user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          tenant_id          TEXT NOT NULL,
          display_name       TEXT,
          phone              TEXT,
          country_code       TEXT,
          preferred_currency TEXT,
          kyc_tier           TEXT NOT NULL DEFAULT 'basic',
          profile_status     TEXT NOT NULL DEFAULT 'active',
          is_freelancer      INTEGER NOT NULL DEFAULT 0,
          agent_id           TEXT REFERENCES agents(id),
          bio                TEXT,
          api_key_hash       TEXT,
          api_key_prefix     TEXT,
          mfa_enabled        INTEGER NOT NULL DEFAULT 0,
          created_at         TEXT NOT NULL,
          updated_at         TEXT NOT NULL
        )
      `).run();

      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_user_profiles_tenant
         ON user_profiles(tenant_id)`
      ).run();

      // ── role_audit_log ───────────────────────────────────────────────────
      // Same DDL as ensureUserProfileTable's second CREATE.
      db.prepare(`
        CREATE TABLE IF NOT EXISTS role_audit_log (
          id              TEXT PRIMARY KEY,
          tenant_id       TEXT NOT NULL,
          target_user_id  TEXT NOT NULL,
          actor_user_id   TEXT NOT NULL,
          action          TEXT NOT NULL,
          old_value       TEXT,
          new_value       TEXT,
          reason          TEXT,
          created_at      TEXT NOT NULL
        )
      `).run();

      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_role_audit_tenant
         ON role_audit_log(tenant_id, created_at DESC)`
      ).run();

      // Note: the slice 5 grep showed users.ts only creates
      // `idx_role_audit_tenant`, not `idx_role_audit_target`. The dead
      // `migrate-phase11.ts` declared both, but the live inline DDL only
      // created the tenant index. Preserving that exact set to avoid
      // creating an index the production DB has never had.
    },
  },
];
