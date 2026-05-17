/**
 * src/db/migrate.ts
 *
 * Versioned, idempotent, transaction-wrapped SQLite migration runner.
 *
 * Design principles:
 *  - Every migration runs inside a single SQLite transaction; it either
 *    applies completely or rolls back completely.
 *  - All migrations are idempotent: safe to run on an existing database.
 *    Column additions are guarded with PRAGMA table_info checks because
 *    SQLite's ALTER TABLE does not support IF NOT EXISTS.
 *  - A `schema_migrations` table tracks applied versions; already-applied
 *    migrations are skipped without error.
 *  - Migrations are ordered by integer version and executed sequentially.
 *  - The runner is invoked at application start (before the HTTP server
 *    binds) so the schema is always current on deployment.
 *
 * Baseline commit : a4f5db6
 * Covers          : all tables up to and including Phase 9 + FX build-out.
 */

import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Migration {
  version: number;
  description: string;
  up: (db: DB) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the set of column names that currently exist on a table. */
function existingColumns(db: DB, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

/** Returns the set of index names that currently exist. */
function existingIndexes(db: DB): Set<string> {
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
    .all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Returns true when a table exists in the database. */
function tableExists(db: DB, table: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`
    )
    .get(table);
  return row !== undefined;
}

/**
 * Adds a column to a table only if it is not already present.
 * SQLite ALTER TABLE ADD COLUMN does not support IF NOT EXISTS.
 */
function addColumnIfMissing(
  db: DB,
  table: string,
  column: string,
  definition: string
): void {
  if (!existingColumns(db, table).has(column)) {
    db.prepare(
      `ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`
    ).run();
  }
}

/** Creates an index only when it does not already exist. */
function createIndexIfMissing(
  db: DB,
  indexName: string,
  ddl: string
): void {
  if (!existingIndexes(db).has(indexName)) {
    db.prepare(ddl).run();
  }
}

// ─── Migration Definitions ────────────────────────────────────────────────────

const MIGRATIONS: Migration[] = [

  // ── 001 ── Bootstrap schema_migrations tracking table ─────────────────────
  {
    version: 1,
    description: "Create schema_migrations tracking table",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version     INTEGER PRIMARY KEY,
          description TEXT    NOT NULL,
          applied_at  TEXT    NOT NULL
        )
      `).run();
    },
  },

  // ── 002 ── Core agent table (Phase 1–8 baseline) ──────────────────────────
  {
    version: 2,
    description: "Create agents table (Phase 1–8 baseline)",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS agents (
          id                   TEXT    PRIMARY KEY,
          tenant_id            TEXT    NOT NULL,
          name                 TEXT    NOT NULL,
          balance_usd          REAL    NOT NULL DEFAULT 0,
          payout_method        TEXT,
          card_token           TEXT,
          payout_threshold_usd REAL    NOT NULL DEFAULT 0,
          locked               INTEGER NOT NULL DEFAULT 0,
          lockout_until        TEXT,
          shadow_scan_until    TEXT,
          momo_number          TEXT,
          momo_provider        TEXT,
          created_at           TEXT    NOT NULL,
          updated_at           TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(
        db,
        "idx_agents_tenant_id",
        `CREATE INDEX IF NOT EXISTS idx_agents_tenant_id
         ON agents (tenant_id)`
      );
      createIndexIfMissing(
        db,
        "idx_agents_tenant_locked",
        `CREATE INDEX IF NOT EXISTS idx_agents_tenant_locked
         ON agents (tenant_id, locked)`
      );
    },
  },

  // ── 003 ── Payout logs table (Phase 1–8 baseline) ─────────────────────────
  {
    version: 3,
    description: "Create payout_logs table (Phase 1–8 baseline)",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS payout_logs (
          id                 TEXT    PRIMARY KEY,
          agent_id           TEXT    NOT NULL REFERENCES agents(id),
          tenant_id          TEXT    NOT NULL,
          amount_usd         REAL    NOT NULL,
          method             TEXT    NOT NULL,
          idempotency_key    TEXT    NOT NULL UNIQUE,
          signature          TEXT    NOT NULL,
          status             TEXT    NOT NULL DEFAULT 'pending',
          provider_reference TEXT,
          failure_reason     TEXT,
          created_at         TEXT    NOT NULL,
          settled_at         TEXT
        )
      `).run();

      createIndexIfMissing(
        db,
        "idx_payout_logs_tenant_id",
        `CREATE INDEX IF NOT EXISTS idx_payout_logs_tenant_id
         ON payout_logs (tenant_id, created_at DESC)`
      );
      createIndexIfMissing(
        db,
        "idx_payout_logs_agent_id",
        `CREATE INDEX IF NOT EXISTS idx_payout_logs_agent_id
         ON payout_logs (agent_id, created_at DESC)`
      );
      createIndexIfMissing(
        db,
        "idx_payout_logs_idempotency_key",
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_logs_idempotency_key
         ON payout_logs (idempotency_key)`
      );
      createIndexIfMissing(
        db,
        "idx_payout_logs_status",
        `CREATE INDEX IF NOT EXISTS idx_payout_logs_status
         ON payout_logs (status, created_at DESC)`
      );
    },
  },

  // ── 004 ── Users table (Phase 9 auth) ─────────────────────────────────────
  {
    version: 4,
    description: "Create users table",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS users (
          id                TEXT    PRIMARY KEY,
          tenant_id         TEXT    NOT NULL,
          username          TEXT    NOT NULL,
          email             TEXT    NOT NULL,
          password_hash     TEXT    NOT NULL,
          role              TEXT    NOT NULL DEFAULT 'Partner',
          failed_attempts   INTEGER NOT NULL DEFAULT 0,
          locked            INTEGER NOT NULL DEFAULT 0,
          locked_until      TEXT,
          shadow_scan_until TEXT,
          last_login_at     TEXT,
          created_at        TEXT    NOT NULL,
          updated_at        TEXT    NOT NULL,
          UNIQUE (tenant_id, username),
          UNIQUE (tenant_id, email)
        )
      `).run();

      createIndexIfMissing(
        db,
        "idx_users_tenant_username",
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_username
         ON users (tenant_id, username)`
      );
      createIndexIfMissing(
        db,
        "idx_users_tenant_email",
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email
         ON users (tenant_id, email)`
      );
    },
  },

  // ── 005 ── Refresh tokens table ────────────────────────────────────────────
  {
    version: 5,
    description: "Create refresh_tokens table",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS refresh_tokens (
          id          TEXT    PRIMARY KEY,
          user_id     TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash  TEXT    NOT NULL UNIQUE,
          expires_at  TEXT    NOT NULL,
          revoked     INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(
        db,
        "idx_refresh_tokens_user_id",
        `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id
         ON refresh_tokens (user_id, revoked)`
      );
      createIndexIfMissing(
        db,
        "idx_refresh_tokens_hash",
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_tokens_hash
         ON refresh_tokens (token_hash)`
      );
      createIndexIfMissing(
        db,
        "idx_refresh_tokens_expires",
        `CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
         ON refresh_tokens (expires_at)`
      );
    },
  },

  // ── 006 ── Anomaly logs table (Phase 9 analytics) ─────────────────────────
  {
    version: 6,
    description: "Create anomaly_logs table",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS anomaly_logs (
          id               TEXT    PRIMARY KEY,
          entity_id        TEXT    NOT NULL,
          entity_type      TEXT    NOT NULL,
          tenant_id        TEXT    NOT NULL,
          event_type       TEXT    NOT NULL,
          observed_value   REAL    NOT NULL,
          risk_level       TEXT    NOT NULL,
          score            INTEGER NOT NULL,
          context_json     TEXT    NOT NULL DEFAULT '{}',
          lockout_applied  TEXT,
          lockout_until    TEXT,
          alert_dispatched INTEGER NOT NULL DEFAULT 0,
          created_at       TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(
        db,
        "idx_anomaly_logs_tenant_created",
        `CREATE INDEX IF NOT EXISTS idx_anomaly_logs_tenant_created
         ON anomaly_logs (tenant_id, created_at DESC)`
      );
      createIndexIfMissing(
        db,
        "idx_anomaly_logs_entity",
        `CREATE INDEX IF NOT EXISTS idx_anomaly_logs_entity
         ON anomaly_logs (entity_id, event_type, created_at DESC)`
      );
      createIndexIfMissing(
        db,
        "idx_anomaly_logs_risk_level",
        `CREATE INDEX IF NOT EXISTS idx_anomaly_logs_risk_level
         ON anomaly_logs (tenant_id, risk_level, created_at DESC)`
      );
    },
  },

  // ── 007 ── IP lockouts table (anomaly auto-lockout) ───────────────────────
  {
    version: 7,
    description: "Create ip_lockouts table",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS ip_lockouts (
          ip          TEXT PRIMARY KEY,
          locked_until TEXT NOT NULL,
          created_at   TEXT NOT NULL
        )
      `).run();

      createIndexIfMissing(
        db,
        "idx_ip_lockouts_locked_until",
        `CREATE INDEX IF NOT EXISTS idx_ip_lockouts_locked_until
         ON ip_lockouts (locked_until)`
      );
    },
  },

  // ── 008 ── Phase 9 agents columns: payout_method, card_token, threshold ───
  //           These may already exist on databases upgraded from Phase 8.
  {
    version: 8,
    description:
      "Add Phase 9 extended agent columns: payout_method, card_token, payout_threshold_usd",
    up(db) {
      // payout_method and card_token were in the Phase 9 schema spec.
      // payout_threshold_usd replaces the legacy balance-fraction approach.
      addColumnIfMissing(db, "agents", "payout_method",        "TEXT");
      addColumnIfMissing(db, "agents", "card_token",           "TEXT");
      addColumnIfMissing(
        db, "agents", "payout_threshold_usd", "REAL NOT NULL DEFAULT 0"
      );
    },
  },

  // ── 009 ── Phase 9 FX build-out: agents.country_code + kyc_tier ──────────
  {
    version: 9,
    description: "Add agents.country_code and agents.kyc_tier for FX routing",
    up(db) {
      addColumnIfMissing(db, "agents", "country_code", "TEXT");
      addColumnIfMissing(db, "agents", "kyc_tier",     "TEXT NOT NULL DEFAULT 'basic'");

      createIndexIfMissing(
        db,
        "idx_agents_country_code",
        `CREATE INDEX IF NOT EXISTS idx_agents_country_code
         ON agents (country_code)`
      );
    },
  },

  // ── 010 ── Phase 9 FX build-out: payout_logs local-currency columns ───────
  {
    version: 10,
    description:
      "Add FX and local-currency columns to payout_logs: " +
      "local_amount, local_currency, fx_mid_rate, fx_effective_rate, " +
      "fx_rate_id, withholding_tax_local, regulatory_report_filed",
    up(db) {
      addColumnIfMissing(db, "payout_logs", "local_amount",           "REAL NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "payout_logs", "local_currency",         "TEXT NOT NULL DEFAULT 'USD'");
      addColumnIfMissing(db, "payout_logs", "fx_mid_rate",            "REAL NOT NULL DEFAULT 1");
      addColumnIfMissing(db, "payout_logs", "fx_effective_rate",      "REAL NOT NULL DEFAULT 1");
      addColumnIfMissing(db, "payout_logs", "fx_rate_id",             "TEXT");
      addColumnIfMissing(
        db, "payout_logs", "withholding_tax_local",    "REAL NOT NULL DEFAULT 0"
      );
      addColumnIfMissing(
        db, "payout_logs", "regulatory_report_filed",  "INTEGER NOT NULL DEFAULT 0"
      );

      createIndexIfMissing(
        db,
        "idx_payout_logs_local_currency",
        `CREATE INDEX IF NOT EXISTS idx_payout_logs_local_currency
         ON payout_logs (local_currency, created_at DESC)`
      );
      createIndexIfMissing(
        db,
        "idx_payout_logs_fx_rate_id",
        `CREATE INDEX IF NOT EXISTS idx_payout_logs_fx_rate_id
         ON payout_logs (fx_rate_id)`
      );
      createIndexIfMissing(
        db,
        "idx_payout_logs_regulatory",
        `CREATE INDEX IF NOT EXISTS idx_payout_logs_regulatory
         ON payout_logs (regulatory_report_filed, created_at DESC)`
      );
    },
  },

  // ── 011 ── FX rate cache table ─────────────────────────────────────────────
  {
    version: 11,
    description: "Create fx_rate_cache table",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS fx_rate_cache (
          rate_id          TEXT    PRIMARY KEY,
          base             TEXT    NOT NULL DEFAULT 'USD',
          target           TEXT    NOT NULL,
          mid_rate         REAL    NOT NULL,
          spread_fraction  REAL    NOT NULL,
          effective_rate   REAL    NOT NULL,
          provider         TEXT    NOT NULL,
          fetched_at       TEXT    NOT NULL,
          expires_at       TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(
        db,
        "idx_fx_rate_cache_target_expires",
        `CREATE INDEX IF NOT EXISTS idx_fx_rate_cache_target_expires
         ON fx_rate_cache (target, expires_at DESC)`
      );
      createIndexIfMissing(
        db,
        "idx_fx_rate_cache_fetched_at",
        `CREATE INDEX IF NOT EXISTS idx_fx_rate_cache_fetched_at
         ON fx_rate_cache (fetched_at DESC)`
      );
    },
  },

  // ── 012 ── FX conversion audit log ────────────────────────────────────────
  {
    version: 12,
    description: "Create fx_conversion_log table",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS fx_conversion_log (
          id               TEXT    PRIMARY KEY,
          rate_id          TEXT    NOT NULL REFERENCES fx_rate_cache(rate_id),
          payout_log_id    TEXT    REFERENCES payout_logs(id),
          amount_usd       REAL    NOT NULL,
          local_amount     REAL    NOT NULL,
          local_currency   TEXT    NOT NULL,
          mid_rate         REAL    NOT NULL,
          effective_rate   REAL    NOT NULL,
          provider         TEXT    NOT NULL,
          created_at       TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(
        db,
        "idx_fx_conversion_log_payout_log_id",
        `CREATE INDEX IF NOT EXISTS idx_fx_conversion_log_payout_log_id
         ON fx_conversion_log (payout_log_id)`
      );
      createIndexIfMissing(
        db,
        "idx_fx_conversion_log_rate_id",
        `CREATE INDEX IF NOT EXISTS idx_fx_conversion_log_rate_id
         ON fx_conversion_log (rate_id)`
      );
      createIndexIfMissing(
        db,
        "idx_fx_conversion_log_currency_created",
        `CREATE INDEX IF NOT EXISTS idx_fx_conversion_log_currency_created
         ON fx_conversion_log (local_currency, created_at DESC)`
      );
    },
  },

  // ── 013 ── Enforce WAL journal mode + foreign key pragmas ─────────────────
  //           WAL is the correct journal mode for a concurrent web server.
  //           Foreign key enforcement is off by default in SQLite.
  {
    version: 13,
    description:
      "Enable WAL journal mode, foreign key enforcement, and recommended PRAGMAs",
    up(db) {
      // These are connection-level PRAGMAs, not persisted schema changes,
      // but recording them here documents the required startup settings and
      // ensures they are applied on every fresh database as part of migration.
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      db.pragma("synchronous = NORMAL"); // Safe with WAL; faster than FULL
      db.pragma("temp_store = MEMORY");
      db.pragma("mmap_size = 268435456"); // 256 MiB
      db.pragma("cache_size = -16000");   // 16 MiB page cache
    },
  },

  // ── 014 ── Compliance report audit table ───────────────────────────────────
  //           SHA-256 signed compliance reports from the existing report
  //           builder need a storage table.
  {
    version: 14,
    description: "Create compliance_reports table for signed report storage",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS compliance_reports (
          id              TEXT    PRIMARY KEY,
          tenant_id       TEXT    NOT NULL,
          report_type     TEXT    NOT NULL,
          industry_profile TEXT   NOT NULL,
          payload_json    TEXT    NOT NULL,
          signature       TEXT    NOT NULL,
          generated_by    TEXT    NOT NULL,
          generated_at    TEXT    NOT NULL,
          period_start    TEXT,
          period_end      TEXT
        )
      `).run();

      createIndexIfMissing(
        db,
        "idx_compliance_reports_tenant_generated",
        `CREATE INDEX IF NOT EXISTS idx_compliance_reports_tenant_generated
         ON compliance_reports (tenant_id, generated_at DESC)`
      );
      createIndexIfMissing(
        db,
        "idx_compliance_reports_type",
        `CREATE INDEX IF NOT EXISTS idx_compliance_reports_type
         ON compliance_reports (tenant_id, report_type, generated_at DESC)`
      );
    },
  },

  // ── 015 ── Regulatory reports filing log ──────────────────────────────────
  {
    version: 15,
    description: "Create regulatory_report_log table",
    up(db) {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS regulatory_report_log (
          id              TEXT    PRIMARY KEY,
          payout_log_id   TEXT    NOT NULL REFERENCES payout_logs(id),
          tenant_id       TEXT    NOT NULL,
          country_code    TEXT    NOT NULL,
          authority       TEXT    NOT NULL,
          legal_ref       TEXT    NOT NULL,
          threshold_local REAL    NOT NULL,
          local_amount    REAL    NOT NULL,
          local_currency  TEXT    NOT NULL,
          amount_usd      REAL    NOT NULL,
          must_file_by    TEXT    NOT NULL,
          signature       TEXT    NOT NULL,
          dispatched_at   TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(
        db,
        "idx_regulatory_report_log_tenant",
        `CREATE INDEX IF NOT EXISTS idx_regulatory_report_log_tenant
         ON regulatory_report_log (tenant_id, dispatched_at DESC)`
      );
      createIndexIfMissing(
        db,
        "idx_regulatory_report_log_payout",
        `CREATE INDEX IF NOT EXISTS idx_regulatory_report_log_payout
         ON regulatory_report_log (payout_log_id)`
      );
      createIndexIfMissing(
        db,
        "idx_regulatory_report_log_must_file_by",
        `CREATE INDEX IF NOT EXISTS idx_regulatory_report_log_must_file_by
         ON regulatory_report_log (must_file_by)`
      );
    },
  },

];

// ─── Migration Runner ─────────────────────────────────────────────────────────

export interface MigrationResult {
  version: number;
  description: string;
  status: "applied" | "skipped";
  duration_ms: number;
}

export interface RunMigrationsResult {
  database: string;
  total_migrations: number;
  applied: number;
  skipped: number;
  results: MigrationResult[];
}

/**
 * Bootstraps the schema_migrations table if it does not yet exist,
 * then runs all pending migrations in order.
 *
 * Safe to call on every application start.  Already-applied migrations
 * are skipped; only new ones execute.  Each migration is wrapped in its
 * own SQLite transaction.
 *
 * @param db   An open better-sqlite3 Database handle.
 * @returns    A summary of applied/skipped migrations for logging.
 */
export function runMigrations(db: DB): RunMigrationsResult {
  const dbPath =
    (db as unknown as { name: string }).name ?? "unknown";

  // Ensure the tracking table exists before we query it.
  db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      description TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL
    )
  `).run();

  const appliedVersions = new Set(
    (
      db
        .prepare("SELECT version FROM schema_migrations")
        .all() as { version: number }[]
    ).map((r) => r.version)
  );

  const results: MigrationResult[] = [];
  let applied = 0;
  let skipped = 0;

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      results.push({
        version: migration.version,
        description: migration.description,
        status: "skipped",
        duration_ms: 0,
      });
      skipped++;
      continue;
    }

    const start = Date.now();

    // Wrap each migration in a transaction so a failure mid-migration
    // leaves the database in its prior clean state.
    const runMigration = db.transaction(() => {
      migration.up(db);
      db.prepare(
        `INSERT INTO schema_migrations (version, description, applied_at)
         VALUES (?, ?, ?)`
      ).run(migration.version, migration.description, new Date().toISOString());
    });

    runMigration();

    const duration_ms = Date.now() - start;

    results.push({
      version: migration.version,
      description: migration.description,
      status: "applied",
      duration_ms,
    });
    applied++;

    console.log(
      `[migrate] ✓ ${String(migration.version).padStart(3, "0")} ` +
        `${migration.description} (${duration_ms}ms)`
    );
  }

  return {
    database: dbPath,
    total_migrations: MIGRATIONS.length,
    applied,
    skipped,
    results,
  };
}

/**
 * Returns the current applied migration version (highest version number
 * in schema_migrations), or 0 if no migrations have been applied.
 */
export function getCurrentVersion(db: DB): number {
  if (!tableExists(db, "schema_migrations")) return 0;
  const row = db
    .prepare(
      "SELECT MAX(version) as v FROM schema_migrations"
    )
    .get() as { v: number | null };
  return row.v ?? 0;
}

/**
 * Returns all migrations that have not yet been applied to the database.
 */
export function getPendingMigrations(db: DB): Migration[] {
  if (!tableExists(db, "schema_migrations")) return [...MIGRATIONS];
  const applied = new Set(
    (
      db
        .prepare("SELECT version FROM schema_migrations")
        .all() as { version: number }[]
    ).map((r) => r.version)
  );
  return MIGRATIONS.filter((m) => !applied.has(m.version));
}

/**
 * Returns the full applied-migration history from schema_migrations.
 */
export function getMigrationHistory(
  db: DB
): { version: number; description: string; applied_at: string }[] {
  if (!tableExists(db, "schema_migrations")) return [];
  return db
    .prepare("SELECT * FROM schema_migrations ORDER BY version ASC")
    .all() as { version: number; description: string; applied_at: string }[];
}

// ─── Database Factory ─────────────────────────────────────────────────────────

/**
 * Opens (or creates) the CaaS SQLite database, applies all pending migrations,
 * and returns a ready-to-use handle.
 *
 * This is the single entry point for obtaining a database connection.
 * Use it in `src/app.ts` / `src/index.ts` during application boot:
 *
 * ```typescript
 * import { openDatabase } from "./db/migrate";
 * const db = openDatabase();
 * app.locals.db = db;
 * ```
 *
 * @param dbPath  Path to the SQLite file.  Defaults to the value of the
 *                DB_PATH environment variable, then "/data/caas_evidence.db".
 */
export function openDatabase(
  dbPath: string = process.env.DB_PATH ?? "/data/caas_evidence.db"
): DB {
  const db = new Database(dbPath);

  // Apply connection-level settings that are not persisted per-file.
  // These duplicate migration 013 intentionally: any existing connection
  // opened after migrations run must also have these settings applied.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("mmap_size = 268435456");
  db.pragma("cache_size = -16000");

  const result = runMigrations(db);

  if (result.applied > 0) {
    console.log(
      `[migrate] Database at "${dbPath}": ` +
        `${result.applied} migration(s) applied, ` +
        `${result.skipped} skipped. ` +
        `Schema now at version ${getCurrentVersion(db)}.`
    );
  }

  return db;
}
