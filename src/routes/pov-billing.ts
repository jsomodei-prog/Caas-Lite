/**
 * src/routes/pov-billing.ts
 * Phase 15 — Value-Based Billing & Proof-of-Value (PoV) Exporters.
 *
 * Endpoints (JWT-authenticated):
 *   GET  /api/v1/pov/:accountId/statement          JSON ROI statement
 *   GET  /api/v1/pov/:accountId/statement.txt      fixed-width text statement
 *
 * Algorithm (intentionally legible for executive stakeholders):
 *
 *   risks_blocked      = denied access attempts in window
 *   crossings_blocked  = boundary crossings in window (severity-weighted)
 *   value_delivered    = (risks_blocked × baseline)
 *                        + (crossings_blocked × baseline × CROSSING_MULTIPLIER)
 *   platform_cost      = tier monthly cost × pro-rated days in window
 *   roi_ratio          = value_delivered / platform_cost
 *
 * Baselines and multipliers are tier-keyed constants. Real values come
 * from underwriting research — TODO(phase15).
 *
 * Evidence source:
 *   - role_access_metrics (Phase 12) for blocked-risk counts.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import type { Database as DB } from "better-sqlite3";
import { requireAccessToken } from "./auth";
import type { AccountTier } from "./provisioning";

// ─── Tier-Keyed Penalty Model (TODO: calibrate) ───────────────────────────────

/** Cost (USD) a single compliance failure would impose on a customer at this tier. */
const PENALTY_BASELINE_USD: Record<AccountTier, number> = {
  LITE:       5_000,
  GROWTH:    25_000,
  ENTERPRISE: 100_000,
};

/** Monthly platform cost (USD) by tier. */
const TIER_MONTHLY_COST_USD: Record<AccountTier, number> = {
  LITE:         500,
  GROWTH:     2_500,
  ENTERPRISE: 12_000,
};

/** Boundary crossings are weighted higher than ordinary denials. */
const CROSSING_MULTIPLIER = 3;

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountForStatement {
  id:                string;
  tenant_id:         string;
  tier:              AccountTier;
  display_name:      string;
  pilot_started_at:  string | null;
  pilot_ends_at:     string | null;
}

interface StatementMetrics {
  risks_blocked:      number;
  crossings_blocked:  number;
  total_requests:     number;
  window_days:        number;
  window_start:       string;
  window_end:         string;
}

interface Statement {
  account: AccountForStatement;
  metrics: StatementMetrics;
  economics: {
    penalty_baseline_usd:  number;
    crossing_multiplier:   number;
    value_delivered_usd:   number;
    platform_cost_usd:     number;
    roi_ratio:             number;        // value_delivered / platform_cost
    net_value_usd:         number;        // value_delivered - platform_cost
  };
  generated_at: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDb(req: Request): DB {
  return (req.app.locals as { db: DB }).db;
}

function parseWindowDays(req: Request): number {
  const raw = parseInt((req.query.window_days as string) ?? "30", 10);
  if (!Number.isFinite(raw) || raw <= 0) return 30;
  return Math.min(raw, 365);
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

// ─── Core: Statement Builder ──────────────────────────────────────────────────

function buildStatement(db: DB, accountId: string, windowDays: number): Statement | null {
  const account = db.prepare(`
    SELECT id, tenant_id, tier, display_name, pilot_started_at, pilot_ends_at
    FROM accounts WHERE id = ?
  `).get(accountId) as AccountForStatement | undefined;
  if (!account) return null;

  const windowStart = isoDaysAgo(windowDays);
  const windowEnd   = new Date().toISOString();

  const counts = db.prepare(`
    SELECT
      COUNT(*)                                                   AS total_requests,
      SUM(CASE WHEN access_granted = 0 THEN 1 ELSE 0 END)        AS risks_blocked,
      SUM(CASE WHEN is_boundary_crossing = 1 AND access_granted = 0 THEN 1 ELSE 0 END)
                                                                 AS crossings_blocked
    FROM role_access_metrics
    WHERE user_tenant_id = ? AND evaluated_at > ?
  `).get(account.tenant_id, windowStart) as {
    total_requests:    number;
    risks_blocked:     number;
    crossings_blocked: number;
  };

  const baseline      = PENALTY_BASELINE_USD[account.tier];
  const ordinaryValue = (counts.risks_blocked - counts.crossings_blocked) * baseline;
  const crossingValue = counts.crossings_blocked * baseline * CROSSING_MULTIPLIER;
  const valueDelivered = Math.max(0, ordinaryValue) + crossingValue;

  const monthlyCost  = TIER_MONTHLY_COST_USD[account.tier];
  const platformCost = monthlyCost * (windowDays / 30);

  const roiRatio = platformCost > 0 ? valueDelivered / platformCost : 0;

  return {
    account,
    metrics: {
      risks_blocked:     counts.risks_blocked ?? 0,
      crossings_blocked: counts.crossings_blocked ?? 0,
      total_requests:    counts.total_requests ?? 0,
      window_days:       windowDays,
      window_start:      windowStart,
      window_end:        windowEnd,
    },
    economics: {
      penalty_baseline_usd: baseline,
      crossing_multiplier:  CROSSING_MULTIPLIER,
      value_delivered_usd:  Math.round(valueDelivered),
      platform_cost_usd:    Math.round(platformCost),
      roi_ratio:            Math.round(roiRatio * 100) / 100,
      net_value_usd:        Math.round(valueDelivered - platformCost),
    },
    generated_at: windowEnd,
  };
}

// ─── Fixed-Width Renderer ─────────────────────────────────────────────────────

const W = 64;  // statement width in characters

function hr(char = "─"): string {
  return char.repeat(W);
}

function pad(left: string, right: string): string {
  const space = W - left.length - right.length;
  return left + (space > 0 ? " ".repeat(space) : " ") + right;
}

function usd(n: number): string {
  return "$" + n.toLocaleString("en-US");
}

function renderTextStatement(s: Statement): string {
  const lines: string[] = [];

  lines.push(hr("═"));
  lines.push(pad("CaaS PROOF-OF-VALUE STATEMENT", s.account.tier));
  lines.push(hr("═"));
  lines.push("");
  lines.push(pad("Account:",     s.account.display_name));
  lines.push(pad("Account ID:",  s.account.id));
  lines.push(pad("Tenant:",      s.account.tenant_id));
  lines.push(pad("Window:",      `${s.metrics.window_days} days`));
  lines.push(pad("Generated:",   s.generated_at));
  lines.push("");
  lines.push(hr());
  lines.push("EVIDENCE (Phase 12 role_access_metrics)");
  lines.push(hr());
  lines.push(pad("Total requests evaluated:",   String(s.metrics.total_requests)));
  lines.push(pad("Risks blocked (denials):",    String(s.metrics.risks_blocked)));
  lines.push(pad("  of which boundary crossings:", String(s.metrics.crossings_blocked)));
  lines.push("");
  lines.push(hr());
  lines.push("ECONOMICS");
  lines.push(hr());
  lines.push(pad("Per-incident penalty baseline:", usd(s.economics.penalty_baseline_usd)));
  lines.push(pad(`Crossing severity multiplier:`,  `${s.economics.crossing_multiplier}×`));
  lines.push("");
  lines.push(pad("Value delivered:",   usd(s.economics.value_delivered_usd)));
  lines.push(pad("Platform cost:",     usd(s.economics.platform_cost_usd)));
  lines.push(pad("Net value to you:",  usd(s.economics.net_value_usd)));
  lines.push(pad("ROI multiple:",      `${s.economics.roi_ratio}×`));
  lines.push("");
  lines.push(hr("═"));
  lines.push("This statement is auto-generated from logged evidence.");
  lines.push("It is not a binding invoice. Confirm with your account team.");
  lines.push(hr("═"));

  return lines.join("\n") + "\n";
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function getJsonStatement(req: Request, res: Response): Promise<void> {
  const db         = getDb(req);
  const accountId  = String(req.params.accountId);
  const windowDays = parseWindowDays(req);

  const statement = buildStatement(db, accountId, windowDays);
  if (!statement) { res.status(404).json({ error: "Account not found" }); return; }

  res.json(statement);
}

async function getTextStatement(req: Request, res: Response): Promise<void> {
  const db         = getDb(req);
  const accountId  = String(req.params.accountId);
  const windowDays = parseWindowDays(req);

  const statement = buildStatement(db, accountId, windowDays);
  if (!statement) { res.status(404).type("text/plain").send("Account not found\n"); return; }

  res.type("text/plain").send(renderTextStatement(statement));
}

// ─── Router Assembly ──────────────────────────────────────────────────────────

export function createPovBillingRouter(): Router {
  const router = Router();

  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  router.use(requireAccessToken);

  router.get("/:accountId/statement",      async_(getJsonStatement));
  router.get("/:accountId/statement.txt",  async_(getTextStatement));

  return router;
}

// Exported for tests and any future scheduled-export jobs.
export { buildStatement, renderTextStatement };

export default createPovBillingRouter;
