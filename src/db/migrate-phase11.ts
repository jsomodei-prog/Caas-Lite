/**
 * src/db/migrate-phase11.ts
 * Phase 11 schema migrations (versions 16–22).
 * Run with: npx ts-node --project tsconfig.json scripts/migrate-phase11.ts
 *
 * Adds:
 *   v16 — user_profiles extended profile table
 *   v17 — role_audit_log
 *   v18 — receipt_log (PDF tax receipts)
 *   v19 — job_queue (async processing queue)
 *   v20 — notification_log (Slack/Discord dispatch audit)
 *   v21 — agents.kyc_tier index + user_profiles country/freelancer indexes
 *   v22 — ANALYZE all tables for query-planner optimisation
 */

import { openDatabase, runMigrations } from "./migrate";
import type { Database as DB } from "better-sqlite3";

// ─── Helpers (duplicated from migrate.ts to keep this file standalone) ─────────

function existingColumns(db: DB, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return new Set(rows.map(r => r.name));
}

function addColumnIfMissing(db: DB, table: string, col: string, def: string): void {
  if (!existingColumns(db, table).has(col)) {
    db.prepare(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${def}`).run();
  }
}

function existingIndexes(db: DB): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map(r => r.name));
}

function createIndexIfMissing(db: DB, name: string, ddl: string): void {
  if (!existingIndexes(db).has(name)) db.prepare(ddl).run();
}

// ─── Phase 11 Migrations ───────────────────────────────────────────────────────

const PHASE11_MIGRATIONS = [
  {
    version: 16,
    description: "Create user_profiles extended profile table",
    up(db: DB) {
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
      createIndexIfMissing(db, "idx_user_profiles_tenant",
        "CREATE INDEX IF NOT EXISTS idx_user_profiles_tenant ON user_profiles(tenant_id)");
      createIndexIfMissing(db, "idx_user_profiles_country",
        "CREATE INDEX IF NOT EXISTS idx_user_profiles_country ON user_profiles(country_code)");
      createIndexIfMissing(db, "idx_user_profiles_freelancer",
        "CREATE INDEX IF NOT EXISTS idx_user_profiles_freelancer ON user_profiles(tenant_id, is_freelancer)");
    },
  },
  {
    version: 17,
    description: "Create role_audit_log table",
    up(db: DB) {
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
      createIndexIfMissing(db, "idx_role_audit_tenant",
        "CREATE INDEX IF NOT EXISTS idx_role_audit_tenant ON role_audit_log(tenant_id, created_at DESC)");
      createIndexIfMissing(db, "idx_role_audit_target",
        "CREATE INDEX IF NOT EXISTS idx_role_audit_target ON role_audit_log(target_user_id, created_at DESC)");
    },
  },
  {
    version: 18,
    description: "Create receipt_log table for signed PDF tax receipts",
    up(db: DB) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS receipt_log (
          id               TEXT PRIMARY KEY,
          receipt_type     TEXT NOT NULL,
          payout_log_id    TEXT REFERENCES payout_logs(id),
          tenant_id        TEXT NOT NULL,
          country_code     TEXT NOT NULL,
          file_path        TEXT NOT NULL,
          file_size_bytes  INTEGER NOT NULL DEFAULT 0,
          signature        TEXT NOT NULL,
          generated_at     TEXT NOT NULL,
          period_start     TEXT,
          period_end       TEXT
        )
      `).run();
      createIndexIfMissing(db, "idx_receipt_log_tenant",
        "CREATE INDEX IF NOT EXISTS idx_receipt_log_tenant ON receipt_log(tenant_id, generated_at DESC)");
      createIndexIfMissing(db, "idx_receipt_log_payout",
        "CREATE INDEX IF NOT EXISTS idx_receipt_log_payout ON receipt_log(payout_log_id)");
      createIndexIfMissing(db, "idx_receipt_log_country",
        "CREATE INDEX IF NOT EXISTS idx_receipt_log_country ON receipt_log(country_code, generated_at DESC)");
    },
  },
  {
    version: 19,
    description: "Create job_queue table for async processing queue",
    up(db: DB) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS job_queue (
          id              TEXT PRIMARY KEY,
          type            TEXT NOT NULL,
          payload_json    TEXT NOT NULL,
          priority        TEXT NOT NULL DEFAULT 'normal',
          status          TEXT NOT NULL DEFAULT 'queued',
          attempts        INTEGER NOT NULL DEFAULT 0,
          max_attempts    INTEGER NOT NULL DEFAULT 3,
          idempotency_key TEXT UNIQUE,
          result_json     TEXT,
          error           TEXT,
          queued_at       TEXT NOT NULL,
          started_at      TEXT,
          completed_at    TEXT,
          next_attempt_at TEXT
        )
      `).run();
      createIndexIfMissing(db, "idx_job_queue_status_priority",
        "CREATE INDEX IF NOT EXISTS idx_job_queue_status_priority ON job_queue(status, priority, next_attempt_at)");
      createIndexIfMissing(db, "idx_job_queue_type",
        "CREATE INDEX IF NOT EXISTS idx_job_queue_type ON job_queue(type, status)");
      createIndexIfMissing(db, "idx_job_queue_completed",
        "CREATE INDEX IF NOT EXISTS idx_job_queue_completed ON job_queue(completed_at DESC)");
    },
  },
  {
    version: 20,
    description: "Create notification_log table for Slack/Discord dispatch audit",
    up(db: DB) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS notification_log (
          id            TEXT PRIMARY KEY,
          incident_id   TEXT NOT NULL,
          incident_type TEXT NOT NULL,
          severity      TEXT NOT NULL,
          tenant_id     TEXT NOT NULL,
          channel       TEXT NOT NULL,
          success       INTEGER NOT NULL DEFAULT 0,
          status_code   INTEGER,
          error         TEXT,
          dispatched_at TEXT NOT NULL
        )
      `).run();
      createIndexIfMissing(db, "idx_notification_log_tenant",
        "CREATE INDEX IF NOT EXISTS idx_notification_log_tenant ON notification_log(tenant_id, dispatched_at DESC)");
      createIndexIfMissing(db, "idx_notification_log_severity",
        "CREATE INDEX IF NOT EXISTS idx_notification_log_severity ON notification_log(severity, dispatched_at DESC)");
    },
  },
  {
    version: 21,
    description: "Add Phase 11 supporting indexes for profile and freelancer queries",
    up(db: DB) {
      // agents.kyc_tier was added in migration 9 but lacked a covering index for freelancer queries
      createIndexIfMissing(db, "idx_agents_kyc_tier",
        "CREATE INDEX IF NOT EXISTS idx_agents_kyc_tier ON agents(kyc_tier, country_code)");
      createIndexIfMissing(db, "idx_agents_freelancer_sweep",
        "CREATE INDEX IF NOT EXISTS idx_agents_freelancer_sweep ON agents(tenant_id, locked, balance_usd, payout_threshold_usd)");
      // Extend agents with api_key support
      addColumnIfMissing(db, "agents", "api_key_hash",   "TEXT");
      addColumnIfMissing(db, "agents", "api_key_prefix", "TEXT");
    },
  },
  {
    version: 22,
    description: "ANALYZE all tables — refresh query-planner statistics",
    up(db: DB) {
      db.prepare("ANALYZE").run();
    },
  },
];

// ─── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = openDatabase();

  // First ensure base migrations (1–15) are all applied.
  runMigrations(db);

  // Apply Phase 11 migrations.
  const appliedVersions = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[])
      .map(r => r.version)
  );

  for (const migration of PHASE11_MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      console.log(`[migrate-p11] ↷ ${String(migration.version).padStart(3,"0")} ${migration.description} (skipped)`);
      continue;
    }
    const start = Date.now();
    db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.description, new Date().toISOString());
    })();
    console.log(`[migrate-p11] ✓ ${String(migration.version).padStart(3,"0")} ${migration.description} (${Date.now()-start}ms)`);
  }

  const version = (db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number }).v;
  console.log(`\nSchema now at version ${version}.`);

  // Print table list
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[];
  console.log(`\nTables (${tables.length}):`);
  tables.forEach(t => console.log(`  ${t.name}`));

  db.close();
}

main().catch(err => { console.error("Migration failed:", err); process.exit(1); });
