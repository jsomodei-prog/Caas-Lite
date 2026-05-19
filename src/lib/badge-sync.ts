/**
 * src/lib/badge-sync.ts
 * Single source of truth for trust badge state writes.
 *
 * Both insurance.ts (on state transitions) and provisioning.ts (on
 * initial account creation) call into this module to upsert the badge
 * row and append a history entry. No route writes to trust_badge_registry
 * or trust_badge_history directly.
 *
 * Idempotent: if the badge state computed for the inputs matches the
 * row already in place, the function is a no-op (no signature churn,
 * no spurious history entry). This matters because insurance.recompute
 * is safe to call repeatedly.
 *
 * The signature stored in the registry is the HMAC computed by
 * src/routes/badge.ts → signBadgeState(). Importing across the
 * routes/lib boundary is allowed because badge.ts re-exports the
 * signing function specifically for this purpose.
 */

import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { signBadgeState } from "../routes/badge";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BadgeState = "green" | "amber" | "red";

/**
 * Inputs the badge state depends on. The caller computes these (or passes
 * through evidence from evaluatePolicyState) — we don't re-query.
 */
export interface BadgeStateInputs {
  /** Current warranty policy state, if a warranty exists. NULL/undefined
   *  means no warranty bound yet — badge defaults to 'green' on the
   *  assumption that an unwarrantied account is still in good standing. */
  policy_state?: "ACTIVE" | "VOID_BY_ANOMALY_RATIO" | "VOID_BY_COMPLIANCE_DRIFT" | null;

  /** Evidence snapshot from the most recent policy evaluation. Used for
   *  the amber threshold check and for surfacing a state_reason. */
  evidence?: {
    anomaly_ratio?:      number;
    threshold?:          number;
    boundary_crossings?: number;
    window_days?:        number;
    [k: string]: unknown;
  };
}

// ─── Amber threshold logic ───────────────────────────────────────────────────

/**
 * Fraction of the void threshold at which we surface amber. So if anomaly
 * threshold is 2%, amber fires at 1.5% (75% of the way there). Caller never
 * picks this — it's defined here so amber is consistent across the system.
 *
 * CALIBRATE: chosen by gut, not data. Real product calibration would tune
 * this against false-positive rates from pilot data.
 */
const AMBER_THRESHOLD_RATIO = 0.75;

function computeBadgeState(inputs: BadgeStateInputs): { state: BadgeState; reason: string | null } {
  // No warranty bound → assume green. The account is provisioned but
  // not yet under coverage; no signal exists to suggest otherwise.
  if (!inputs.policy_state || inputs.policy_state === "ACTIVE") {
    // Even ACTIVE policies can be amber if evidence is approaching threshold.
    const ev = inputs.evidence ?? {};
    if (
      typeof ev.anomaly_ratio === "number" &&
      typeof ev.threshold === "number" &&
      ev.threshold > 0 &&
      ev.anomaly_ratio >= ev.threshold * AMBER_THRESHOLD_RATIO &&
      ev.anomaly_ratio < ev.threshold
    ) {
      return {
        state: "amber",
        reason: `Anomaly ratio ${(ev.anomaly_ratio * 100).toFixed(1)}% approaching ${(ev.threshold * 100).toFixed(1)}% threshold`,
      };
    }
    return { state: "green", reason: null };
  }

  // Voided states are unambiguously red.
  if (inputs.policy_state === "VOID_BY_ANOMALY_RATIO") {
    const ratio = inputs.evidence?.anomaly_ratio;
    return {
      state: "red",
      reason: typeof ratio === "number"
        ? `Coverage void: anomaly ratio ${(ratio * 100).toFixed(1)}% exceeds threshold`
        : "Coverage void: anomaly ratio exceeds threshold",
    };
  }
  if (inputs.policy_state === "VOID_BY_COMPLIANCE_DRIFT") {
    const crossings = inputs.evidence?.boundary_crossings;
    return {
      state: "red",
      reason: typeof crossings === "number"
        ? `Coverage void: ${crossings} boundary crossings detected`
        : "Coverage void: compliance drift detected",
    };
  }

  // Fallthrough for any future policy state we haven't mapped — fail
  // safe to green rather than red, so an unrecognised state doesn't
  // visibly broadcast a problem we don't actually understand.
  return { state: "green", reason: null };
}

// ─── Core ────────────────────────────────────────────────────────────────────

export interface SyncBadgeResult {
  state:    BadgeState;
  reason:   string | null;
  changed:  boolean;
  signature: string;
}

/**
 * Idempotently upserts the badge row for a tenant. Appends a row to
 * trust_badge_history only when the state actually changes.
 *
 * Returns the resulting state, whether anything changed, and the current
 * signature — useful for callers that want to surface the signature back
 * to the operator (e.g. provisioning response).
 *
 * Safe to call inside a larger transaction or standalone.
 */
export function syncBadge(
  db: DB,
  tenantId: string,
  accountId: string,
  inputs: BadgeStateInputs
): SyncBadgeResult {
  const computed = computeBadgeState(inputs);
  const now      = new Date().toISOString();

  const existing = db.prepare(`
    SELECT badge_state, state_signature, state_reason
    FROM trust_badge_registry
    WHERE tenant_id = ?
  `).get(tenantId) as
    | { badge_state: BadgeState; state_signature: string; state_reason: string | null }
    | undefined;

  // No-op path: state and reason both unchanged. Skip the write entirely
  // so the stored signature stays valid for embedders who already have it.
  if (existing && existing.badge_state === computed.state && existing.state_reason === computed.reason) {
    return {
      state:     existing.badge_state,
      reason:    existing.state_reason,
      changed:   false,
      signature: existing.state_signature,
    };
  }

  const signature = signBadgeState(tenantId, computed.state, now);

  if (existing) {
    db.prepare(`
      UPDATE trust_badge_registry
         SET badge_state      = ?,
             state_signature  = ?,
             state_reason     = ?,
             state_changed_at = ?,
             updated_at       = ?
       WHERE tenant_id = ?
    `).run(computed.state, signature, computed.reason, now, now, tenantId);
  } else {
    db.prepare(`
      INSERT INTO trust_badge_registry (
        tenant_id, account_id, badge_state, state_signature, state_reason,
        state_changed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(tenantId, accountId, computed.state, signature, computed.reason, now, now, now);
  }

  // Append history entry. NULL from_state on the first ever entry.
  db.prepare(`
    INSERT INTO trust_badge_history (
      id, tenant_id, account_id, from_state, to_state, reason, changed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(), tenantId, accountId,
    existing?.badge_state ?? null,
    computed.state,
    computed.reason,
    now
  );

  return {
    state:     computed.state,
    reason:    computed.reason,
    changed:   true,
    signature,
  };
}

// Exported for tests that want to verify the mapping without touching DB.
export { computeBadgeState };
