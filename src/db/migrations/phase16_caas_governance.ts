/**
 * src/db/migrations/phase16_caas_governance.ts
 *
 * Phase 16 — CaaS Governance Core
 * Migrations v029–v032
 *
 * These migrations introduce the compliance-pipeline tables that power the
 * Verification Engine, Evidence Vault, Partner Portal, and Billing plane.
 * They extend the existing `accounts` and `users` tables with new columns,
 * then create nine new tables.
 *
 * Execution order (enforced by the canonical runner in migrate.ts):
 *   029 — Extend accounts with billing + run-limit + referral columns
 *   030 — Extend users with created_by + deactivation audit columns
 *   031 — Create compliance pipeline tables
 *   032 — Seed starter JSON Policy Map rules (EU AI Act + GDPR)
 *
 * All column additions use addColumnIfMissing — safe against environments
 * that received partial schema updates out of band.
 * All table creations use CREATE TABLE IF NOT EXISTS.
 * All index creations use CREATE INDEX IF NOT EXISTS.
 */

import type { Database as DB } from "better-sqlite3";

// ─── Types (re-declared locally to avoid circular imports) ───────────────────

interface Migration {
  version: number;
  description: string;
  up: (db: DB) => void;
}

// ─── Local Helpers ────────────────────────────────────────────────────────────

function addColumnIfMissing(
  db: DB,
  table: string,
  column: string,
  definition: string
): void {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  const existing = new Set(rows.map((r) => r.name));
  if (!existing.has(column)) {
    db.prepare(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`).run();
  }
}

function createIndexIfMissing(db: DB, indexName: string, ddl: string): void {
  const row = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(indexName);
  if (!row) db.prepare(ddl).run();
}

// ─── Migration Definitions ────────────────────────────────────────────────────

export const PHASE16_CAAS_GOVERNANCE_MIGRATIONS: Migration[] = [

  // ── 029 ── Extend accounts with billing, run-limit, referral columns ────────
  {
    version: 29,
    description: "Extend accounts table with billing, run-limit, and referral columns (Phase 16)",
    up(db) {
      // Billing integration (Paystack / Stripe customer + subscription IDs)
      addColumnIfMissing(db, "accounts", "billing_customer_id",     "TEXT");
      addColumnIfMissing(db, "accounts", "billing_subscription_id", "TEXT");

      // Monthly verification run quota
      addColumnIfMissing(db, "accounts", "run_count_this_month",    "INTEGER NOT NULL DEFAULT 0");
      addColumnIfMissing(db, "accounts", "run_limit_monthly",       "INTEGER NOT NULL DEFAULT 500");

      // Partner referral tracking (denormalised from partners.id for fast joins)
      addColumnIfMissing(db, "accounts", "referral_agent_id",       "TEXT");

      // Pilot lifecycle timestamps
      addColumnIfMissing(db, "accounts", "pilot_started_at",        "TEXT");
      addColumnIfMissing(db, "accounts", "trial_ends_at",           "TEXT");

      // Index for referral commission lookups
      createIndexIfMissing(
        db,
        "idx_accounts_referral_agent",
        `CREATE INDEX IF NOT EXISTS idx_accounts_referral_agent
         ON accounts (referral_agent_id) WHERE referral_agent_id IS NOT NULL`
      );
    },
  },

  // ── 030 ── Extend users with created_by + deactivation audit columns ────────
  {
    version: 30,
    description: "Extend users table with created_by and deactivation audit columns (Phase 16)",
    up(db) {
      // Who created this user (Executive user ID) — populated by the admin API
      addColumnIfMissing(db, "users", "created_by",      "TEXT");

      // Deactivation audit trail — set by PATCH /admin/users/:id {is_active: 0}
      addColumnIfMissing(db, "users", "deactivated_at",  "TEXT");
      addColumnIfMissing(db, "users", "deactivated_by",  "TEXT");
    },
  },

  // ── 031 ── Compliance pipeline tables ────────────────────────────────────────
  {
    version: 31,
    description: "Create compliance pipeline tables: scan_events, verification_results, vault_records, compliance_alerts, json_policy_maps, job_queue, partners, commissions, trust_badge_cache, audit_log (Phase 16)",
    up(db) {

      // ── scan_events ─────────────────────────────────────────────────────────
      // Incoming AI decision events from client systems via POST /api/v1/ingest/events
      db.prepare(`
        CREATE TABLE IF NOT EXISTS scan_events (
          id                TEXT    NOT NULL PRIMARY KEY DEFAULT ('evt_' || lower(hex(randomblob(12)))),
          tenant_id         TEXT    NOT NULL,
          model_id          TEXT    NOT NULL,
          decision_type     TEXT    NOT NULL,
          input_hash        TEXT,
          output_summary    TEXT,
          timestamp         TEXT    NOT NULL,
          metadata          TEXT,
          agent_id          TEXT,
          received_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          processing_status TEXT    NOT NULL DEFAULT 'pending'
            CHECK (processing_status IN ('pending','processing','complete','failed'))
        )
      `).run();

      createIndexIfMissing(
        db, "idx_scan_events_tenant_received",
        `CREATE INDEX IF NOT EXISTS idx_scan_events_tenant_received
         ON scan_events (tenant_id, received_at DESC)`
      );
      createIndexIfMissing(
        db, "idx_scan_events_pending",
        `CREATE INDEX IF NOT EXISTS idx_scan_events_pending
         ON scan_events (processing_status)
         WHERE processing_status = 'pending'`
      );

      // ── verification_results ────────────────────────────────────────────────
      // Output of the Verification Engine for each scan_event
      db.prepare(`
        CREATE TABLE IF NOT EXISTS verification_results (
          id            TEXT NOT NULL PRIMARY KEY DEFAULT ('vrf_' || lower(hex(randomblob(12)))),
          event_id      TEXT NOT NULL,
          tenant_id     TEXT NOT NULL,
          result        TEXT NOT NULL CHECK (result IN ('PASS','WARN','FAIL')),
          checks_run    TEXT NOT NULL DEFAULT '[]',
          checks_failed TEXT NOT NULL DEFAULT '[]',
          reason_codes  TEXT NOT NULL DEFAULT '[]',
          latency_ms    INTEGER,
          verified_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          FOREIGN KEY (event_id) REFERENCES scan_events(id)
        )
      `).run();

      createIndexIfMissing(
        db, "idx_vrf_tenant_verified",
        `CREATE INDEX IF NOT EXISTS idx_vrf_tenant_verified
         ON verification_results (tenant_id, verified_at DESC)`
      );
      createIndexIfMissing(
        db, "idx_vrf_event",
        `CREATE INDEX IF NOT EXISTS idx_vrf_event
         ON verification_results (event_id)`
      );
      createIndexIfMissing(
        db, "idx_vrf_result",
        `CREATE INDEX IF NOT EXISTS idx_vrf_result
         ON verification_results (tenant_id, result, verified_at DESC)`
      );

      // ── vault_records ───────────────────────────────────────────────────────
      // Immutable Evidence Vault — append-only hash chain. UPDATE and DELETE
      // are blocked by triggers. Never call UPDATE or DELETE on this table.
      db.prepare(`
        CREATE TABLE IF NOT EXISTS vault_records (
          id            TEXT    NOT NULL PRIMARY KEY DEFAULT ('vlt_' || lower(hex(randomblob(12)))),
          tenant_id     TEXT    NOT NULL,
          sequence_num  INTEGER NOT NULL,
          result_id     TEXT    NOT NULL,
          payload_hash  TEXT    NOT NULL,
          chain_hash    TEXT    NOT NULL,
          previous_id   TEXT,
          created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          UNIQUE (tenant_id, sequence_num),
          FOREIGN KEY (result_id) REFERENCES verification_results(id)
        )
      `).run();

      // Immutability triggers — any UPDATE or DELETE raises a hard error.
      db.prepare(`
        CREATE TRIGGER IF NOT EXISTS vault_no_update
        BEFORE UPDATE ON vault_records
        BEGIN
          SELECT RAISE(ABORT, 'vault_records is immutable: UPDATE is not permitted');
        END
      `).run();

      db.prepare(`
        CREATE TRIGGER IF NOT EXISTS vault_no_delete
        BEFORE DELETE ON vault_records
        BEGIN
          SELECT RAISE(ABORT, 'vault_records is immutable: DELETE is not permitted');
        END
      `).run();

      createIndexIfMissing(
        db, "idx_vault_tenant_seq",
        `CREATE INDEX IF NOT EXISTS idx_vault_tenant_seq
         ON vault_records (tenant_id, sequence_num)`
      );

      // ── compliance_alerts ───────────────────────────────────────────────────
      // WARN/FAIL events requiring Executive attention
      db.prepare(`
        CREATE TABLE IF NOT EXISTS compliance_alerts (
          id                TEXT NOT NULL PRIMARY KEY DEFAULT ('alt_' || lower(hex(randomblob(12)))),
          tenant_id         TEXT NOT NULL,
          result_id         TEXT NOT NULL,
          event_id          TEXT NOT NULL,
          severity          TEXT NOT NULL CHECK (severity IN ('WARN','FAIL')),
          reason_codes      TEXT NOT NULL DEFAULT '[]',
          acknowledged      INTEGER NOT NULL DEFAULT 0,
          acknowledged_by   TEXT,
          acknowledged_at   TEXT,
          created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          FOREIGN KEY (result_id) REFERENCES verification_results(id),
          FOREIGN KEY (event_id)  REFERENCES scan_events(id)
        )
      `).run();

      createIndexIfMissing(
        db, "idx_alerts_tenant_ack",
        `CREATE INDEX IF NOT EXISTS idx_alerts_tenant_ack
         ON compliance_alerts (tenant_id, acknowledged, created_at DESC)`
      );

      // ── json_policy_maps ────────────────────────────────────────────────────
      // The "Brain" — regulation rules used by the Verification Engine
      db.prepare(`
        CREATE TABLE IF NOT EXISTS json_policy_maps (
          id           TEXT NOT NULL PRIMARY KEY DEFAULT ('pol_' || lower(hex(randomblob(12)))),
          regulation   TEXT NOT NULL,
          jurisdiction TEXT NOT NULL,
          clause_ref   TEXT NOT NULL,
          check_name   TEXT NOT NULL UNIQUE,
          check_type   TEXT NOT NULL CHECK (check_type IN ('keyword','threshold','presence','type_match')),
          check_config TEXT NOT NULL,
          severity     TEXT NOT NULL CHECK (severity IN ('WARN','FAIL')),
          description  TEXT NOT NULL,
          active       INTEGER NOT NULL DEFAULT 1,
          created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
      `).run();

      createIndexIfMissing(
        db, "idx_policy_maps_active",
        `CREATE INDEX IF NOT EXISTS idx_policy_maps_active
         ON json_policy_maps (active, jurisdiction)`
      );

      // ── job_queue ───────────────────────────────────────────────────────────
      // In-process SQLite-backed worker queue (no Redis dependency for MVP)
      db.prepare(`
        CREATE TABLE IF NOT EXISTS job_queue (
          id           INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          job_type     TEXT    NOT NULL,
          payload      TEXT    NOT NULL,
          status       TEXT    NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','processing','done','failed')),
          attempts     INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          error_message TEXT,
          created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          run_after    TEXT
        )
      `).run();

      createIndexIfMissing(
        db, "idx_job_queue_pending",
        `CREATE INDEX IF NOT EXISTS idx_job_queue_pending
         ON job_queue (status, run_after)
         WHERE status = 'pending'`
      );

      // ── partners ────────────────────────────────────────────────────────────
      // Freelancer/agent accounts for the external sales network
      db.prepare(`
        CREATE TABLE IF NOT EXISTS partners (
          id                   TEXT NOT NULL PRIMARY KEY DEFAULT ('prt_' || lower(hex(randomblob(12)))),
          caas_ref_id          TEXT UNIQUE,
          full_name            TEXT NOT NULL,
          email                TEXT NOT NULL UNIQUE,
          country              TEXT NOT NULL,
          phone                TEXT,
          payout_method        TEXT NOT NULL CHECK (payout_method IN ('momo','bank','stripe')),
          payout_details       TEXT NOT NULL DEFAULT '{}',
          status               TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','approved','suspended')),
          approved_by          TEXT,
          approved_at          TEXT,
          portal_password_hash TEXT,
          commission_rate      REAL NOT NULL DEFAULT 0.15,
          created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
      `).run();

      createIndexIfMissing(
        db, "idx_partners_email",
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_partners_email ON partners (email)`
      );
      createIndexIfMissing(
        db, "idx_partners_ref_id",
        `CREATE INDEX IF NOT EXISTS idx_partners_ref_id
         ON partners (caas_ref_id) WHERE caas_ref_id IS NOT NULL`
      );

      // ── commissions ─────────────────────────────────────────────────────────
      // Partner commission ledger — one row per billing event
      db.prepare(`
        CREATE TABLE IF NOT EXISTS commissions (
          id                TEXT NOT NULL PRIMARY KEY DEFAULT ('com_' || lower(hex(randomblob(12)))),
          partner_id        TEXT NOT NULL,
          tenant_id         TEXT NOT NULL,
          invoice_amount    REAL NOT NULL,
          currency          TEXT NOT NULL DEFAULT 'USD',
          commission_amount REAL NOT NULL,
          status            TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending','settled','paid','failed')),
          payout_reference  TEXT,
          billing_event_id  TEXT NOT NULL,
          created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
          paid_at           TEXT,
          FOREIGN KEY (partner_id) REFERENCES partners(id)
        )
      `).run();

      createIndexIfMissing(
        db, "idx_commissions_partner_status",
        `CREATE INDEX IF NOT EXISTS idx_commissions_partner_status
         ON commissions (partner_id, status, created_at DESC)`
      );

      // ── trust_badge_cache ───────────────────────────────────────────────────
      // Materialised compliance score per tenant — invalidated on each verification
      db.prepare(`
        CREATE TABLE IF NOT EXISTS trust_badge_cache (
          tenant_id          TEXT NOT NULL PRIMARY KEY,
          compliance_score   REAL NOT NULL DEFAULT 0,
          total_runs         INTEGER NOT NULL DEFAULT 0,
          pass_count         INTEGER NOT NULL DEFAULT 0,
          warn_count         INTEGER NOT NULL DEFAULT 0,
          fail_count         INTEGER NOT NULL DEFAULT 0,
          last_verified_at   TEXT,
          last_updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
      `).run();

      // ── audit_log ───────────────────────────────────────────────────────────
      // All user-initiated actions (user creation, API key rotation, acknowledgements, etc.)
      db.prepare(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id         INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
          tenant_id  TEXT    NOT NULL,
          user_id    TEXT    NOT NULL,
          action     TEXT    NOT NULL,
          target_id  TEXT,
          details    TEXT,
          ip_address TEXT,
          user_agent TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
        )
      `).run();

      createIndexIfMissing(
        db, "idx_audit_log_tenant",
        `CREATE INDEX IF NOT EXISTS idx_audit_log_tenant
         ON audit_log (tenant_id, created_at DESC)`
      );
      createIndexIfMissing(
        db, "idx_audit_log_user",
        `CREATE INDEX IF NOT EXISTS idx_audit_log_user
         ON audit_log (user_id, created_at DESC)`
      );
    },
  },

  // ── 032 ── Seed starter JSON Policy Map rules ────────────────────────────────
  {
    version: 32,
    description: "Seed starter JSON Policy Map rules: EU AI Act high-risk, GDPR PII in output, EU AI Act fairness ratio (Phase 16)",
    up(db) {
      const insert = db.prepare(`
        INSERT OR IGNORE INTO json_policy_maps
          (regulation, jurisdiction, clause_ref, check_name, check_type, check_config, severity, description)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const seedPolicies = db.transaction(() => {
        // Rule 1 — EU AI Act: flag high-risk AI decision categories
        insert.run(
          "EU_AI_ACT",
          "EU",
          "Article 6 + Annex III",
          "high_risk_category_check",
          "type_match",
          JSON.stringify({
            field: "decision_type",
            values: [
              "credit_scoring", "hiring", "medical_diagnosis",
              "biometric_id", "law_enforcement", "education_scoring",
              "social_scoring", "critical_infrastructure",
            ],
          }),
          "WARN",
          "Decision type matches an EU AI Act Annex III high-risk AI system category. Mandatory conformity assessment may be required."
        );

        // Rule 2 — GDPR: detect PII leaking into output summaries
        insert.run(
          "GDPR",
          "EU",
          "Article 5(1)(a) — Lawfulness, fairness and transparency",
          "pii_in_output_check",
          "keyword",
          JSON.stringify({
            field: "output_summary",
            keywords: [
              "passport", "national id", "national ID", "ssn", "social security",
              "date of birth", "home address", "bank account", "credit card",
              "tax id", "nin", "bvn",
            ],
          }),
          "FAIL",
          "Output summary contains apparent PII. Surfacing personal data in model outputs may violate GDPR Article 5 data minimisation and purpose limitation principles."
        );

        // Rule 3 — EU AI Act: demographic parity fairness ratio
        insert.run(
          "EU_AI_ACT",
          "EU",
          "Article 10 — Data and data governance",
          "fairness_ratio_check",
          "threshold",
          JSON.stringify({
            field: "metadata.demographic_parity_ratio",
            operator: "gte",
            value: 0.8,
            missing_action: "WARN",
          }),
          "FAIL",
          "Demographic parity ratio is below the 0.8 threshold or was not reported in the event metadata. EU AI Act Article 10 requires high-risk AI systems to be trained on datasets that are representative and free of bias."
        );
      });

      seedPolicies();

      console.log("[migrate] v032 seeded 3 starter JSON Policy Map rules (EU AI Act + GDPR)");
    },
  },

];
