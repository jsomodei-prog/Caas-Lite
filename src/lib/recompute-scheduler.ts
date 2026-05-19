/**
 * src/lib/recompute-scheduler.ts
 * Periodic warranty recompute, packaged so it can run two ways:
 *
 *   1. In-process timer — startScheduler(app) at boot. Single-instance only.
 *   2. External cron — POST /api/v1/admin/recompute-all (see admin route).
 *
 * Both call the same core function: recomputeAllWarranties(). That function
 * is the single source of truth for "walk all warranties, re-evaluate, sync
 * badge for each." It is safe to invoke from either entry point or even
 * both simultaneously (SQLite serialises writes; the worst outcome is a
 * redundant transaction).
 *
 * When scale demands multi-instance: set RECOMPUTE_SCHEDULER_ENABLED=false
 * in the host that should NOT run the in-process timer, and point an
 * external cron at the admin endpoint instead. No code change required.
 */

import type { Express } from "express";
import type { Database as DB } from "better-sqlite3";
import { evaluatePolicyState, applyStateTransition } from "../routes/insurance";
import { syncBadge } from "./badge-sync";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecomputeRunSummary {
  scanned:        number;
  state_changes:  number;
  badge_changes:  number;
  errors:         number;
  duration_ms:    number;
  started_at:     string;
  finished_at:    string;
}

interface WarrantyForRecompute {
  id:                 string;
  tenant_id:          string;
  account_id:         string;
  policy_state:       "ACTIVE" | "VOID_BY_ANOMALY_RATIO" | "VOID_BY_COMPLIANCE_DRIFT";
  state_evidence_json: string;
  coverage_started_at: string;
  coverage_ends_at:   string | null;
  state_changed_at:   string;
  created_at:         string;
  updated_at:         string;
  external_carrier_id:    string | null;
  external_policy_number: string | null;
}

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * Walks all warranties in state ACTIVE and re-evaluates them. Voided
 * warranties are skipped — once void, terminal state until manual
 * reinstatement (TODO: reinstatement endpoint, separate work item).
 *
 * Each warranty's evaluation runs in its own transaction so a failure
 * on one doesn't take down the whole scan. The function returns a
 * summary; callers (timer or admin route) log and respond.
 *
 * Errors during a single warranty's evaluation are caught and counted
 * but do not propagate. This is the right behaviour for a scheduled
 * job: one bad row should not silence the next 1000.
 */
export function recomputeAllWarranties(db: DB): RecomputeRunSummary {
  const startedAt = new Date().toISOString();
  const startMs   = Date.now();

  const warranties = db.prepare(`
    SELECT id, tenant_id, account_id, policy_state, state_evidence_json,
           coverage_started_at, coverage_ends_at, state_changed_at,
           created_at, updated_at,
           external_carrier_id, external_policy_number
    FROM ai_insurance_warranties
    WHERE policy_state = 'ACTIVE'
  `).all() as WarrantyForRecompute[];

  let scanned       = 0;
  let stateChanges  = 0;
  let badgeChanges  = 0;
  let errors        = 0;

  for (const warranty of warranties) {
    scanned++;
    try {
      db.transaction(() => {
        const evaluation = evaluatePolicyState(db, warranty.tenant_id);
        // applyStateTransition expects a full WarrantyRow — the SELECT above
        // already returns one. Cast is structural rather than nominal.
        const result = applyStateTransition(
          db,
          warranty as Parameters<typeof applyStateTransition>[1],
          evaluation.state,
          evaluation.evidence,
          null   // system actor — no human triggered this
        );
        if (result.changed) stateChanges++;

        const badge = syncBadge(db, warranty.tenant_id, warranty.account_id, {
          policy_state: result.current_state,
          evidence:     evaluation.evidence,
        });
        if (badge.changed) badgeChanges++;
      })();
    } catch (err) {
      errors++;
      // eslint-disable-next-line no-console
      console.error(
        `[recompute-scheduler] error on warranty ${warranty.id}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return {
    scanned,
    state_changes:  stateChanges,
    badge_changes:  badgeChanges,
    errors,
    duration_ms:    Date.now() - startMs,
    started_at:     startedAt,
    finished_at:    new Date().toISOString(),
  };
}

// ─── In-process timer ────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes

interface SchedulerHandle {
  stop: () => void;
  intervalMs: number;
}

/**
 * Starts the in-process recompute timer. Returns a handle the caller can
 * use to stop it (useful in tests). Idempotent — if a timer is already
 * running on this app, the existing handle is returned.
 *
 * Disabled via env var RECOMPUTE_SCHEDULER_ENABLED=false. Useful when:
 *   - Running tests (set in jest setup)
 *   - Running multiple app instances (set on all but one, or all of them
 *     if an external cron is taking over)
 *   - Local development where periodic background writes are noisy
 */
export function startScheduler(
  app: Express,
  opts: { intervalMs?: number } = {}
): SchedulerHandle | null {
  if (process.env.RECOMPUTE_SCHEDULER_ENABLED === "false") {
    // eslint-disable-next-line no-console
    console.log("[recompute-scheduler] disabled via RECOMPUTE_SCHEDULER_ENABLED=false");
    return null;
  }

  const existing = (app.locals as { recomputeSchedulerHandle?: SchedulerHandle })
    .recomputeSchedulerHandle;
  if (existing) return existing;

  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const db = (app.locals as { db: DB }).db;
  if (!db) throw new Error("startScheduler: app.locals.db not set");

  const tick = (): void => {
    try {
      const summary = recomputeAllWarranties(db);
      if (summary.scanned > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[recompute-scheduler] scanned=${summary.scanned} ` +
          `state_changes=${summary.state_changes} ` +
          `badge_changes=${summary.badge_changes} ` +
          `errors=${summary.errors} ` +
          `duration=${summary.duration_ms}ms`
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[recompute-scheduler] tick failed:", err);
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Don't keep the event loop alive on the timer's behalf — host process
  // should be able to exit cleanly when SIGTERM'd even if a tick is queued.
  if (typeof timer.unref === "function") timer.unref();

  const handle: SchedulerHandle = {
    intervalMs,
    stop: () => {
      clearInterval(timer);
      delete (app.locals as { recomputeSchedulerHandle?: SchedulerHandle })
        .recomputeSchedulerHandle;
    },
  };
  (app.locals as { recomputeSchedulerHandle: SchedulerHandle })
    .recomputeSchedulerHandle = handle;

  // eslint-disable-next-line no-console
  console.log(`[recompute-scheduler] started (interval ${intervalMs}ms)`);
  return handle;
}
