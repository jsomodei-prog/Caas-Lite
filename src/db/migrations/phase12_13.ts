/**
 * src/db/migrations/phase12_13.ts
 * Phase 12 & 13 — Commercial Pipeline & Actuarial Insurance Schema.
 *
 * Tables introduced (versions 23–30):
 *   v23 — tenant_commercial_subscriptions
 *   v24 — commercial_billing_ledgers
 *   v25 — insurance_underwriting_registry
 *   v26 — underwriting_audit_snapshots
 *   v27 — premium_reduction_tokens
 *   v28 — overage_charge_log
 *   v29 — invoice_line_items
 *   v30 — ANALYZE + covering indexes for commercial query paths
 *
 * Run:
 *   $env:DB_PATH="data\caas_evidence.db"
 *   npx ts-node --project tsconfig.json src/db/migrations/phase12_13.ts
 *
 * Phase 12-13 build-out | Commit baseline: cc20b1a
 */

import { openDatabase, runMigrations } from "../migrate";
import type { Database as DB } from "better-sqlite3";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function existingColumns(db: DB, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function addColumnIfMissing(db: DB, table: string, col: string, def: string): void {
  if (!existingColumns(db, table).has(col)) {
    db.prepare(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${def}`).run();
  }
}

function existingIndexes(db: DB): Set<string> {
  return new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[])
      .map((r) => r.name)
  );
}

function createIndexIfMissing(db: DB, name: string, ddl: string): void {
  if (!existingIndexes(db).has(name)) db.prepare(ddl).run();
}

// ─── Migration Definitions ────────────────────────────────────────────────────

const PHASE12_13_MIGRATIONS = [

  // ── v23: tenant_commercial_subscriptions ──────────────────────────────────
  {
    version: 23,
    description: "Create tenant_commercial_subscriptions table",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS tenant_commercial_subscriptions (
          id                    TEXT     PRIMARY KEY,
          tenant_id             TEXT     NOT NULL UNIQUE,

          -- Tier definition
          tier                  TEXT     NOT NULL DEFAULT 'PAY_AS_YOU_GO'
                                         CHECK (tier IN ('PAY_AS_YOU_GO','GROWTH','ENTERPRISE','CUSTOM')),

          -- Monthly committed fee (USD)
          monthly_fee_usd       REAL     NOT NULL DEFAULT 0.00,

          -- Included validation runs per billing period (0 = unlimited for ENTERPRISE)
          included_runs         INTEGER  NOT NULL DEFAULT 0,

          -- Number of active policy monitors included in the tier
          included_monitors     INTEGER  NOT NULL DEFAULT 0,

          -- Per-run overage rate in USD (charged above included_runs)
          overage_rate_usd      REAL     NOT NULL DEFAULT 0.00,

          -- Per-monitor overage rate in USD (charged above included_monitors)
          monitor_overage_usd   REAL     NOT NULL DEFAULT 0.00,

          -- Billing cycle: monthly | quarterly | annual
          billing_cycle         TEXT     NOT NULL DEFAULT 'monthly'
                                         CHECK (billing_cycle IN ('monthly','quarterly','annual')),

          -- ISO 4217 currency for invoicing (subscription is always in USD internally)
          invoice_currency      TEXT     NOT NULL DEFAULT 'USD',

          -- Subscription status
          status                TEXT     NOT NULL DEFAULT 'active'
                                         CHECK (status IN ('active','suspended','cancelled','trial')),

          -- Trial period end (NULL when not in trial)
          trial_ends_at         TEXT,

          -- Contract reference (PO number, Salesforce opportunity ID, etc.)
          contract_ref          TEXT,

          -- Current period start / end dates (ISO 8601)
          current_period_start  TEXT     NOT NULL,
          current_period_end    TEXT     NOT NULL,

          -- Cumulative run counter for the current billing period
          runs_this_period      INTEGER  NOT NULL DEFAULT 0,

          -- Cumulative active monitor count for the current billing period
          monitors_this_period  INTEGER  NOT NULL DEFAULT 0,

          -- HMAC-SHA256 of (id|tenant_id|tier|monthly_fee_usd|current_period_start)
          -- Verified before any billing operation to prevent tampering.
          integrity_hash        TEXT     NOT NULL,

          created_at            TEXT     NOT NULL,
          updated_at            TEXT     NOT NULL
        )
      `).run();

      createIndexIfMissing(db, "idx_tcs_tenant_id",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tcs_tenant_id ON tenant_commercial_subscriptions(tenant_id)");
      createIndexIfMissing(db, "idx_tcs_status",
        "CREATE INDEX IF NOT EXISTS idx_tcs_status ON tenant_commercial_subscriptions(status, current_period_end)");
      createIndexIfMissing(db, "idx_tcs_tier",
        "CREATE INDEX IF NOT EXISTS idx_tcs_tier ON tenant_commercial_subscriptions(tier)");
    },
  },

  // ── v24: commercial_billing_ledgers ───────────────────────────────────────
  {
    version: 24,
    description: "Create commercial_billing_ledgers table",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS commercial_billing_ledgers (
          id                      TEXT    PRIMARY KEY,
          tenant_id               TEXT    NOT NULL REFERENCES tenant_commercial_subscriptions(tenant_id),

          -- Invoice identifier (human-readable: INV-2026-001)
          invoice_number          TEXT    NOT NULL UNIQUE,

          -- Billing period
          period_start            TEXT    NOT NULL,
          period_end              TEXT    NOT NULL,

          -- Tier snapshot at invoice generation time (preserved for audit)
          tier_snapshot           TEXT    NOT NULL,
          monthly_fee_snapshot    REAL    NOT NULL DEFAULT 0.00,
          included_runs_snapshot  INTEGER NOT NULL DEFAULT 0,
          overage_rate_snapshot   REAL    NOT NULL DEFAULT 0.00,

          -- Actual usage in the period
          actual_runs             INTEGER NOT NULL DEFAULT 0,
          actual_monitors         INTEGER NOT NULL DEFAULT 0,

          -- Charge components (all in USD)
          base_fee_usd            REAL    NOT NULL DEFAULT 0.00,
          overage_runs_usd        REAL    NOT NULL DEFAULT 0.00,
          overage_monitors_usd    REAL    NOT NULL DEFAULT 0.00,
          insurance_premium_usd   REAL    NOT NULL DEFAULT 0.00,
          premium_discount_usd    REAL    NOT NULL DEFAULT 0.00,
          tax_usd                 REAL    NOT NULL DEFAULT 0.00,
          total_usd               REAL    NOT NULL DEFAULT 0.00,

          -- FX conversion for local invoicing
          invoice_currency        TEXT    NOT NULL DEFAULT 'USD',
          fx_rate                 REAL    NOT NULL DEFAULT 1.0,
          total_local             REAL    NOT NULL DEFAULT 0.00,

          -- Settlement lifecycle
          status                  TEXT    NOT NULL DEFAULT 'draft'
                                           CHECK (status IN ('draft','issued','paid','overdue','voided','disputed')),
          issued_at               TEXT,
          due_at                  TEXT,
          paid_at                 TEXT,
          payment_reference       TEXT,
          payment_method          TEXT,

          -- Applied premium reduction token ID (FK → premium_reduction_tokens)
          applied_token_id        TEXT,

          -- SHA-256 hash of the full invoice payload for tamper detection
          invoice_hash            TEXT    NOT NULL,

          -- HMAC-SHA256 signature over (invoice_number|total_usd|period_start|period_end|status)
          signature               TEXT    NOT NULL,

          notes                   TEXT,
          created_at              TEXT    NOT NULL,
          updated_at              TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(db, "idx_cbl_tenant_period",
        "CREATE INDEX IF NOT EXISTS idx_cbl_tenant_period ON commercial_billing_ledgers(tenant_id, period_start DESC)");
      createIndexIfMissing(db, "idx_cbl_status",
        "CREATE INDEX IF NOT EXISTS idx_cbl_status ON commercial_billing_ledgers(status, due_at)");
      createIndexIfMissing(db, "idx_cbl_invoice_number",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_cbl_invoice_number ON commercial_billing_ledgers(invoice_number)");
    },
  },

  // ── v25: insurance_underwriting_registry ──────────────────────────────────
  {
    version: 25,
    description: "Create insurance_underwriting_registry table",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS insurance_underwriting_registry (
          id                        TEXT    PRIMARY KEY,
          tenant_id                 TEXT    NOT NULL,

          -- Insurance carrier details
          carrier_name              TEXT    NOT NULL,
          carrier_id                TEXT    NOT NULL,
          policy_number             TEXT    NOT NULL UNIQUE,
          coverage_type             TEXT    NOT NULL
                                             CHECK (coverage_type IN (
                                               'cyber_liability','professional_indemnity',
                                               'fintech_comprehensive','data_breach',
                                               'operational_risk','regulatory_defence'
                                             )),

          -- Coverage parameters (USD)
          coverage_limit_usd        REAL    NOT NULL DEFAULT 0.00,
          deductible_usd            REAL    NOT NULL DEFAULT 0.00,
          base_annual_premium_usd   REAL    NOT NULL DEFAULT 0.00,

          -- Dynamic risk score: 0.00 (pristine) → 100.00 (critical risk)
          -- Recomputed on each underwriting audit cycle.
          risk_score                REAL    NOT NULL DEFAULT 50.00
                                             CHECK (risk_score >= 0.00 AND risk_score <= 100.00),

          -- Risk band derived from risk_score:
          --   0–25   → GREEN  (eligible for 20% premium reduction)
          --   26–50  → AMBER  (eligible for 15% premium reduction)
          --   51–75  → ORANGE (eligible for 10% premium reduction)
          --   76–100 → RED    (no reduction; possible loading)
          risk_band                 TEXT    NOT NULL DEFAULT 'AMBER'
                                             CHECK (risk_band IN ('GREEN','AMBER','ORANGE','RED')),

          -- Verified discount level emitted as a premium reduction token
          -- NULL when risk_band = RED
          verified_discount_pct     REAL    CHECK (verified_discount_pct IN (NULL, 10.0, 15.0, 20.0)),

          -- Effective premium after discount
          effective_annual_premium_usd REAL NOT NULL DEFAULT 0.00,

          -- Golden thread hash: HMAC-SHA256 chain over the last N audit snapshots.
          -- Provides a tamper-evident proof of continuous underwriting history.
          golden_thread_hash        TEXT    NOT NULL,

          -- Policy validity window
          policy_start_date         TEXT    NOT NULL,
          policy_end_date           TEXT    NOT NULL,

          -- Last underwriting audit timestamp
          last_audit_at             TEXT    NOT NULL,

          -- Next scheduled audit (default: 30 days from last_audit_at)
          next_audit_at             TEXT    NOT NULL,

          -- Number of consecutive clean audit cycles (resets on any RED incident)
          consecutive_clean_audits  INTEGER NOT NULL DEFAULT 0,

          -- Underwriting status
          status                    TEXT    NOT NULL DEFAULT 'active'
                                             CHECK (status IN ('active','under_review','suspended','expired','cancelled')),

          -- Regulatory jurisdiction (ISO 3166-1 alpha-2)
          jurisdiction              TEXT    NOT NULL DEFAULT 'GH',

          created_at                TEXT    NOT NULL,
          updated_at                TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(db, "idx_iur_tenant_id",
        "CREATE INDEX IF NOT EXISTS idx_iur_tenant_id ON insurance_underwriting_registry(tenant_id)");
      createIndexIfMissing(db, "idx_iur_policy_number",
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_iur_policy_number ON insurance_underwriting_registry(policy_number)");
      createIndexIfMissing(db, "idx_iur_risk_band",
        "CREATE INDEX IF NOT EXISTS idx_iur_risk_band ON insurance_underwriting_registry(risk_band, last_audit_at DESC)");
      createIndexIfMissing(db, "idx_iur_next_audit",
        "CREATE INDEX IF NOT EXISTS idx_iur_next_audit ON insurance_underwriting_registry(next_audit_at)");
    },
  },

  // ── v26: underwriting_audit_snapshots ─────────────────────────────────────
  {
    version: 26,
    description: "Create underwriting_audit_snapshots table",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS underwriting_audit_snapshots (
          id                      TEXT    PRIMARY KEY,
          registry_id             TEXT    NOT NULL
                                           REFERENCES insurance_underwriting_registry(id) ON DELETE CASCADE,
          tenant_id               TEXT    NOT NULL,

          -- Snapshot of all scoring inputs at audit time
          audit_period_start      TEXT    NOT NULL,
          audit_period_end        TEXT    NOT NULL,

          -- Input metrics captured from system logs
          total_validation_runs   INTEGER NOT NULL DEFAULT 0,
          failed_validation_runs  INTEGER NOT NULL DEFAULT 0,
          anomaly_count_high      INTEGER NOT NULL DEFAULT 0,
          anomaly_count_critical  INTEGER NOT NULL DEFAULT 0,
          payout_failure_rate     REAL    NOT NULL DEFAULT 0.00,
          avg_query_duration_ms   REAL    NOT NULL DEFAULT 0.00,
          slow_query_count        INTEGER NOT NULL DEFAULT 0,
          auth_lockout_count      INTEGER NOT NULL DEFAULT 0,
          duplicate_payout_count  INTEGER NOT NULL DEFAULT 0,
          regulatory_breach_count INTEGER NOT NULL DEFAULT 0,
          db_integrity_ok         INTEGER NOT NULL DEFAULT 1,
          failover_events         INTEGER NOT NULL DEFAULT 0,

          -- Computed score components (weighted sub-scores, each 0–100)
          score_operational       REAL    NOT NULL DEFAULT 50.00,
          score_security          REAL    NOT NULL DEFAULT 50.00,
          score_compliance        REAL    NOT NULL DEFAULT 50.00,
          score_financial         REAL    NOT NULL DEFAULT 50.00,

          -- Composite risk score (weighted average of components)
          composite_risk_score    REAL    NOT NULL DEFAULT 50.00,

          -- Resulting risk band and discount
          resulting_risk_band     TEXT    NOT NULL DEFAULT 'AMBER',
          discount_pct_emitted    REAL,

          -- Token ID emitted for this cycle (FK → premium_reduction_tokens)
          token_id                TEXT,

          -- Hash of this snapshot's payload (SHA-256)
          snapshot_hash           TEXT    NOT NULL,

          -- Chained hash: HMAC(previous_golden_thread_hash || snapshot_hash)
          chained_hash            TEXT    NOT NULL,

          audited_at              TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(db, "idx_uas_registry_id",
        "CREATE INDEX IF NOT EXISTS idx_uas_registry_id ON underwriting_audit_snapshots(registry_id, audited_at DESC)");
      createIndexIfMissing(db, "idx_uas_tenant_audited",
        "CREATE INDEX IF NOT EXISTS idx_uas_tenant_audited ON underwriting_audit_snapshots(tenant_id, audited_at DESC)");
    },
  },

  // ── v27: premium_reduction_tokens ─────────────────────────────────────────
  {
    version: 27,
    description: "Create premium_reduction_tokens table",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS premium_reduction_tokens (
          id                  TEXT    PRIMARY KEY,
          tenant_id           TEXT    NOT NULL,
          registry_id         TEXT    NOT NULL REFERENCES insurance_underwriting_registry(id),
          snapshot_id         TEXT    NOT NULL REFERENCES underwriting_audit_snapshots(id),

          -- The validated discount level: 10.0 | 15.0 | 20.0
          discount_pct        REAL    NOT NULL CHECK (discount_pct IN (10.0, 15.0, 20.0)),

          -- USD value of the discount for the current billing period
          discount_value_usd  REAL    NOT NULL DEFAULT 0.00,

          -- Token lifecycle
          status              TEXT    NOT NULL DEFAULT 'issued'
                                       CHECK (status IN ('issued','applied','expired','revoked')),

          -- ISO 8601 expiry (tokens expire at the end of the next billing period)
          expires_at          TEXT    NOT NULL,

          -- Invoice ID where this token was applied (NULL until applied)
          applied_to_invoice  TEXT    REFERENCES commercial_billing_ledgers(id),
          applied_at          TEXT,

          -- HMAC-SHA256 of (id|tenant_id|discount_pct|snapshot_id|expires_at)
          token_signature     TEXT    NOT NULL,

          issued_at           TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(db, "idx_prt_tenant_status",
        "CREATE INDEX IF NOT EXISTS idx_prt_tenant_status ON premium_reduction_tokens(tenant_id, status, expires_at)");
      createIndexIfMissing(db, "idx_prt_registry",
        "CREATE INDEX IF NOT EXISTS idx_prt_registry ON premium_reduction_tokens(registry_id)");
    },
  },

  // ── v28: overage_charge_log ───────────────────────────────────────────────
  {
    version: 28,
    description: "Create overage_charge_log table",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS overage_charge_log (
          id                  TEXT    PRIMARY KEY,
          tenant_id           TEXT    NOT NULL,
          ledger_id           TEXT    REFERENCES commercial_billing_ledgers(id),

          -- What triggered the overage
          overage_type        TEXT    NOT NULL
                                       CHECK (overage_type IN ('validation_run','monitor','api_burst','storage')),

          -- The run or monitor count that crossed the threshold
          included_limit      INTEGER NOT NULL DEFAULT 0,
          actual_count        INTEGER NOT NULL DEFAULT 0,
          overage_units       INTEGER NOT NULL DEFAULT 0,

          -- Unit rate applied
          unit_rate_usd       REAL    NOT NULL DEFAULT 0.00,

          -- Total charge for this overage event
          charge_usd          REAL    NOT NULL DEFAULT 0.00,

          -- Reference to the triggering event (payout_log_id, job_id, etc.)
          event_ref           TEXT,

          recorded_at         TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(db, "idx_ocl_tenant_period",
        "CREATE INDEX IF NOT EXISTS idx_ocl_tenant_period ON overage_charge_log(tenant_id, recorded_at DESC)");
      createIndexIfMissing(db, "idx_ocl_ledger",
        "CREATE INDEX IF NOT EXISTS idx_ocl_ledger ON overage_charge_log(ledger_id)");
    },
  },

  // ── v29: invoice_line_items ────────────────────────────────────────────────
  {
    version: 29,
    description: "Create invoice_line_items table",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS invoice_line_items (
          id              TEXT    PRIMARY KEY,
          ledger_id       TEXT    NOT NULL REFERENCES commercial_billing_ledgers(id) ON DELETE CASCADE,
          tenant_id       TEXT    NOT NULL,

          -- Line item classification
          item_type       TEXT    NOT NULL
                                   CHECK (item_type IN (
                                     'base_fee','overage_runs','overage_monitors',
                                     'insurance_premium','premium_discount',
                                     'tax','adjustment','credit'
                                   )),

          description     TEXT    NOT NULL,
          quantity        REAL    NOT NULL DEFAULT 1.0,
          unit_price_usd  REAL    NOT NULL DEFAULT 0.00,
          line_total_usd  REAL    NOT NULL DEFAULT 0.00,

          -- Negative for credits / discounts
          is_credit       INTEGER NOT NULL DEFAULT 0,

          sort_order      INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(db, "idx_ili_ledger_id",
        "CREATE INDEX IF NOT EXISTS idx_ili_ledger_id ON invoice_line_items(ledger_id, sort_order)");
    },
  },

  // ── v30: ANALYZE + covering indexes ────────────────────────────────────────
  {
    version: 30,
    description: "Add covering indexes for commercial query paths and ANALYZE",
    up(db: DB): void {
      // Covering index for invoice summary queries (most common dashboard query)
      createIndexIfMissing(db, "idx_cbl_summary_covering",
        `CREATE INDEX IF NOT EXISTS idx_cbl_summary_covering
         ON commercial_billing_ledgers(tenant_id, status, period_start, total_usd, invoice_number)`);

      // Covering index for overdue invoice alerts
      createIndexIfMissing(db, "idx_cbl_overdue",
        `CREATE INDEX IF NOT EXISTS idx_cbl_overdue
         ON commercial_billing_ledgers(status, due_at)
         WHERE status IN ('issued','overdue')`);

      // Covering index for token availability check
      createIndexIfMissing(db, "idx_prt_available",
        `CREATE INDEX IF NOT EXISTS idx_prt_available
         ON premium_reduction_tokens(tenant_id, status, expires_at, discount_pct)
         WHERE status = 'issued'`);

      // agents table: add commercial_subscription_id backlink
      addColumnIfMissing(db, "agents", "subscription_id",
        "TEXT REFERENCES tenant_commercial_subscriptions(id)");

      // users table: add billing_contact flag
      addColumnIfMissing(db, "users", "is_billing_contact",
        "INTEGER NOT NULL DEFAULT 0");

      db.prepare("ANALYZE").run();
    },
  },

];

// ─── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = openDatabase();

  // Ensure all prior migrations (1–22) are applied first.
  runMigrations(db);

  const appliedVersions = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[])
      .map((r) => r.version)
  );

  for (const migration of PHASE12_13_MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      console.log(`[migrate-p12-13] ↷ ${String(migration.version).padStart(3, "0")} ${migration.description} (skipped)`);
      continue;
    }
    const start = Date.now();
    db.transaction(() => {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)"
      ).run(migration.version, migration.description, new Date().toISOString());
    })();
    console.log(
      `[migrate-p12-13] ✓ ${String(migration.version).padStart(3, "0")} ${migration.description} (${Date.now() - start}ms)`
    );
  }

  const version = (
    db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number }
  ).v;
  console.log(`\nSchema now at version ${version}.`);

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[];
  console.log(`\nAll tables (${tables.length}):`);
  tables.forEach((t) => console.log(`  ${t.name}`));

  db.close();
}

main().catch((err) => {
  console.error("[migrate-p12-13] Fatal:", err);
  process.exit(1);
});
