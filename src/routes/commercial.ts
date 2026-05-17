/**
 * src/routes/commercial.ts
 * Commercial Pipeline API Routes.
 *
 * Endpoints:
 *   GET  /api/v1/commercial/invoice-summary        — Executive only
 *   GET  /api/v1/commercial/invoice/:id            — Executive only
 *   POST /api/v1/commercial/invoice/generate       — Executive only
 *   GET  /api/v1/commercial/insurance-certificate  — Executive + Auditor
 *   POST /api/v1/commercial/insurance/register     — Executive only
 *   POST /api/v1/commercial/insurance/audit        — Executive only
 *   GET  /api/v1/commercial/subscription           — Executive + Auditor
 *   POST /api/v1/commercial/subscription/create    — Executive only
 *   POST /api/v1/commercial/token/apply            — Executive only
 *   GET  /api/v1/commercial/tokens                 — Executive + Auditor
 *
 * All routes require a valid JWT access token (requireAccessToken middleware).
 * Role enforcement is applied per route using requireRole().
 *
 * Phase 12-13 build-out | Commit baseline: cc20b1a
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { requireAccessToken }  from "./auth";
import { CommercialEngine, type SubscriptionTier, type CoverageType } from "../services/commercialEngine";
import type { CaaSRole } from "./auth";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDb(req: Request): DB {
  return (req.app.locals as { db: DB }).db;
}

function getTenantId(req: Request): string {
  const id = req.headers["x-tenant-id"] as string | undefined;
  if (!id) throw Object.assign(new Error("X-Tenant-ID header is required"), { status: 400 });
  return id;
}

function getEngine(req: Request): CommercialEngine {
  return new CommercialEngine(getDb(req));
}

// ─── Role Guard ───────────────────────────────────────────────────────────────

function requireRole(...roles: CaaSRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = (req as Request & { caasRole?: CaaSRole }).caasRole;
    if (!role || !roles.includes(role)) {
      res.status(403).json({
        error:    "Forbidden — insufficient role",
        required: roles,
        actual:   role ?? "none",
      });
      return;
    }
    next();
  };
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

/**
 * GET /api/v1/commercial/invoice-summary
 * Returns a paginated list of billing ledgers with line-item totals,
 * period parameters, settlement status, and applied token details.
 * Authorization: Executive
 */
async function getInvoiceSummary(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const engine   = getEngine(req);
  const db       = getDb(req);

  const limit  = Math.min(parseInt((req.query.limit  as string) ?? "12", 10), 50);
  const offset = parseInt((req.query.offset as string) ?? "0", 10);
  const status = req.query.status as string | undefined;

  let query = "SELECT * FROM commercial_billing_ledgers WHERE tenant_id = ?";
  const params: unknown[] = [tenantId];

  if (status) {
    query += " AND status = ?";
    params.push(status);
  }

  query += " ORDER BY period_start DESC LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const ledgers = db.prepare(query).all(...params) as ReturnType<typeof engine.getLedgerHistory>;

  const countRow = db
    .prepare("SELECT COUNT(*) as cnt FROM commercial_billing_ledgers WHERE tenant_id = ?" + (status ? " AND status = ?" : ""))
    .get(...(status ? [tenantId, status] : [tenantId])) as { cnt: number };

  // Enrich each ledger with line items and token info
  const enriched = ledgers.map((ledger) => {
    const lineItems = engine.getLineItems(ledger.id);

    let tokenInfo: {
      token_id:     string;
      discount_pct: number;
      status:       string;
      issued_at:    string;
    } | null = null;

    if (ledger.applied_token_id) {
      const tok = db
        .prepare("SELECT id, discount_pct, status, issued_at FROM premium_reduction_tokens WHERE id = ?")
        .get(ledger.applied_token_id) as typeof tokenInfo;
      tokenInfo = tok ?? null;
    }

    // Verify invoice signature to confirm tamper-evidence
    const expectedSig = (() => {
      const HMAC_SECRET = process.env.PAYOUT_HMAC_SECRET ?? "dev_hmac_secret";
      return crypto
        .createHmac("sha256", HMAC_SECRET)
        .update(`${ledger.invoice_number}|${ledger.total_usd}|${ledger.period_start}|${ledger.period_end}|${ledger.status}`)
        .digest("hex");
    })();
    const signature_valid = ledger.signature === expectedSig;

    return {
      ...ledger,
      line_items:       lineItems,
      token_info:       tokenInfo,
      signature_valid,
      days_outstanding: ledger.due_at && ledger.status !== "paid"
        ? Math.max(0, Math.floor((Date.now() - new Date(ledger.due_at).getTime()) / 86_400_000))
        : 0,
    };
  });

  // Summary aggregates
  const aggregates = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'paid'    THEN total_usd ELSE 0 END) AS total_paid_usd,
      SUM(CASE WHEN status = 'issued'  THEN total_usd ELSE 0 END) AS total_outstanding_usd,
      SUM(CASE WHEN status = 'overdue' THEN total_usd ELSE 0 END) AS total_overdue_usd,
      SUM(premium_discount_usd)                                   AS total_discounts_usd,
      COUNT(*)                                                    AS total_invoices,
      AVG(total_usd)                                             AS avg_invoice_usd
    FROM commercial_billing_ledgers
    WHERE tenant_id = ?
  `).get(tenantId) as {
    total_paid_usd:        number;
    total_outstanding_usd: number;
    total_overdue_usd:     number;
    total_discounts_usd:   number;
    total_invoices:        number;
    avg_invoice_usd:       number;
  };

  // Current subscription snapshot
  let subscription: ReturnType<CommercialEngine["getSubscription"]> = null;
  try { subscription = engine.getSubscription(tenantId); } catch { subscription = null; }

  // Current period commitment preview (if subscription exists)
  let currentPeriodPreview: ReturnType<CommercialEngine["evaluateMonthlyCommitment"]> | null = null;
  if (subscription) {
    try { currentPeriodPreview = engine.evaluateMonthlyCommitment(tenantId); } catch { currentPeriodPreview = null; }
  }

  res.json({
    tenant_id:            tenantId,
    generated_at:         new Date().toISOString(),
    pagination: {
      limit,
      offset,
      total: countRow.cnt,
      has_more: offset + limit < countRow.cnt,
    },
    aggregates: {
      total_paid_usd:        aggregates.total_paid_usd        ?? 0,
      total_outstanding_usd: aggregates.total_outstanding_usd ?? 0,
      total_overdue_usd:     aggregates.total_overdue_usd     ?? 0,
      total_discounts_usd:   aggregates.total_discounts_usd   ?? 0,
      total_invoices:        aggregates.total_invoices         ?? 0,
      avg_invoice_usd:       aggregates.avg_invoice_usd        ?? 0,
    },
    subscription,
    current_period_preview: currentPeriodPreview,
    invoices:               enriched,
  });
}

/**
 * GET /api/v1/commercial/invoice/:id
 * Returns a single billing ledger with full line items and token detail.
 * Authorization: Executive
 */
async function getInvoice(req: Request, res: Response): Promise<void> {
  const tenantId  = getTenantId(req);
  const db        = getDb(req);
  const engine    = getEngine(req);
  const ledgerId  = String(req.params.id);

  const ledger = db
    .prepare("SELECT * FROM commercial_billing_ledgers WHERE id = ? AND tenant_id = ?")
    .get(ledgerId, tenantId);

  if (!ledger) { res.status(404).json({ error: "Invoice not found" }); return; }

  const lineItems = engine.getLineItems(ledgerId);

  res.json({ ledger, line_items: lineItems });
}

/**
 * POST /api/v1/commercial/invoice/generate
 * Generates and persists a new invoice for the current billing period.
 * Body: { fx_rate?, invoice_currency? }
 * Authorization: Executive
 */
async function generateInvoice(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const engine   = getEngine(req);

  const fxRate         = parseFloat((req.body as { fx_rate?: string }).fx_rate ?? "1.0") || 1.0;
  const invoiceCurrency = (req.body as { invoice_currency?: string }).invoice_currency ?? "USD";

  const result = engine.generateInvoice(tenantId, fxRate, invoiceCurrency);

  res.status(201).json({
    message:    "Invoice generated successfully",
    invoice_id: result.ledger.id,
    invoice_number: result.ledger.invoice_number,
    total_usd:  result.ledger.total_usd,
    total_local: result.ledger.total_local,
    currency:   result.ledger.invoice_currency,
    status:     result.ledger.status,
    due_at:     result.ledger.due_at,
    line_items: result.lineItems,
  });
}

/**
 * GET /api/v1/commercial/insurance-certificate
 * Returns the full insurance underwriting certificate including:
 *   - Policy details (carrier, coverage type, limits, deductible)
 *   - Current risk score, band, and effective premium
 *   - Golden thread hash chain proof
 *   - Last 5 audit snapshots with component scores
 *   - All active premium reduction tokens
 *   - Certificate validity digest
 * Authorization: Executive, Auditor
 */
async function getInsuranceCertificate(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const engine   = getEngine(req);
  const db       = getDb(req);

  const registry = engine.getUnderwritingRegistry(tenantId);

  if (!registry) {
    res.status(404).json({
      error:   "No active insurance policy found for this tenant",
      hint:    "Register a policy via POST /api/v1/commercial/insurance/register",
    });
    return;
  }

  const snapshots    = engine.getAuditSnapshots(registry.id, 5);
  const activeTokens = engine.getActiveTokens(tenantId);

  // Compute a certificate digest: SHA-256 over key policy fields
  const HMAC_SECRET = process.env.PAYOUT_HMAC_SECRET ?? "dev_hmac_secret";
  const certificateDigest = crypto
    .createHmac("sha256", HMAC_SECRET)
    .update([
      registry.policy_number,
      registry.tenant_id,
      registry.risk_score.toFixed(2),
      registry.risk_band,
      registry.golden_thread_hash,
      registry.last_audit_at,
    ].join("|"))
    .digest("hex");

  // Risk band descriptions
  const BAND_DESCRIPTIONS: Record<string, string> = {
    GREEN:  "Exemplary risk posture — all operational, security, compliance, and financial metrics within optimal bounds.",
    AMBER:  "Satisfactory risk posture — minor anomalies detected; within acceptable thresholds for standard coverage.",
    ORANGE: "Elevated risk posture — multiple contributing factors identified; corrective action recommended.",
    RED:    "High risk posture — significant incidents recorded; coverage under review; no premium reduction eligible.",
  };

  // Days until policy expiry
  const daysToExpiry = Math.max(0, Math.floor(
    (new Date(registry.policy_end_date).getTime() - Date.now()) / 86_400_000
  ));

  // Days until next scheduled audit
  const daysToNextAudit = Math.max(0, Math.floor(
    (new Date(registry.next_audit_at).getTime() - Date.now()) / 86_400_000
  ));

  // Golden thread integrity check (verify the chain is unbroken from the last snapshot)
  let goldenThreadValid = true;
  if (snapshots.length > 0) {
    const latest = snapshots[0];
    goldenThreadValid = latest.chained_hash === registry.golden_thread_hash;
  }

  // Applied discount value (annualised)
  const discountedAnnualPremium = registry.verified_discount_pct !== null
    ? Math.round(registry.base_annual_premium_usd * (1 - registry.verified_discount_pct / 100) * 100) / 100
    : registry.base_annual_premium_usd;

  const annualSavingsUsd = registry.verified_discount_pct !== null
    ? Math.round((registry.base_annual_premium_usd - discountedAnnualPremium) * 100) / 100
    : 0;

  // Subscription tier (for context on what drives the premium)
  const subscription = (() => {
    try { return engine.getSubscription(tenantId); } catch { return null; }
  })();

  res.json({
    certificate_type:    "insurance_underwriting_certificate",
    generated_at:        new Date().toISOString(),
    certificate_digest:  certificateDigest,
    golden_thread_valid: goldenThreadValid,
    tenant_id:           tenantId,

    policy: {
      id:                    registry.id,
      policy_number:         registry.policy_number,
      carrier_name:          registry.carrier_name,
      carrier_id:            registry.carrier_id,
      coverage_type:         registry.coverage_type,
      coverage_limit_usd:    registry.coverage_limit_usd,
      deductible_usd:        registry.deductible_usd,
      jurisdiction:          registry.jurisdiction,
      policy_start_date:     registry.policy_start_date,
      policy_end_date:       registry.policy_end_date,
      days_to_expiry:        daysToExpiry,
      status:                registry.status,
    },

    risk_assessment: {
      risk_score:               registry.risk_score,
      risk_band:                registry.risk_band,
      risk_band_description:    BAND_DESCRIPTIONS[registry.risk_band] ?? "",
      consecutive_clean_audits: registry.consecutive_clean_audits,
      last_audit_at:            registry.last_audit_at,
      next_audit_at:            registry.next_audit_at,
      days_to_next_audit:       daysToNextAudit,
      golden_thread_hash:       registry.golden_thread_hash,
    },

    premium: {
      base_annual_premium_usd:     registry.base_annual_premium_usd,
      verified_discount_pct:       registry.verified_discount_pct,
      effective_annual_premium_usd: discountedAnnualPremium,
      monthly_premium_usd:         Math.round((discountedAnnualPremium / 12) * 100) / 100,
      annual_savings_usd:          annualSavingsUsd,
    },

    audit_history: snapshots.map((s) => ({
      snapshot_id:          s.id,
      audit_period:         { start: s.audit_period_start, end: s.audit_period_end },
      composite_risk_score: s.composite_risk_score,
      risk_band:            s.resulting_risk_band,
      component_scores: {
        operational: s.score_operational,
        security:    s.score_security,
        compliance:  s.score_compliance,
        financial:   s.score_financial,
      },
      key_inputs: {
        anomaly_count_high:      s.anomaly_count_high,
        anomaly_count_critical:  s.anomaly_count_critical,
        payout_failure_rate:     s.payout_failure_rate,
        slow_query_count:        s.slow_query_count,
        regulatory_breach_count: s.regulatory_breach_count,
        db_integrity_ok:         s.db_integrity_ok === 1,
      },
      discount_emitted:  s.discount_pct_emitted,
      token_issued:      s.token_id !== null,
      audited_at:        s.audited_at,
      chained_hash:      s.chained_hash.slice(0, 16) + "…",
    })),

    active_tokens: activeTokens.map((t) => ({
      token_id:           t.id,
      discount_pct:       t.discount_pct,
      discount_value_usd: t.discount_value_usd,
      expires_at:         t.expires_at,
      issued_at:          t.issued_at,
      days_remaining:     Math.max(0, Math.floor(
        (new Date(t.expires_at).getTime() - Date.now()) / 86_400_000
      )),
    })),

    subscription_context: subscription
      ? { tier: subscription.tier, billing_cycle: subscription.billing_cycle, status: subscription.status }
      : null,

    compliance_notes: [
      `This certificate is generated on-demand and reflects the underwriting state at ${new Date().toISOString()}.`,
      `The golden thread hash chain provides a tamper-evident audit trail of all risk assessments.`,
      `Certificate digest: ${certificateDigest.slice(0, 16)}… — verify against your records.`,
      ...(daysToExpiry < 30
        ? [`WARNING: Policy expires in ${daysToExpiry} days. Contact your carrier to renew.`]
        : []),
      ...(registry.risk_band === "RED"
        ? ["NOTICE: Risk band is RED. No premium reduction is applicable. Immediate remediation recommended."]
        : []),
    ],
  });
}

/**
 * POST /api/v1/commercial/insurance/register
 * Registers a new insurance policy in the underwriting registry.
 * Body: { carrier_name, carrier_id, policy_number, coverage_type, coverage_limit_usd,
 *         deductible_usd, base_annual_premium_usd, policy_start_date, policy_end_date,
 *         jurisdiction? }
 * Authorization: Executive
 */
async function registerPolicy(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const engine   = getEngine(req);

  const body = req.body as {
    carrier_name:              string;
    carrier_id:                string;
    policy_number:             string;
    coverage_type:             CoverageType;
    coverage_limit_usd:        number;
    deductible_usd:            number;
    base_annual_premium_usd:   number;
    policy_start_date:         string;
    policy_end_date:           string;
    jurisdiction?:             string;
  };

  const required = [
    "carrier_name", "carrier_id", "policy_number", "coverage_type",
    "coverage_limit_usd", "deductible_usd", "base_annual_premium_usd",
    "policy_start_date", "policy_end_date",
  ] as const;

  for (const field of required) {
    if (!body[field]) {
      res.status(400).json({ error: `Field "${field}" is required` });
      return;
    }
  }

  const registry = engine.registerPolicy({
    tenantId,
    carrierName:          body.carrier_name,
    carrierId:            body.carrier_id,
    policyNumber:         body.policy_number,
    coverageType:         body.coverage_type,
    coverageLimitUsd:     Number(body.coverage_limit_usd),
    deductibleUsd:        Number(body.deductible_usd),
    baseAnnualPremiumUsd: Number(body.base_annual_premium_usd),
    policyStartDate:      body.policy_start_date,
    policyEndDate:        body.policy_end_date,
    jurisdiction:         body.jurisdiction,
  });

  res.status(201).json({
    message:        "Insurance policy registered successfully",
    registry_id:    registry.id,
    policy_number:  registry.policy_number,
    initial_risk_band: registry.risk_band,
    next_audit_at:  registry.next_audit_at,
  });
}

/**
 * POST /api/v1/commercial/insurance/audit
 * Triggers an on-demand underwriting risk audit for the tenant.
 * Body: { registry_id }
 * Authorization: Executive
 */
async function triggerUnderwritingAudit(req: Request, res: Response): Promise<void> {
  const tenantId  = getTenantId(req);
  const engine    = getEngine(req);
  const registryId = String((req.body as { registry_id?: string }).registry_id ?? "");

  if (!registryId) { res.status(400).json({ error: "registry_id is required" }); return; }

  const result = engine.computeUnderwritingRiskScore(tenantId, registryId);

  res.json({
    message:              "Underwriting audit completed",
    snapshot_id:          result.snapshot_id,
    composite_risk_score: result.composite_risk_score,
    risk_band:            result.risk_band,
    discount_pct:         result.discount_pct,
    token_issued:         result.token_id !== null,
    token_id:             result.token_id,
    component_scores:     result.component_scores,
    inputs:               result.inputs,
  });
}

/**
 * GET /api/v1/commercial/subscription
 * Returns the tenant's current commercial subscription.
 * Authorization: Executive, Auditor
 */
async function getSubscription(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const engine   = getEngine(req);

  const sub = engine.getSubscription(tenantId);

  if (!sub) {
    res.status(404).json({
      error: "No subscription found for this tenant",
      hint:  "Create one via POST /api/v1/commercial/subscription/create",
    });
    return;
  }

  const commitment = engine.evaluateMonthlyCommitment(tenantId);

  res.json({
    subscription: sub,
    current_period_commitment: commitment,
  });
}

/**
 * POST /api/v1/commercial/subscription/create
 * Creates a new commercial subscription for the tenant.
 * Body: { tier, billing_cycle?, invoice_currency?, contract_ref?,
 *         custom_fee?, custom_runs?, custom_monitors?,
 *         custom_overage_rate?, custom_monitor_overage? }
 * Authorization: Executive
 */
async function createSubscription(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const engine   = getEngine(req);

  const body = req.body as {
    tier:                   SubscriptionTier;
    billing_cycle?:         "monthly" | "quarterly" | "annual";
    invoice_currency?:      string;
    contract_ref?:          string;
    custom_fee?:            number;
    custom_runs?:           number;
    custom_monitors?:       number;
    custom_overage_rate?:   number;
    custom_monitor_overage?: number;
  };

  const validTiers: SubscriptionTier[] = ["PAY_AS_YOU_GO", "GROWTH", "ENTERPRISE", "CUSTOM"];
  if (!body.tier || !validTiers.includes(body.tier)) {
    res.status(400).json({ error: `tier must be one of: ${validTiers.join(", ")}` });
    return;
  }

  const sub = engine.createSubscription({
    tenantId,
    tier:                 body.tier,
    billingCycle:         body.billing_cycle,
    contractRef:          body.contract_ref,
    invoiceCurrency:      body.invoice_currency,
    customFee:            body.custom_fee          !== undefined ? Number(body.custom_fee)            : undefined,
    customRuns:           body.custom_runs          !== undefined ? Number(body.custom_runs)           : undefined,
    customMonitors:       body.custom_monitors       !== undefined ? Number(body.custom_monitors)       : undefined,
    customOverageRate:    body.custom_overage_rate   !== undefined ? Number(body.custom_overage_rate)   : undefined,
    customMonitorOverage: body.custom_monitor_overage !== undefined ? Number(body.custom_monitor_overage) : undefined,
  });

  res.status(201).json({
    message:         "Subscription created successfully",
    subscription_id: sub.id,
    tier:            sub.tier,
    monthly_fee_usd: sub.monthly_fee_usd,
    included_runs:   sub.included_runs,
    period_start:    sub.current_period_start,
    period_end:      sub.current_period_end,
  });
}

/**
 * POST /api/v1/commercial/token/apply
 * Applies a premium reduction token to an invoice.
 * Body: { ledger_id, token_id }
 * Authorization: Executive
 */
async function applyToken(req: Request, res: Response): Promise<void> {
  const engine   = getEngine(req);
  const tenantId = getTenantId(req);

  const { ledger_id, token_id } = req.body as { ledger_id?: string; token_id?: string };
  if (!ledger_id) { res.status(400).json({ error: "ledger_id is required" }); return; }
  if (!token_id)  { res.status(400).json({ error: "token_id is required" });  return; }

  // Verify ledger belongs to this tenant
  const ledger = getDb(req)
    .prepare("SELECT tenant_id FROM commercial_billing_ledgers WHERE id = ?")
    .get(ledger_id) as { tenant_id: string } | undefined;

  if (!ledger) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (ledger.tenant_id !== tenantId) { res.status(403).json({ error: "Invoice belongs to different tenant" }); return; }

  const updated = engine.applyPremiumReductionToken(ledger_id, token_id);

  res.json({
    message:        "Token applied successfully",
    invoice_id:     updated.id,
    invoice_number: updated.invoice_number,
    new_total_usd:  updated.total_usd,
    discount_usd:   updated.premium_discount_usd,
    token_id:       updated.applied_token_id,
  });
}

/**
 * GET /api/v1/commercial/tokens
 * Returns all active and historical premium reduction tokens for the tenant.
 * Authorization: Executive, Auditor
 */
async function getTokens(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const db       = getDb(req);

  const active = db.prepare(`
    SELECT * FROM premium_reduction_tokens
    WHERE tenant_id = ? AND status = 'issued' AND expires_at > ?
    ORDER BY discount_pct DESC
  `).all(tenantId, new Date().toISOString());

  const history = db.prepare(`
    SELECT * FROM premium_reduction_tokens
    WHERE tenant_id = ?
    ORDER BY issued_at DESC LIMIT 20
  `).all(tenantId);

  res.json({
    active_count:   active.length,
    active_tokens:  active,
    token_history:  history,
  });
}

// ─── Router Assembly ──────────────────────────────────────────────────────────

export function createCommercialRouter(): Router {
  const router = Router();

  // Wrap async handlers to propagate errors to Express error middleware
  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch(next);
    };

  // All commercial routes require a valid JWT access token
  router.use(requireAccessToken);

  // Invoice routes — Executive only
  router.get("/invoice-summary",      requireRole("Executive"),             async_(getInvoiceSummary));
  router.get("/invoice/:id",          requireRole("Executive"),             async_(getInvoice));
  router.post("/invoice/generate",    requireRole("Executive"),             async_(generateInvoice));

  // Insurance routes
  router.get("/insurance-certificate", requireRole("Executive", "Auditor"), async_(getInsuranceCertificate));
  router.post("/insurance/register",  requireRole("Executive"),             async_(registerPolicy));
  router.post("/insurance/audit",     requireRole("Executive"),             async_(triggerUnderwritingAudit));

  // Subscription routes
  router.get("/subscription",         requireRole("Executive", "Auditor"),  async_(getSubscription));
  router.post("/subscription/create", requireRole("Executive"),             async_(createSubscription));

  // Token routes
  router.post("/token/apply",         requireRole("Executive"),             async_(applyToken));
  router.get("/tokens",               requireRole("Executive", "Auditor"),  async_(getTokens));

  return router;
}

export default createCommercialRouter;
