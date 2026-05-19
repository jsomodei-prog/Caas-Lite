/**
 * src/routes/insurance.ts
 * Phase 15 — Automated Financial Indemnity & Warranty Mapping.
 *
 * Endpoints (JWT-authenticated):
 *   GET    /api/v1/insurance/policies                  list policies (tenant-scoped)
 *   GET    /api/v1/insurance/policies/:id              read one
 *   POST   /api/v1/insurance/policies                  bind a new warranty to an account
 *   POST   /api/v1/insurance/policies/:id/recompute    re-evaluate state from evidence
 *   PATCH  /api/v1/insurance/policies/:id/external     attach external carrier reference
 *
 * State machine:
 *   ACTIVE  ──[anomaly_ratio > threshold]──▶  VOID_BY_ANOMALY_RATIO
 *   ACTIVE  ──[compliance drift detected]──▶  VOID_BY_COMPLIANCE_DRIFT
 *
 *   Voided states are terminal in this skeleton. Reinstatement would be
 *   a separate endpoint with its own audit trail — TODO(phase15).
 *
 * Evidence sources:
 *   - role_access_metrics (Phase 12) for boundary crossings / denials
 *   - pilot_decisions (Phase 15 v26) for decision volume baseline
 *
 * TODO(phase15): the trigger thresholds at the top of this file are
 * placeholder values. Real product calibration involves baselining against
 * historical pilot data and is out of scope for the skeleton.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { requireAccessToken } from "./auth";
import { syncBadge } from "../lib/badge-sync";

// ─── Trigger Thresholds (TODO: calibrate against real pilot data) ─────────────

const ANOMALY_RATIO_THRESHOLD  = 0.02;   // 2% denial rate voids coverage
const ANOMALY_WINDOW_DAYS      = 7;
const DRIFT_BOUNDARY_THRESHOLD = 10;     // boundary crossings in window
const DRIFT_WINDOW_DAYS        = 30;

// ─── Types ────────────────────────────────────────────────────────────────────

export type PolicyState =
  | "ACTIVE"
  | "VOID_BY_COMPLIANCE_DRIFT"
  | "VOID_BY_ANOMALY_RATIO";

export interface WarrantyRow {
  id:                       string;
  tenant_id:                string;
  account_id:               string;
  policy_state:             PolicyState;
  external_carrier_id:      string | null;
  external_policy_number:   string | null;
  state_evidence_json:      string;
  coverage_started_at:      string;
  coverage_ends_at:         string | null;
  state_changed_at:         string;
  created_at:               string;
  updated_at:               string;
}

interface RecomputeResult {
  previous_state:  PolicyState;
  current_state:   PolicyState;
  changed:         boolean;
  evidence:        Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDb(req: Request): DB {
  return (req.app.locals as { db: DB }).db;
}

function getActorId(req: Request): string {
  return (req as Request & { userId?: string }).userId ?? "system";
}

function getTenantId(req: Request): string {
  return (req as Request & { tenantId?: string }).tenantId ?? "";
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function commercialAuditLog(
  db: DB,
  tenantId: string,
  actorUserId: string | null,
  entityId: string,
  action: string,
  oldValue: string | null,
  newValue: string | null,
  metadata: Record<string, unknown> = {}
): void {
  db.prepare(`
    INSERT INTO commercial_audit_log
      (id, tenant_id, actor_user_id, entity_type, entity_id,
       action, old_value, new_value, metadata, created_at)
    VALUES (?, ?, ?, 'warranty', ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(), tenantId, actorUserId, entityId, action,
    oldValue, newValue, JSON.stringify(metadata),
    new Date().toISOString()
  );
}

// ─── Core: Policy State Recomputation ─────────────────────────────────────────

/**
 * Evaluates current evidence and returns the policy state that SHOULD
 * be active, plus the evidence snapshot. Pure function (no writes).
 * Callers handle persistence and audit logging.
 *
 * Order of checks matters: ANOMALY_RATIO is checked first because it's
 * the more specific/severe trigger. A policy voided for drift can later
 * also exceed the anomaly threshold, but the first-recorded void reason
 * wins until reinstatement.
 */
function evaluatePolicyState(db: DB, tenantId: string): {
  state: PolicyState;
  evidence: Record<string, unknown>;
} {
  // ── Anomaly ratio check ──
  const anomalyWindow = isoDaysAgo(ANOMALY_WINDOW_DAYS);
  const anomalyStats = db.prepare(`
    SELECT
      COUNT(*)                                       AS total,
      SUM(CASE WHEN access_granted = 0 THEN 1 ELSE 0 END) AS denied
    FROM role_access_metrics
    WHERE user_tenant_id = ? AND evaluated_at > ?
  `).get(tenantId, anomalyWindow) as { total: number; denied: number };

  const ratio = anomalyStats.total > 0
    ? anomalyStats.denied / anomalyStats.total
    : 0;

  if (anomalyStats.total > 0 && ratio > ANOMALY_RATIO_THRESHOLD) {
    return {
      state: "VOID_BY_ANOMALY_RATIO",
      evidence: {
        trigger:        "anomaly_ratio",
        anomaly_ratio:  ratio,
        threshold:      ANOMALY_RATIO_THRESHOLD,
        window_days:    ANOMALY_WINDOW_DAYS,
        total_requests: anomalyStats.total,
        denied_requests: anomalyStats.denied,
      },
    };
  }

  // ── Compliance drift check (boundary crossings over wider window) ──
  const driftWindow = isoDaysAgo(DRIFT_WINDOW_DAYS);
  const driftStats = db.prepare(`
    SELECT COUNT(*) AS crossings
    FROM role_access_metrics
    WHERE user_tenant_id = ?
      AND is_boundary_crossing = 1
      AND evaluated_at > ?
  `).get(tenantId, driftWindow) as { crossings: number };

  if (driftStats.crossings >= DRIFT_BOUNDARY_THRESHOLD) {
    return {
      state: "VOID_BY_COMPLIANCE_DRIFT",
      evidence: {
        trigger:             "compliance_drift",
        boundary_crossings:  driftStats.crossings,
        threshold:           DRIFT_BOUNDARY_THRESHOLD,
        window_days:         DRIFT_WINDOW_DAYS,
      },
    };
  }

  return {
    state: "ACTIVE",
    evidence: {
      anomaly_ratio:      ratio,
      // Include the threshold so downstream code (notably badge-sync's
      // amber boundary check) can compare ratio against it without
      // having to import the threshold constant itself.
      threshold:          ANOMALY_RATIO_THRESHOLD,
      boundary_crossings: driftStats.crossings,
      checked_at:         new Date().toISOString(),
    },
  };
}

/**
 * Persists a state transition. No-op if the computed state matches
 * the current state. Returns whether anything changed.
 */
function applyStateTransition(
  db: DB,
  warranty: WarrantyRow,
  newState: PolicyState,
  evidence: Record<string, unknown>,
  actorUserId: string | null
): RecomputeResult {
  if (warranty.policy_state === newState) {
    return {
      previous_state: warranty.policy_state,
      current_state:  newState,
      changed:        false,
      evidence,
    };
  }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE ai_insurance_warranties
       SET policy_state         = ?,
           state_evidence_json  = ?,
           state_changed_at     = ?,
           updated_at           = ?
     WHERE id = ?
  `).run(newState, JSON.stringify(evidence), now, now, warranty.id);

  commercialAuditLog(
    db, warranty.tenant_id, actorUserId, warranty.id, "state_change",
    warranty.policy_state, newState,
    { evidence }
  );

  return {
    previous_state: warranty.policy_state,
    current_state:  newState,
    changed:        true,
    evidence,
  };
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function listPolicies(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);

  // TODO(phase15): business-plane operators should see all tenants;
  // currently scoped to the JWT's tid for safety until plane checks land here.
  const rows = db.prepare(`
    SELECT id, tenant_id, account_id, policy_state,
           external_carrier_id, external_policy_number,
           coverage_started_at, coverage_ends_at, state_changed_at
    FROM ai_insurance_warranties
    WHERE tenant_id = ?
    ORDER BY state_changed_at DESC
  `).all(tenantId);

  res.json({ data: rows, total: (rows as unknown[]).length });
}

async function getPolicy(req: Request, res: Response): Promise<void> {
  const db = getDb(req);
  const id = String(req.params.id);

  const row = db.prepare(`
    SELECT * FROM ai_insurance_warranties WHERE id = ?
  `).get(id) as WarrantyRow | undefined;

  if (!row) { res.status(404).json({ error: "Policy not found" }); return; }
  res.json(row);
}

/**
 * POST /api/v1/insurance/policies
 * Body: { account_id, coverage_ends_at? }
 */
async function bindPolicy(req: Request, res: Response): Promise<void> {
  const db      = getDb(req);
  const actorId = getActorId(req);
  const { account_id, coverage_ends_at } = req.body as {
    account_id?:       string;
    coverage_ends_at?: string;
  };

  if (!account_id) {
    res.status(400).json({ error: "account_id is required" });
    return;
  }

  const account = db
    .prepare("SELECT id, tenant_id FROM accounts WHERE id = ?")
    .get(account_id) as { id: string; tenant_id: string } | undefined;
  if (!account) { res.status(404).json({ error: "Account not found" }); return; }

  const id  = crypto.randomUUID();
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO ai_insurance_warranties (
        id, tenant_id, account_id, policy_state,
        state_evidence_json,
        coverage_started_at, coverage_ends_at, state_changed_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'ACTIVE', '{}', ?, ?, ?, ?, ?)
    `).run(
      id, account.tenant_id, account.id,
      now, coverage_ends_at ?? null, now, now, now
    );

    // Sync badge to reflect the now-bound ACTIVE policy. Idempotent —
    // if account creation already seeded green, this is a no-op.
    syncBadge(db, account.tenant_id, account.id, { policy_state: "ACTIVE" });
  })();

  commercialAuditLog(
    db, account.tenant_id, actorId, id, "bind", null, "ACTIVE",
    { account_id, coverage_ends_at }
  );

  res.status(201).json({
    id,
    tenant_id:           account.tenant_id,
    account_id:          account.id,
    policy_state:        "ACTIVE",
    coverage_started_at: now,
    coverage_ends_at:    coverage_ends_at ?? null,
  });
}

/**
 * POST /api/v1/insurance/policies/:id/recompute
 * Recompute policy state from current evidence. Idempotent.
 */
async function recomputePolicy(req: Request, res: Response): Promise<void> {
  const db      = getDb(req);
  const actorId = getActorId(req);
  const id      = String(req.params.id);

  const warranty = db
    .prepare("SELECT * FROM ai_insurance_warranties WHERE id = ?")
    .get(id) as WarrantyRow | undefined;
  if (!warranty) { res.status(404).json({ error: "Policy not found" }); return; }

  // Recompute + apply + badge sync run atomically. The badge sync is
  // unconditional — even when applyStateTransition is a no-op, the
  // evidence-driven amber check may still flip green↔amber on an
  // otherwise-stable ACTIVE policy.
  let result: ReturnType<typeof applyStateTransition>;
  let badge:  ReturnType<typeof syncBadge>;
  db.transaction(() => {
    const evaluation = evaluatePolicyState(db, warranty.tenant_id);
    result = applyStateTransition(db, warranty, evaluation.state, evaluation.evidence, actorId);
    badge  = syncBadge(db, warranty.tenant_id, warranty.account_id, {
      policy_state: result.current_state,
      evidence:     evaluation.evidence,
    });
  })();

  res.json({
    ...result!,
    badge: {
      state:     badge!.state,
      changed:   badge!.changed,
      signature: badge!.signature,
    },
  });
}

/**
 * PATCH /api/v1/insurance/policies/:id/external
 * Body: { external_carrier_id?, external_policy_number? }
 */
async function attachExternal(req: Request, res: Response): Promise<void> {
  const db      = getDb(req);
  const actorId = getActorId(req);
  const id      = String(req.params.id);
  const { external_carrier_id, external_policy_number } = req.body as {
    external_carrier_id?:    string;
    external_policy_number?: string;
  };

  const warranty = db
    .prepare("SELECT tenant_id, external_carrier_id, external_policy_number FROM ai_insurance_warranties WHERE id = ?")
    .get(id) as {
      tenant_id: string;
      external_carrier_id: string | null;
      external_policy_number: string | null;
    } | undefined;
  if (!warranty) { res.status(404).json({ error: "Policy not found" }); return; }

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE ai_insurance_warranties
       SET external_carrier_id    = ?,
           external_policy_number = ?,
           updated_at             = ?
     WHERE id = ?
  `).run(
    external_carrier_id    ?? warranty.external_carrier_id,
    external_policy_number ?? warranty.external_policy_number,
    now, id
  );

  commercialAuditLog(
    db, warranty.tenant_id, actorId, id, "external_attach",
    JSON.stringify({
      carrier: warranty.external_carrier_id,
      policy:  warranty.external_policy_number,
    }),
    JSON.stringify({
      carrier: external_carrier_id    ?? warranty.external_carrier_id,
      policy:  external_policy_number ?? warranty.external_policy_number,
    })
  );

  res.json({ id, updated_at: now });
}

// ─── Router Assembly ──────────────────────────────────────────────────────────

export function createInsuranceRouter(): Router {
  const router = Router();

  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  router.use(requireAccessToken);

  router.get("/policies",                       async_(listPolicies));
  router.get("/policies/:id",                   async_(getPolicy));
  router.post("/policies",                      async_(bindPolicy));
  router.post("/policies/:id/recompute",        async_(recomputePolicy));
  router.patch("/policies/:id/external",        async_(attachExternal));

  return router;
}

// Re-export for tests and async job runners that need to drive state
// transitions outside the HTTP layer.
export { evaluatePolicyState, applyStateTransition };

export default createInsuranceRouter;
