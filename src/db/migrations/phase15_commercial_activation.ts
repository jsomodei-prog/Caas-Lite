/**
 * src/db/migrations/phase15_commercial_activation.ts
 *
 * Phase 15 — Commercial Activation. Skeleton tables for the 30-day
 * "Shadow Governance" pilot:
 *
 *   v22  accounts                  — one row per tenant, tier + API key
 *   v23  trust_badge_registry      — current trust badge state per tenant
 *        trust_badge_history       — transition log for audit
 *   v24  ai_insurance_warranties   — policy state machine + external hooks
 *   v25  commercial_audit_log      — write trail for all Phase 15 mutations
 *   v26  pilot_decisions           — Listen Mode ingest target for SDK
 *   v27  secret_state              — boot-time rotation detection storage
 *
 * These migrations are exported and folded into the canonical MIGRATIONS
 * array in src/db/migrate.ts. They are NOT run by a separate script.
 */

import type { Database as DB } from "better-sqlite3";

/**
 * Phase 15 migration entries. Spread into MIGRATIONS in migrate.ts:
 *
 *   const MIGRATIONS: Migration[] = [
 *     ...EXISTING_v1_through_v21,
 *     ...PHASE15_MIGRATIONS,
 *   ];
 *
 * Each entry has the same shape as a Migration in migrate.ts; helpers
 * (createIndexIfMissing) are referenced by name and resolved at the
 * MIGRATIONS callsite, so they must be in scope where this is spread.
 *
 * NOTE: To keep this file standalone-readable, helpers are inlined as
 * arrow-function calls against db.prepare. This is intentionally
 * duplicative of migrate.ts helpers — the alternative (importing them)
 * would create a circular dependency since migrate.ts spreads this array.
 */
export const PHASE15_MIGRATIONS = [

  // ── 022 ── accounts ────────────────────────────────────────────────────────
  {
    version: 22,
    description: "Phase 15 — accounts table (tenant tier + API key registry)",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS accounts (
          id                  TEXT     PRIMARY KEY,
          tenant_id           TEXT     NOT NULL UNIQUE,
          tier                TEXT     NOT NULL DEFAULT 'LITE'
                                       CHECK (tier IN ('LITE', 'GROWTH', 'ENTERPRISE')),
          status              TEXT     NOT NULL DEFAULT 'pilot'
                                       CHECK (status IN ('pilot', 'active', 'suspended', 'churned')),

          -- API key for SDK auth. Raw key returned once at provisioning;
          -- only hash + prefix persisted. Mirrors user_profiles.api_key_hash
          -- pattern from src/routes/users.ts.
          api_key_hash        TEXT     NOT NULL,
          api_key_prefix      TEXT     NOT NULL,
          api_key_rotated_at  TEXT,

          -- Pilot lifecycle
          pilot_started_at    TEXT,
          pilot_ends_at       TEXT,

          -- Display + contact
          display_name        TEXT     NOT NULL,
          contact_email       TEXT,

          created_at          TEXT     NOT NULL,
          updated_at          TEXT     NOT NULL
        )
      `).run();

      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_accounts_tier_status
         ON accounts(tier, status)`
      ).run();
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_accounts_api_key_prefix
         ON accounts(api_key_prefix)`
      ).run();
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_accounts_pilot_ends_at
         ON accounts(pilot_ends_at)
         WHERE status = 'pilot'`
      ).run();
    },
  },

  // ── 023 ── trust badge registry + history ──────────────────────────────────
  {
    version: 23,
    description: "Phase 15 — trust_badge_registry (current state) + trust_badge_history",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS trust_badge_registry (
          tenant_id           TEXT     PRIMARY KEY,
          account_id          TEXT     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          badge_state         TEXT     NOT NULL DEFAULT 'green'
                                       CHECK (badge_state IN ('green', 'amber', 'red')),

          -- HMAC over (tenant_id, badge_state, state_changed_at). Recomputed
          -- on every state transition. NOT a substitute for real certificate
          -- attestation; sufficient for pilot.
          state_signature     TEXT     NOT NULL,

          -- Optional human-readable reason for current state (e.g. "anomaly
          -- ratio 4.2% exceeds 2.0% threshold"). Free text, no enum.
          state_reason        TEXT,

          state_changed_at    TEXT     NOT NULL,
          created_at          TEXT     NOT NULL,
          updated_at          TEXT     NOT NULL
        )
      `).run();

      db.prepare(`
        CREATE TABLE IF NOT EXISTS trust_badge_history (
          id                  TEXT     PRIMARY KEY,
          tenant_id           TEXT     NOT NULL,
          account_id          TEXT     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          from_state          TEXT,    -- NULL on initial badge creation
          to_state            TEXT     NOT NULL,
          reason              TEXT,
          changed_at          TEXT     NOT NULL
        )
      `).run();

      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_badge_history_tenant
         ON trust_badge_history(tenant_id, changed_at DESC)`
      ).run();
    },
  },

  // ── 024 ── insurance warranties ────────────────────────────────────────────
  {
    version: 24,
    description: "Phase 15 — ai_insurance_warranties (policy state machine)",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS ai_insurance_warranties (
          id                       TEXT     PRIMARY KEY,
          tenant_id                TEXT     NOT NULL,
          account_id               TEXT     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

          policy_state             TEXT     NOT NULL DEFAULT 'ACTIVE'
                                            CHECK (policy_state IN (
                                              'ACTIVE',
                                              'VOID_BY_COMPLIANCE_DRIFT',
                                              'VOID_BY_ANOMALY_RATIO'
                                            )),

          -- Optional external policy reference (set when an external
          -- marine/cargo insurer has bound coverage against this warranty).
          external_carrier_id      TEXT,
          external_policy_number   TEXT,

          -- Snapshot of the trigger that produced the current state. JSON.
          -- e.g. {"anomaly_ratio": 0.042, "threshold": 0.020, "window_days": 7}
          state_evidence_json      TEXT     NOT NULL DEFAULT '{}',

          coverage_started_at      TEXT     NOT NULL,
          coverage_ends_at         TEXT,
          state_changed_at         TEXT     NOT NULL,

          created_at               TEXT     NOT NULL,
          updated_at               TEXT     NOT NULL
        )
      `).run();

      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_warranty_tenant_state
         ON ai_insurance_warranties(tenant_id, policy_state)`
      ).run();
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_warranty_state_changed
         ON ai_insurance_warranties(policy_state, state_changed_at DESC)`
      ).run();
    },
  },

  // ── 025 ── commercial audit log ────────────────────────────────────────────
  {
    version: 25,
    description: "Phase 15 — commercial_audit_log (write trail for Phase 15 mutations)",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS commercial_audit_log (
          id              TEXT     PRIMARY KEY,
          tenant_id       TEXT     NOT NULL,
          actor_user_id   TEXT,    -- NULL for system-triggered events (e.g. recompute jobs)
          entity_type     TEXT     NOT NULL,  -- 'account' | 'badge' | 'warranty' | 'pilot_decision'
          entity_id       TEXT     NOT NULL,
          action          TEXT     NOT NULL,  -- 'create' | 'tier_change' | 'state_change' | etc.
          old_value       TEXT,
          new_value       TEXT,
          metadata        TEXT     NOT NULL DEFAULT '{}',
          created_at      TEXT     NOT NULL
        )
      `).run();

      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_commercial_audit_tenant
         ON commercial_audit_log(tenant_id, created_at DESC)`
      ).run();
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_commercial_audit_entity
         ON commercial_audit_log(entity_type, entity_id, created_at DESC)`
      ).run();
    },
  },

  // ── 026 ── pilot decisions (Listen Mode ingest) ────────────────────────────
  {
    version: 26,
    description: "Phase 15 — pilot_decisions (Listen Mode SDK ingest target)",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS pilot_decisions (
          id                  TEXT     PRIMARY KEY,
          tenant_id           TEXT     NOT NULL,
          account_id          TEXT     NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

          -- Client-supplied identifier so they can correlate to their own logs.
          -- Not unique on our side; clients may reuse or omit it.
          client_decision_id  TEXT,

          -- Optional classification: "fraud_score", "content_moderation", etc.
          decision_class      TEXT,

          -- Optional numeric risk/confidence score. NULL when not applicable.
          risk_score          REAL,

          -- Free-form decision context. Hard cap enforced at the route level
          -- (8KB) rather than via CHECK constraint to keep SQLite happy.
          decision_payload    TEXT     NOT NULL DEFAULT '{}',

          -- SHA-256 of (tenant_id + decision_payload). Used to dedupe
          -- accidental retries from the SDK without burning a UNIQUE index.
          payload_hash        TEXT     NOT NULL,

          -- Network context for audit / abuse detection
          ip_address          TEXT,
          user_agent          TEXT,

          received_at         TEXT     NOT NULL,
          processed_at        TEXT     -- NULL until async scoring runs
        )
      `).run();

      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_pilot_decisions_tenant_time
         ON pilot_decisions(tenant_id, received_at DESC)`
      ).run();
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_pilot_decisions_class
         ON pilot_decisions(decision_class, received_at DESC)
         WHERE decision_class IS NOT NULL`
      ).run();
      db.prepare(
        `CREATE INDEX IF NOT EXISTS idx_pilot_decisions_unprocessed
         ON pilot_decisions(received_at)
         WHERE processed_at IS NULL`
      ).run();
    },
  },

  // ── 027 ── secret state (boot-time rotation detection) ─────────────────────
  {
    version: 27,
    description: "Phase 15 — secret_state (records secret fingerprints for rotation detection)",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS secret_state (
          secret_name      TEXT PRIMARY KEY,
          -- sha256 hex of the secret value. Used to detect rotation without
          -- storing the secret itself.
          fingerprint      TEXT NOT NULL,
          -- Last time the fingerprint was observed/updated.
          last_seen_at     TEXT NOT NULL,
          -- Last time we detected a change in the fingerprint.
          last_rotated_at  TEXT NOT NULL,
          -- Optional metadata about the most recent rotation event.
          metadata         TEXT NOT NULL DEFAULT '{}'
        )
      `).run();
    },
  },
];
