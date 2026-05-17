/**
 * src/analytics/anomaly.ts
 * Real-time anomaly scoring, structured logging, multi-channel alerting,
 * and auto-lockout execution with 7-day shadow scan integration.
 * Commit baseline: a4f5db6  |  Phase 9 build-out
 */

import crypto from "crypto";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AnomalyEventType =
  | "rapid_balance_drain"
  | "threshold_spike"
  | "off_hours_payout"
  | "high_frequency_payout"
  | "cross_tenant_probe"
  | "invalid_hmac_sequence"
  | "shadow_scan_trigger"
  | "failed_auth_burst"
  | "policy_reload_flood"
  | "large_single_transfer";

export type AnomalyRiskLevel = "low" | "medium" | "high" | "critical";

export type LockoutType = "soft" | "hard" | "shadow";

export interface AnomalyEvent {
  /** The entity triggering the anomaly (agent_id, user_id, or IP). */
  entity_id: string;
  entity_type: "agent" | "user" | "ip";
  tenant_id: string;
  event_type: AnomalyEventType;
  /** Raw numeric value that triggered this event (e.g., drain amount, attempt count). */
  observed_value: number;
  /** Context bag serialised to JSON string. */
  context: Record<string, unknown>;
}

export interface AnomalyLogRow {
  id: string;
  entity_id: string;
  entity_type: string;
  tenant_id: string;
  event_type: AnomalyEventType;
  observed_value: number;
  risk_level: AnomalyRiskLevel;
  score: number;
  context_json: string;
  lockout_applied: LockoutType | null;
  lockout_until: string | null;
  alert_dispatched: 0 | 1;
  created_at: string;
}

export interface ScoredAnomaly {
  score: number;
  risk_level: AnomalyRiskLevel;
  should_lock: boolean;
  lockout_type: LockoutType | null;
  lockout_duration_hours: number | null;
}

export interface AlertPayload {
  anomaly_id: string;
  entity_id: string;
  entity_type: string;
  tenant_id: string;
  event_type: AnomalyEventType;
  risk_level: AnomalyRiskLevel;
  score: number;
  observed_value: number;
  context: Record<string, unknown>;
  occurred_at: string;
  lockout_applied: LockoutType | null;
  lockout_until: string | null;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const ALERT_WEBHOOK_URL = process.env.ANOMALY_ALERT_WEBHOOK ?? "";
const ALERT_EMAIL_API_URL = process.env.ANOMALY_EMAIL_API_URL ?? "";
const ALERT_EMAIL_API_KEY = process.env.ANOMALY_EMAIL_API_KEY ?? "";
const ALERT_EMAIL_TO = process.env.ANOMALY_EMAIL_TO ?? "";
const ALERT_EMAIL_FROM = process.env.ANOMALY_EMAIL_FROM ?? "alerts@caas.internal";
const HMAC_SECRET = process.env.PAYOUT_HMAC_SECRET ?? "";

/** Business hours in UTC (06:00–22:00). Payouts outside this window are flagged. */
const BUSINESS_HOUR_START_UTC = 6;
const BUSINESS_HOUR_END_UTC = 22;

/**
 * Scoring weights for each event type.
 * Final score = base_weight × severity_multiplier.
 * Scores are bounded to [0, 100].
 */
const EVENT_BASE_SCORES: Record<AnomalyEventType, number> = {
  rapid_balance_drain: 35,
  threshold_spike: 20,
  off_hours_payout: 15,
  high_frequency_payout: 25,
  cross_tenant_probe: 70,
  invalid_hmac_sequence: 55,
  shadow_scan_trigger: 80,
  failed_auth_burst: 50,
  policy_reload_flood: 30,
  large_single_transfer: 40,
};

/** Score thresholds for risk level classification. */
const RISK_THRESHOLDS = { medium: 20, high: 45, critical: 70 } as const;

/** Lockout rules per risk level. */
const LOCKOUT_RULES: Record<
  AnomalyRiskLevel,
  { type: LockoutType | null; hours: number | null }
> = {
  low: { type: null, hours: null },
  medium: { type: "soft", hours: 1 },
  high: { type: "hard", hours: 24 },
  critical: { type: "shadow", hours: 7 * 24 }, // 7-day shadow scan lockout
};

// ─── Scoring Engine ───────────────────────────────────────────────────────────

/**
 * Computes a severity multiplier based on observed_value relative to
 * event-specific thresholds.  Range: [1.0, 3.0].
 */
function computeSeverityMultiplier(
  eventType: AnomalyEventType,
  observedValue: number
): number {
  switch (eventType) {
    case "rapid_balance_drain": {
      // observedValue = fraction drained (0–1)
      if (observedValue >= 0.9) return 3.0;
      if (observedValue >= 0.7) return 2.0;
      if (observedValue >= 0.5) return 1.5;
      return 1.0;
    }
    case "high_frequency_payout": {
      // observedValue = number of payouts in sliding window
      if (observedValue >= 20) return 3.0;
      if (observedValue >= 10) return 2.0;
      if (observedValue >= 5) return 1.5;
      return 1.0;
    }
    case "large_single_transfer": {
      // observedValue = GHS amount
      if (observedValue >= 40_000) return 3.0;
      if (observedValue >= 20_000) return 2.0;
      if (observedValue >= 10_000) return 1.5;
      return 1.0;
    }
    case "failed_auth_burst": {
      // observedValue = failed attempts in window
      if (observedValue >= 20) return 3.0;
      if (observedValue >= 10) return 2.0;
      if (observedValue >= 5) return 1.5;
      return 1.0;
    }
    case "invalid_hmac_sequence": {
      // observedValue = consecutive invalid HMACs
      if (observedValue >= 5) return 3.0;
      if (observedValue >= 3) return 2.0;
      return 1.0;
    }
    case "policy_reload_flood": {
      // observedValue = reloads per minute
      if (observedValue >= 30) return 3.0;
      if (observedValue >= 15) return 2.0;
      if (observedValue >= 5) return 1.5;
      return 1.0;
    }
    default:
      return 1.0;
  }
}

/**
 * Applies a recency boost to the score when the same entity triggered the
 * same event type multiple times in the past 24 hours.
 * Returns an additive score bonus [0, 15].
 */
function computeRecencyBonus(
  db: DB,
  entityId: string,
  eventType: AnomalyEventType,
  windowHours = 24
): number {
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM anomaly_logs
       WHERE entity_id = ? AND event_type = ? AND created_at >= ?`
    )
    .get(entityId, eventType, since) as { cnt: number };
  const count = row.cnt;
  if (count >= 10) return 15;
  if (count >= 5) return 10;
  if (count >= 2) return 5;
  return 0;
}

/**
 * Core scoring function.  Returns the clamped [0, 100] score along with
 * the derived risk level, lockout recommendation, and lockout duration.
 */
export function scoreAnomaly(
  db: DB,
  event: AnomalyEvent
): ScoredAnomaly {
  const base = EVENT_BASE_SCORES[event.event_type];
  const multiplier = computeSeverityMultiplier(event.event_type, event.observed_value);
  const recency = computeRecencyBonus(db, event.entity_id, event.event_type);

  const rawScore = base * multiplier + recency;
  const score = Math.min(100, Math.round(rawScore));

  let risk_level: AnomalyRiskLevel = "low";
  if (score >= RISK_THRESHOLDS.critical) risk_level = "critical";
  else if (score >= RISK_THRESHOLDS.high) risk_level = "high";
  else if (score >= RISK_THRESHOLDS.medium) risk_level = "medium";

  const lockoutRule = LOCKOUT_RULES[risk_level];
  const should_lock = lockoutRule.type !== null;

  return {
    score,
    risk_level,
    should_lock,
    lockout_type: lockoutRule.type,
    lockout_duration_hours: lockoutRule.hours,
  };
}

// ─── Lockout Execution ────────────────────────────────────────────────────────

function computeLockoutUntil(hours: number): string {
  return new Date(Date.now() + hours * 3_600_000).toISOString();
}

function applyAgentLockout(
  db: DB,
  agentId: string,
  lockoutType: LockoutType,
  lockoutUntil: string
): void {
  if (lockoutType === "shadow") {
    // Shadow scan: agent can still transact but every action is logged verbosely.
    db.prepare(
      "UPDATE agents SET shadow_scan_until = ?, locked = 0 WHERE id = ?"
    ).run(lockoutUntil, agentId);
  } else {
    // Soft / Hard: lock the agent outright.
    db.prepare(
      "UPDATE agents SET locked = 1, lockout_until = ? WHERE id = ?"
    ).run(lockoutUntil, agentId);
  }
}

function applyUserLockout(
  db: DB,
  userId: string,
  lockoutType: LockoutType,
  lockoutUntil: string
): void {
  if (lockoutType === "shadow") {
    db.prepare(
      "UPDATE users SET shadow_scan_until = ?, locked = 0 WHERE id = ?"
    ).run(lockoutUntil, userId);
  } else {
    db.prepare(
      "UPDATE users SET locked = 1, locked_until = ? WHERE id = ?"
    ).run(lockoutUntil, userId);
  }
}

function applyIpLockout(
  db: DB,
  ip: string,
  lockoutUntil: string
): void {
  db.prepare(
    `INSERT INTO ip_lockouts (ip, locked_until, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET locked_until = excluded.locked_until`
  ).run(ip, lockoutUntil, new Date().toISOString());
}

function executeLockout(
  db: DB,
  event: AnomalyEvent,
  lockoutType: LockoutType,
  lockoutUntil: string
): void {
  switch (event.entity_type) {
    case "agent":
      applyAgentLockout(db, event.entity_id, lockoutType, lockoutUntil);
      break;
    case "user":
      applyUserLockout(db, event.entity_id, lockoutType, lockoutUntil);
      break;
    case "ip":
      applyIpLockout(db, event.entity_id, lockoutUntil);
      break;
  }
}

// ─── Alert Dispatch ───────────────────────────────────────────────────────────

function buildAlertSignature(payload: AlertPayload): string {
  const canonical = JSON.stringify({
    anomaly_id: payload.anomaly_id,
    entity_id: payload.entity_id,
    risk_level: payload.risk_level,
    score: payload.score,
    occurred_at: payload.occurred_at,
  });
  return crypto.createHmac("sha256", HMAC_SECRET).update(canonical).digest("hex");
}

async function dispatchWebhookAlert(payload: AlertPayload): Promise<void> {
  if (!ALERT_WEBHOOK_URL) return;
  const signature = buildAlertSignature(payload);
  const response = await fetch(ALERT_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CaaS-Signature": signature,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Webhook alert failed [${response.status}]: ${body}`);
  }
}

async function dispatchEmailAlert(payload: AlertPayload): Promise<void> {
  if (!ALERT_EMAIL_API_URL || !ALERT_EMAIL_TO) return;
  const body = {
    from: ALERT_EMAIL_FROM,
    to: [ALERT_EMAIL_TO],
    subject: `[CaaS ALERT] ${payload.risk_level.toUpperCase()} — ${payload.event_type} on ${payload.entity_type} ${payload.entity_id}`,
    html: `
      <h2>CaaS Anomaly Alert</h2>
      <table>
        <tr><td><b>Anomaly ID</b></td><td>${payload.anomaly_id}</td></tr>
        <tr><td><b>Entity</b></td><td>${payload.entity_type}:${payload.entity_id}</td></tr>
        <tr><td><b>Tenant</b></td><td>${payload.tenant_id}</td></tr>
        <tr><td><b>Event Type</b></td><td>${payload.event_type}</td></tr>
        <tr><td><b>Risk Level</b></td><td>${payload.risk_level}</td></tr>
        <tr><td><b>Score</b></td><td>${payload.score}/100</td></tr>
        <tr><td><b>Observed Value</b></td><td>${payload.observed_value}</td></tr>
        <tr><td><b>Lockout Applied</b></td><td>${payload.lockout_applied ?? "none"}</td></tr>
        <tr><td><b>Lockout Until</b></td><td>${payload.lockout_until ?? "—"}</td></tr>
        <tr><td><b>Occurred At</b></td><td>${payload.occurred_at}</td></tr>
      </table>
      <h3>Context</h3>
      <pre>${JSON.stringify(payload.context, null, 2)}</pre>
    `,
  };
  const response = await fetch(ALERT_EMAIL_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ALERT_EMAIL_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Email alert failed [${response.status}]: ${text}`);
  }
}

async function dispatchAlerts(payload: AlertPayload): Promise<void> {
  const results = await Promise.allSettled([
    dispatchWebhookAlert(payload),
    dispatchEmailAlert(payload),
  ]);
  // Log but don't throw — alert failures must not block the main anomaly flow.
  for (const result of results) {
    if (result.status === "rejected") {
      console.error("[anomaly] Alert dispatch error:", result.reason);
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Main entry point.  Score, log, lock, and alert for a given anomaly event.
 * Designed to be called from middleware, payout hooks, and auth routes.
 *
 * @returns The persisted AnomalyLogRow (useful for test assertions).
 */
export async function processAnomaly(
  db: DB,
  event: AnomalyEvent
): Promise<AnomalyLogRow> {
  const scored = scoreAnomaly(db, event);
  const createdAt = new Date().toISOString();
  const id = crypto.randomUUID();

  let lockoutApplied: LockoutType | null = null;
  let lockoutUntil: string | null = null;

  if (scored.should_lock && scored.lockout_type && scored.lockout_duration_hours) {
    lockoutUntil = computeLockoutUntil(scored.lockout_duration_hours);
    lockoutApplied = scored.lockout_type;
    executeLockout(db, event, scored.lockout_type, lockoutUntil);
  }

  const contextJson = JSON.stringify(event.context);

  db.prepare(
    `INSERT INTO anomaly_logs
       (id, entity_id, entity_type, tenant_id, event_type, observed_value,
        risk_level, score, context_json, lockout_applied, lockout_until,
        alert_dispatched, created_at)
     VALUES
       (@id, @entity_id, @entity_type, @tenant_id, @event_type, @observed_value,
        @risk_level, @score, @context_json, @lockout_applied, @lockout_until,
        0, @created_at)`
  ).run({
    id,
    entity_id: event.entity_id,
    entity_type: event.entity_type,
    tenant_id: event.tenant_id,
    event_type: event.event_type,
    observed_value: event.observed_value,
    risk_level: scored.risk_level,
    score: scored.score,
    context_json: contextJson,
    lockout_applied: lockoutApplied,
    lockout_until: lockoutUntil,
    created_at: createdAt,
  });

  // Only alert for medium risk and above.
  let alertDispatched: 0 | 1 = 0;
  if (scored.risk_level !== "low") {
    const alertPayload: AlertPayload = {
      anomaly_id: id,
      entity_id: event.entity_id,
      entity_type: event.entity_type,
      tenant_id: event.tenant_id,
      event_type: event.event_type,
      risk_level: scored.risk_level,
      score: scored.score,
      observed_value: event.observed_value,
      context: event.context,
      occurred_at: createdAt,
      lockout_applied: lockoutApplied,
      lockout_until: lockoutUntil,
    };
    await dispatchAlerts(alertPayload);
    alertDispatched = 1;
    db.prepare(
      "UPDATE anomaly_logs SET alert_dispatched = 1 WHERE id = ?"
    ).run(id);
  }

  return {
    id,
    entity_id: event.entity_id,
    entity_type: event.entity_type,
    tenant_id: event.tenant_id,
    event_type: event.event_type,
    observed_value: event.observed_value,
    risk_level: scored.risk_level,
    score: scored.score,
    context_json: contextJson,
    lockout_applied: lockoutApplied,
    lockout_until: lockoutUntil,
    alert_dispatched: alertDispatched,
    created_at: createdAt,
  };
}

// ─── Convenience Detectors ───────────────────────────────────────────────────

/**
 * Detects whether a payout attempt occurs outside defined business hours.
 * Call immediately before dispatching a payout.
 */
export async function detectOffHoursPayout(
  db: DB,
  agentId: string,
  tenantId: string,
  amountGhs: number
): Promise<AnomalyLogRow | null> {
  const hourUtc = new Date().getUTCHours();
  if (hourUtc >= BUSINESS_HOUR_START_UTC && hourUtc < BUSINESS_HOUR_END_UTC) {
    return null;
  }
  return processAnomaly(db, {
    entity_id: agentId,
    entity_type: "agent",
    tenant_id: tenantId,
    event_type: "off_hours_payout",
    observed_value: hourUtc,
    context: { hour_utc: hourUtc, amount_g_h_s: amountGhs },
  });
}

/**
 * Detects rapid balance drain over a rolling window.
 * @param previousBalance  Agent balance before the pending payout.
 * @param payoutAmount     Amount being swept.
 */
export async function detectRapidBalanceDrain(
  db: DB,
  agentId: string,
  tenantId: string,
  previousBalance: number,
  payoutAmount: number
): Promise<AnomalyLogRow | null> {
  if (previousBalance <= 0) return null;
  const fraction = payoutAmount / previousBalance;
  if (fraction < 0.5) return null; // Under 50 % drain is not anomalous.
  return processAnomaly(db, {
    entity_id: agentId,
    entity_type: "agent",
    tenant_id: tenantId,
    event_type: "rapid_balance_drain",
    observed_value: fraction,
    context: {
      previous_balance_g_h_s: previousBalance,
      payout_amount_g_h_s: payoutAmount,
      drain_fraction: fraction,
    },
  });
}

/**
 * Detects high-frequency payout attempts within a sliding window.
 * @param windowMinutes  Sliding window size in minutes (default 60).
 * @param maxAllowed     Maximum payouts before anomaly fires (default 3).
 */
export async function detectHighFrequencyPayouts(
  db: DB,
  agentId: string,
  tenantId: string,
  windowMinutes = 60,
  maxAllowed = 3
): Promise<AnomalyLogRow | null> {
  const since = new Date(Date.now() - windowMinutes * 60_000).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) as cnt FROM payout_logs
       WHERE agent_id = ? AND created_at >= ? AND status NOT IN ('duplicate','failed')`
    )
    .get(agentId, since) as { cnt: number };
  if (row.cnt <= maxAllowed) return null;
  return processAnomaly(db, {
    entity_id: agentId,
    entity_type: "agent",
    tenant_id: tenantId,
    event_type: "high_frequency_payout",
    observed_value: row.cnt,
    context: {
      window_minutes: windowMinutes,
      payout_count: row.cnt,
      max_allowed: maxAllowed,
    },
  });
}

/**
 * Detects a burst of failed authentication attempts for a user.
 */
export async function detectFailedAuthBurst(
  db: DB,
  userId: string,
  tenantId: string,
  failedAttempts: number,
  windowMinutes: number
): Promise<AnomalyLogRow | null> {
  if (failedAttempts < 5) return null;
  return processAnomaly(db, {
    entity_id: userId,
    entity_type: "user",
    tenant_id: tenantId,
    event_type: "failed_auth_burst",
    observed_value: failedAttempts,
    context: { failed_attempts: failedAttempts, window_minutes: windowMinutes },
  });
}

/**
 * Queries the anomaly log for a tenant with optional filtering.
 */
export function queryAnomalyLogs(
  db: DB,
  tenantId: string,
  filters: {
    entity_id?: string;
    risk_level?: AnomalyRiskLevel;
    event_type?: AnomalyEventType;
    since?: string;
    limit?: number;
    offset?: number;
  } = {}
): AnomalyLogRow[] {
  let sql =
    "SELECT * FROM anomaly_logs WHERE tenant_id = @tenant_id";
  const params: Record<string, unknown> = { tenant_id: tenantId };

  if (filters.entity_id) {
    sql += " AND entity_id = @entity_id";
    params.entity_id = filters.entity_id;
  }
  if (filters.risk_level) {
    sql += " AND risk_level = @risk_level";
    params.risk_level = filters.risk_level;
  }
  if (filters.event_type) {
    sql += " AND event_type = @event_type";
    params.event_type = filters.event_type;
  }
  if (filters.since) {
    sql += " AND created_at >= @since";
    params.since = filters.since;
  }

  sql += " ORDER BY created_at DESC LIMIT @limit OFFSET @offset";
  params.limit = filters.limit ?? 100;
  params.offset = filters.offset ?? 0;

  return db.prepare(sql).all(params) as AnomalyLogRow[];
}

/**
 * Returns aggregate risk statistics for a tenant's anomaly log.
 */
export function getAnomalyStats(
  db: DB,
  tenantId: string,
  since?: string
): {
  total: number;
  by_risk_level: Record<AnomalyRiskLevel, number>;
  by_event_type: Partial<Record<AnomalyEventType, number>>;
  lockouts_applied: number;
} {
  const base = since
    ? "FROM anomaly_logs WHERE tenant_id = ? AND created_at >= ?"
    : "FROM anomaly_logs WHERE tenant_id = ?";
  const args: unknown[] = since ? [tenantId, since] : [tenantId];

  const total = (
    db.prepare(`SELECT COUNT(*) as cnt ${base}`).get(...args) as { cnt: number }
  ).cnt;

  const byRisk = db
    .prepare(`SELECT risk_level, COUNT(*) as cnt ${base} GROUP BY risk_level`)
    .all(...args) as { risk_level: AnomalyRiskLevel; cnt: number }[];

  const byEvent = db
    .prepare(`SELECT event_type, COUNT(*) as cnt ${base} GROUP BY event_type`)
    .all(...args) as { event_type: AnomalyEventType; cnt: number }[];

  const lockouts = (
    db
      .prepare(`SELECT COUNT(*) as cnt ${base} AND lockout_applied IS NOT NULL`)
      .get(...args) as { cnt: number }
  ).cnt;

  return {
    total,
    by_risk_level: {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
      ...Object.fromEntries(byRisk.map((r) => [r.risk_level, r.cnt])),
    } as Record<AnomalyRiskLevel, number>,
    by_event_type: Object.fromEntries(
      byEvent.map((r) => [r.event_type, r.cnt])
    ) as Partial<Record<AnomalyEventType, number>>,
    lockouts_applied: lockouts,
  };
}
