/**
 * src/services/commercialEngine.ts
 * Commercial Pipeline & Actuarial Insurance Engine.
 *
 * Responsibilities:
 *   1. Subscription management — create, retrieve, and validate tenant
 *      commercial subscriptions with integrity-hash verification.
 *
 *   2. Monthly commitment evaluation — computes base fee, validation-run
 *      overages, monitor overages, and builds a full invoice with line items.
 *
 *   3. Underwriting risk scoring — reads anomaly_logs, payout_logs, slow_query_log,
 *      and health state to derive four weighted component scores that collapse into
 *      a composite 0–100 risk score → GREEN / AMBER / ORANGE / RED risk band.
 *
 *   4. Premium reduction token emission — GREEN emits 20%, AMBER 15%,
 *      ORANGE 10%; RED receives no token. Tokens are HMAC-signed, have a
 *      one-billing-period validity window, and are chained into the golden thread.
 *
 *   5. Invoice generation — creates a commercial_billing_ledgers record with
 *      all charge components, FX conversion, and a tamper-evident HMAC signature.
 *
 *   6. Token application — validates and applies an issued token to a ledger,
 *      adding a credit line item and recalculating the total.
 *
 * Phase 12-13 build-out | Commit baseline: cc20b1a
 */

import crypto           from "crypto";
import type { Database as DB } from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SubscriptionTier   = "PAY_AS_YOU_GO" | "GROWTH" | "ENTERPRISE" | "CUSTOM";
export type BillingCycle       = "monthly" | "quarterly" | "annual";
export type SubscriptionStatus = "active" | "suspended" | "cancelled" | "trial";
export type LedgerStatus       = "draft" | "issued" | "paid" | "overdue" | "voided" | "disputed";
export type RiskBand           = "GREEN" | "AMBER" | "ORANGE" | "RED";
export type CoverageType       =
  | "cyber_liability" | "professional_indemnity" | "fintech_comprehensive"
  | "data_breach"     | "operational_risk"        | "regulatory_defence";
export type TokenStatus        = "issued" | "applied" | "expired" | "revoked";

export interface TenantCommercialSubscription {
  id:                   string;
  tenant_id:            string;
  tier:                 SubscriptionTier;
  monthly_fee_usd:      number;
  included_runs:        number;
  included_monitors:    number;
  overage_rate_usd:     number;
  monitor_overage_usd:  number;
  billing_cycle:        BillingCycle;
  invoice_currency:     string;
  status:               SubscriptionStatus;
  trial_ends_at:        string | null;
  contract_ref:         string | null;
  current_period_start: string;
  current_period_end:   string;
  runs_this_period:     number;
  monitors_this_period: number;
  integrity_hash:       string;
  created_at:           string;
  updated_at:           string;
}

export interface CommercialBillingLedger {
  id:                     string;
  tenant_id:              string;
  invoice_number:         string;
  period_start:           string;
  period_end:             string;
  tier_snapshot:          string;
  monthly_fee_snapshot:   number;
  included_runs_snapshot: number;
  overage_rate_snapshot:  number;
  actual_runs:            number;
  actual_monitors:        number;
  base_fee_usd:           number;
  overage_runs_usd:       number;
  overage_monitors_usd:   number;
  insurance_premium_usd:  number;
  premium_discount_usd:   number;
  tax_usd:                number;
  total_usd:              number;
  invoice_currency:       string;
  fx_rate:                number;
  total_local:            number;
  status:                 LedgerStatus;
  issued_at:              string | null;
  due_at:                 string | null;
  paid_at:                string | null;
  payment_reference:      string | null;
  payment_method:         string | null;
  applied_token_id:       string | null;
  invoice_hash:           string;
  signature:              string;
  notes:                  string | null;
  created_at:             string;
  updated_at:             string;
}

export interface InvoiceLineItem {
  id:             string;
  ledger_id:      string;
  tenant_id:      string;
  item_type:      string;
  description:    string;
  quantity:       number;
  unit_price_usd: number;
  line_total_usd: number;
  is_credit:      number;
  sort_order:     number;
  created_at:     string;
}

export interface InsuranceUnderwritingRegistry {
  id:                          string;
  tenant_id:                   string;
  carrier_name:                string;
  carrier_id:                  string;
  policy_number:               string;
  coverage_type:               CoverageType;
  coverage_limit_usd:          number;
  deductible_usd:              number;
  base_annual_premium_usd:     number;
  risk_score:                  number;
  risk_band:                   RiskBand;
  verified_discount_pct:       number | null;
  effective_annual_premium_usd: number;
  golden_thread_hash:          string;
  policy_start_date:           string;
  policy_end_date:             string;
  last_audit_at:               string;
  next_audit_at:               string;
  consecutive_clean_audits:    number;
  status:                      string;
  jurisdiction:                string;
  created_at:                  string;
  updated_at:                  string;
}

export interface UnderwritingAuditSnapshot {
  id:                     string;
  registry_id:            string;
  tenant_id:              string;
  audit_period_start:     string;
  audit_period_end:       string;
  total_validation_runs:  number;
  failed_validation_runs: number;
  anomaly_count_high:     number;
  anomaly_count_critical: number;
  payout_failure_rate:    number;
  avg_query_duration_ms:  number;
  slow_query_count:       number;
  auth_lockout_count:     number;
  duplicate_payout_count: number;
  regulatory_breach_count: number;
  db_integrity_ok:        number;
  failover_events:        number;
  score_operational:      number;
  score_security:         number;
  score_compliance:       number;
  score_financial:        number;
  composite_risk_score:   number;
  resulting_risk_band:    RiskBand;
  discount_pct_emitted:   number | null;
  token_id:               string | null;
  snapshot_hash:          string;
  chained_hash:           string;
  audited_at:             string;
}

export interface PremiumReductionToken {
  id:                 string;
  tenant_id:          string;
  registry_id:        string;
  snapshot_id:        string;
  discount_pct:       number;
  discount_value_usd: number;
  status:             TokenStatus;
  expires_at:         string;
  applied_to_invoice: string | null;
  applied_at:         string | null;
  token_signature:    string;
  issued_at:          string;
}

export interface MonthlyCommitmentResult {
  tenant_id:               string;
  period_start:            string;
  period_end:              string;
  tier:                    SubscriptionTier;
  base_fee_usd:            number;
  included_runs:           number;
  actual_runs:             number;
  overage_runs:            number;
  overage_runs_usd:        number;
  included_monitors:       number;
  actual_monitors:         number;
  overage_monitors:        number;
  overage_monitors_usd:    number;
  insurance_premium_usd:   number;
  premium_discount_usd:    number;
  subtotal_usd:            number;
  tax_rate:                number;
  tax_usd:                 number;
  total_usd:               number;
}

export interface UnderwritingRiskResult {
  registry_id:          string;
  tenant_id:            string;
  composite_risk_score: number;
  risk_band:            RiskBand;
  discount_pct:         number | null;
  token_id:             string | null;
  snapshot_id:          string;
  component_scores: {
    operational:  number;
    security:     number;
    compliance:   number;
    financial:    number;
  };
  inputs: {
    total_validation_runs:   number;
    failed_validation_runs:  number;
    anomaly_count_high:      number;
    anomaly_count_critical:  number;
    payout_failure_rate:     number;
    avg_query_duration_ms:   number;
    slow_query_count:        number;
    auth_lockout_count:      number;
    duplicate_payout_count:  number;
    regulatory_breach_count: number;
    db_integrity_ok:         boolean;
    failover_events:         number;
  };
}

// ─── Tier Configuration ───────────────────────────────────────────────────────

export const TIER_CONFIG: Record<SubscriptionTier, {
  monthly_fee_usd:     number;
  included_runs:       number;
  included_monitors:   number;
  overage_rate_usd:    number;
  monitor_overage_usd: number;
}> = {
  PAY_AS_YOU_GO: {
    monthly_fee_usd:     0.00,
    included_runs:       100,
    included_monitors:   2,
    overage_rate_usd:    0.05,
    monitor_overage_usd: 10.00,
  },
  GROWTH: {
    monthly_fee_usd:     299.00,
    included_runs:       5_000,
    included_monitors:   10,
    overage_rate_usd:    0.03,
    monitor_overage_usd: 7.50,
  },
  ENTERPRISE: {
    monthly_fee_usd:     1_499.00,
    included_runs:       0,          // unlimited
    included_monitors:   0,          // unlimited
    overage_rate_usd:    0.00,
    monitor_overage_usd: 0.00,
  },
  CUSTOM: {
    monthly_fee_usd:     0.00,       // negotiated; read from subscription record
    included_runs:       0,
    included_monitors:   0,
    overage_rate_usd:    0.00,
    monitor_overage_usd: 0.00,
  },
};

const TAX_RATE          = 0.075;   // 7.5% VAT / service tax
const AUDIT_WINDOW_DAYS = 30;      // rolling window for risk metric collection

/**
 * Resolve the HMAC secret used by the commercial engine and every callsite
 * that signs or verifies commercial-engine artifacts (invoices, tokens,
 * underwriting snapshots, certificates).
 *
 * Behavior:
 *   - If PAYOUT_HMAC_SECRET is set in the environment, use it.
 *   - If it is NOT set and NODE_ENV === "production", THROW at module load
 *     time. Production must never sign with a known-weak fallback.
 *   - If it is NOT set and we are not in production (test / development /
 *     unset NODE_ENV), fall back to the well-known dev secret. This keeps
 *     `npm test` and local dev frictionless.
 *
 * Exported so src/routes/commercial.ts (and any future signing path) can
 * use the same loader rather than re-implementing the fallback inline —
 * which was the original CRIT-2 finding.
 */
export function loadHmacSecret(): string {
  const secret = process.env.PAYOUT_HMAC_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PAYOUT_HMAC_SECRET must be set in production. " +
      "Refusing to start with the development fallback secret."
    );
  }
  return "dev_hmac_secret";
}

const HMAC_SECRET = loadHmacSecret();

// ─── HMAC Utilities ───────────────────────────────────────────────────────────

function hmac(data: string): string {
  return crypto.createHmac("sha256", HMAC_SECRET).update(data).digest("hex");
}

function sha256(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function subscriptionIntegrityHash(sub: Pick<
  TenantCommercialSubscription,
  "id" | "tenant_id" | "tier" | "monthly_fee_usd" | "current_period_start"
>): string {
  return hmac(`${sub.id}|${sub.tenant_id}|${sub.tier}|${sub.monthly_fee_usd}|${sub.current_period_start}`);
}

function invoiceSignature(inv: Pick<
  CommercialBillingLedger,
  "invoice_number" | "total_usd" | "period_start" | "period_end" | "status"
>): string {
  return hmac(`${inv.invoice_number}|${inv.total_usd}|${inv.period_start}|${inv.period_end}|${inv.status}`);
}

function tokenSignature(params: {
  id:           string;
  tenant_id:    string;
  discount_pct: number;
  snapshot_id:  string;
  expires_at:   string;
}): string {
  return hmac(`${params.id}|${params.tenant_id}|${params.discount_pct}|${params.snapshot_id}|${params.expires_at}`);
}

// ─── Invoice Number Generator ─────────────────────────────────────────────────

function nextInvoiceNumber(db: DB, tenantId: string): string {
  const year  = new Date().getFullYear();
  const count = (db.prepare(
    "SELECT COUNT(*) as cnt FROM commercial_billing_ledgers WHERE tenant_id = ? AND invoice_number LIKE ?"
  ).get(tenantId, `INV-${tenantId.slice(0, 6).toUpperCase()}-${year}-%`) as { cnt: number }).cnt;
  return `INV-${tenantId.slice(0, 6).toUpperCase()}-${year}-${String(count + 1).padStart(4, "0")}`;
}

// ─── Risk Band Derivation ─────────────────────────────────────────────────────

function deriveRiskBand(score: number): RiskBand {
  if (score <= 25) return "GREEN";
  if (score <= 50) return "AMBER";
  if (score <= 75) return "ORANGE";
  return "RED";
}

function discountForBand(band: RiskBand): number | null {
  switch (band) {
    case "GREEN":  return 20.0;
    case "AMBER":  return 15.0;
    case "ORANGE": return 10.0;
    case "RED":    return null;
  }
}

// ─── CommercialEngine ─────────────────────────────────────────────────────────

export class CommercialEngine {
  constructor(private readonly db: DB) {}

  // ── Subscription Management ────────────────────────────────────────────────

  /**
   * Retrieves the active commercial subscription for a tenant.
   * Verifies integrity_hash before returning. Throws if hash is invalid.
   */
  getSubscription(tenantId: string): TenantCommercialSubscription | null {
    const row = this.db
      .prepare("SELECT * FROM tenant_commercial_subscriptions WHERE tenant_id = ?")
      .get(tenantId) as TenantCommercialSubscription | undefined;

    if (!row) return null;

    const expectedHash = subscriptionIntegrityHash(row);
    if (row.integrity_hash !== expectedHash) {
      throw new Error(
        `Subscription integrity check failed for tenant ${tenantId}. ` +
        `Expected ${expectedHash.slice(0, 16)}… got ${row.integrity_hash.slice(0, 16)}…`
      );
    }

    return row;
  }

  /**
   * Creates a new commercial subscription for a tenant.
   * For CUSTOM tier, caller must supply fee and limits via overrides.
   */
  createSubscription(params: {
    tenantId:       string;
    tier:           SubscriptionTier;
    billingCycle?:  BillingCycle;
    contractRef?:   string;
    invoiceCurrency?: string;
    customFee?:     number;
    customRuns?:    number;
    customMonitors?: number;
    customOverageRate?: number;
    customMonitorOverage?: number;
  }): TenantCommercialSubscription {
    const existing = this.db
      .prepare("SELECT id FROM tenant_commercial_subscriptions WHERE tenant_id = ?")
      .get(params.tenantId);
    if (existing) {
      throw new Error(`Subscription already exists for tenant ${params.tenantId}`);
    }

    const config  = TIER_CONFIG[params.tier];
    const now     = new Date();
    const periodStart = now.toISOString().slice(0, 10) + "T00:00:00.000Z";
    const periodEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10) + "T00:00:00.000Z";

    const id = crypto.randomUUID();

    const sub: TenantCommercialSubscription = {
      id,
      tenant_id:            params.tenantId,
      tier:                 params.tier,
      monthly_fee_usd:      params.customFee          ?? config.monthly_fee_usd,
      included_runs:        params.customRuns         ?? config.included_runs,
      included_monitors:    params.customMonitors      ?? config.included_monitors,
      overage_rate_usd:     params.customOverageRate  ?? config.overage_rate_usd,
      monitor_overage_usd:  params.customMonitorOverage ?? config.monitor_overage_usd,
      billing_cycle:        params.billingCycle        ?? "monthly",
      invoice_currency:     params.invoiceCurrency     ?? "USD",
      status:               "active",
      trial_ends_at:        null,
      contract_ref:         params.contractRef         ?? null,
      current_period_start: periodStart,
      current_period_end:   periodEnd,
      runs_this_period:     0,
      monitors_this_period: 0,
      integrity_hash:       "",
      created_at:           now.toISOString(),
      updated_at:           now.toISOString(),
    };

    sub.integrity_hash = subscriptionIntegrityHash(sub);

    this.db.prepare(`
      INSERT INTO tenant_commercial_subscriptions (
        id, tenant_id, tier, monthly_fee_usd, included_runs, included_monitors,
        overage_rate_usd, monitor_overage_usd, billing_cycle, invoice_currency,
        status, trial_ends_at, contract_ref, current_period_start, current_period_end,
        runs_this_period, monitors_this_period, integrity_hash, created_at, updated_at
      ) VALUES (
        @id, @tenant_id, @tier, @monthly_fee_usd, @included_runs, @included_monitors,
        @overage_rate_usd, @monitor_overage_usd, @billing_cycle, @invoice_currency,
        @status, @trial_ends_at, @contract_ref, @current_period_start, @current_period_end,
        @runs_this_period, @monitors_this_period, @integrity_hash, @created_at, @updated_at
      )
    `).run(sub);

    return sub;
  }

  /**
   * Increments the run counter for the current billing period.
   * Called after each validation run. Records an overage charge if applicable.
   */
  recordValidationRun(tenantId: string): { is_overage: boolean; charge_usd: number } {
    const sub = this.getSubscription(tenantId);
    if (!sub) throw new Error(`No subscription found for tenant ${tenantId}`);

    const newCount = sub.runs_this_period + 1;
    const now = new Date().toISOString();

    this.db.prepare(
      "UPDATE tenant_commercial_subscriptions SET runs_this_period = ?, updated_at = ? WHERE tenant_id = ?"
    ).run(newCount, now, tenantId);

    const isOverage = sub.included_runs > 0 && newCount > sub.included_runs;
    const chargeUsd = isOverage ? sub.overage_rate_usd : 0;

    if (isOverage) {
      this.db.prepare(`
        INSERT INTO overage_charge_log
          (id, tenant_id, ledger_id, overage_type, included_limit, actual_count,
           overage_units, unit_rate_usd, charge_usd, event_ref, recorded_at)
        VALUES (?, ?, NULL, 'validation_run', ?, ?, 1, ?, ?, NULL, ?)
      `).run(
        crypto.randomUUID(), tenantId,
        sub.included_runs, newCount, sub.overage_rate_usd, chargeUsd, now
      );
    }

    return { is_overage: isOverage, charge_usd: chargeUsd };
  }

  // ── Monthly Commitment Evaluation ──────────────────────────────────────────

  /**
   * Evaluates the full monthly commitment for a tenant:
   *   base_fee + overage_runs + overage_monitors + insurance_premium − discount + tax
   *
   * Does NOT persist — call generateInvoice() to create and save the ledger.
   */
  evaluateMonthlyCommitment(tenantId: string): MonthlyCommitmentResult {
    const sub = this.getSubscription(tenantId);
    if (!sub) throw new Error(`No subscription found for tenant ${tenantId}`);

    const baseFeeUsd = sub.monthly_fee_usd;

    // Overage runs
    const overageRuns = sub.included_runs > 0
      ? Math.max(0, sub.runs_this_period - sub.included_runs)
      : 0;
    const overageRunsUsd = overageRuns * sub.overage_rate_usd;

    // Overage monitors
    const overageMonitors = sub.included_monitors > 0
      ? Math.max(0, sub.monitors_this_period - sub.included_monitors)
      : 0;
    const overageMonitorsUsd = overageMonitors * sub.monitor_overage_usd;

    // Insurance premium (monthly slice of active policy, if registered)
    const policy = this.db
      .prepare("SELECT base_annual_premium_usd, verified_discount_pct FROM insurance_underwriting_registry WHERE tenant_id = ? AND status = 'active' LIMIT 1")
      .get(tenantId) as { base_annual_premium_usd: number; verified_discount_pct: number | null } | undefined;

    const annualPremiumUsd   = policy?.base_annual_premium_usd ?? 0;
    const monthlyPremiumUsd  = annualPremiumUsd / 12;

    // Active token discount
    const token = this.db
      .prepare(`
        SELECT id, discount_pct, discount_value_usd
        FROM premium_reduction_tokens
        WHERE tenant_id = ? AND status = 'issued' AND expires_at > ?
        ORDER BY discount_pct DESC LIMIT 1
      `)
      .get(tenantId, new Date().toISOString()) as
      { id: string; discount_pct: number; discount_value_usd: number } | undefined;

    const premiumDiscountUsd = token
      ? Math.min(token.discount_value_usd, monthlyPremiumUsd)
      : 0;

    const subtotalUsd = baseFeeUsd + overageRunsUsd + overageMonitorsUsd + monthlyPremiumUsd - premiumDiscountUsd;
    const taxUsd      = Math.round(subtotalUsd * TAX_RATE * 100) / 100;
    const totalUsd    = Math.round((subtotalUsd + taxUsd) * 100) / 100;

    return {
      tenant_id:             tenantId,
      period_start:          sub.current_period_start,
      period_end:            sub.current_period_end,
      tier:                  sub.tier,
      base_fee_usd:          Math.round(baseFeeUsd * 100) / 100,
      included_runs:         sub.included_runs,
      actual_runs:           sub.runs_this_period,
      overage_runs:          overageRuns,
      overage_runs_usd:      Math.round(overageRunsUsd * 100) / 100,
      included_monitors:     sub.included_monitors,
      actual_monitors:       sub.monitors_this_period,
      overage_monitors:      overageMonitors,
      overage_monitors_usd:  Math.round(overageMonitorsUsd * 100) / 100,
      insurance_premium_usd: Math.round(monthlyPremiumUsd * 100) / 100,
      premium_discount_usd:  Math.round(premiumDiscountUsd * 100) / 100,
      subtotal_usd:          Math.round(subtotalUsd * 100) / 100,
      tax_rate:              TAX_RATE,
      tax_usd:               taxUsd,
      total_usd:             totalUsd,
    };
  }

  // ── Invoice Generation ─────────────────────────────────────────────────────

  /**
   * Generates and persists a full invoice for the tenant's current billing period.
   * Creates the ledger record, all line items, and updates the applied token if present.
   */
  generateInvoice(
    tenantId:   string,
    fxRate:     number = 1.0,
    invoiceCurrency: string = "USD"
  ): { ledger: CommercialBillingLedger; lineItems: InvoiceLineItem[] } {
    const commitment  = this.evaluateMonthlyCommitment(tenantId);
    const sub         = this.getSubscription(tenantId)!;
    const now         = new Date();
    const invoiceNumber = nextInvoiceNumber(this.db, tenantId);
    const ledgerId    = crypto.randomUUID();
    const issuedAt    = now.toISOString();
    const dueAt       = new Date(now.getTime() + 14 * 86_400_000).toISOString();
    const totalLocal  = Math.round(commitment.total_usd * fxRate * 100) / 100;

    // Resolve active token
    const token = this.db
      .prepare(`
        SELECT id FROM premium_reduction_tokens
        WHERE tenant_id = ? AND status = 'issued' AND expires_at > ?
        ORDER BY discount_pct DESC LIMIT 1
      `)
      .get(tenantId, now.toISOString()) as { id: string } | undefined;

    // Build payload hash
    const payloadStr = JSON.stringify({
      ledger_id:      ledgerId,
      invoice_number: invoiceNumber,
      tenant_id:      tenantId,
      period_start:   commitment.period_start,
      period_end:     commitment.period_end,
      total_usd:      commitment.total_usd,
    });
    const invoiceHash = sha256(payloadStr);
    const sigInput    = {
      invoice_number: invoiceNumber,
      total_usd:      commitment.total_usd,
      period_start:   commitment.period_start,
      period_end:     commitment.period_end,
      status:         "issued" as LedgerStatus,
    };
    const signature = invoiceSignature(sigInput);

    const ledger: CommercialBillingLedger = {
      id:                     ledgerId,
      tenant_id:              tenantId,
      invoice_number:         invoiceNumber,
      period_start:           commitment.period_start,
      period_end:             commitment.period_end,
      tier_snapshot:          sub.tier,
      monthly_fee_snapshot:   sub.monthly_fee_usd,
      included_runs_snapshot: sub.included_runs,
      overage_rate_snapshot:  sub.overage_rate_usd,
      actual_runs:            commitment.actual_runs,
      actual_monitors:        commitment.actual_monitors,
      base_fee_usd:           commitment.base_fee_usd,
      overage_runs_usd:       commitment.overage_runs_usd,
      overage_monitors_usd:   commitment.overage_monitors_usd,
      insurance_premium_usd:  commitment.insurance_premium_usd,
      premium_discount_usd:   commitment.premium_discount_usd,
      tax_usd:                commitment.tax_usd,
      total_usd:              commitment.total_usd,
      invoice_currency:       invoiceCurrency,
      fx_rate:                fxRate,
      total_local:            totalLocal,
      status:                 "issued",
      issued_at:              issuedAt,
      due_at:                 dueAt,
      paid_at:                null,
      payment_reference:      null,
      payment_method:         null,
      applied_token_id:       token?.id ?? null,
      invoice_hash:           invoiceHash,
      signature,
      notes:                  null,
      created_at:             now.toISOString(),
      updated_at:             now.toISOString(),
    };

    const lineItems: InvoiceLineItem[] = [];

    const addLine = (
      type: string, description: string,
      quantity: number, unitPrice: number,
      isCredit = false, order = 0
    ): void => {
      const total = Math.round(quantity * unitPrice * 100) / 100;
      const item: InvoiceLineItem = {
        id:             crypto.randomUUID(),
        ledger_id:      ledgerId,
        tenant_id:      tenantId,
        item_type:      type,
        description,
        quantity,
        unit_price_usd: unitPrice,
        line_total_usd: total,
        is_credit:      isCredit ? 1 : 0,
        sort_order:     order,
        created_at:     now.toISOString(),
      };
      lineItems.push(item);
    };

    addLine("base_fee",
      `${sub.tier} plan — ${now.toLocaleString("default", { month: "long", year: "numeric" })}`,
      1, commitment.base_fee_usd, false, 10);

    if (commitment.overage_runs > 0) {
      addLine("overage_runs",
        `Validation run overages (${commitment.overage_runs} × $${sub.overage_rate_usd.toFixed(4)})`,
        commitment.overage_runs, sub.overage_rate_usd, false, 20);
    }

    if (commitment.overage_monitors > 0) {
      addLine("overage_monitors",
        `Monitor overages (${commitment.overage_monitors} × $${sub.monitor_overage_usd.toFixed(2)})`,
        commitment.overage_monitors, sub.monitor_overage_usd, false, 30);
    }

    if (commitment.insurance_premium_usd > 0) {
      addLine("insurance_premium",
        "Cyber liability insurance — monthly pro-rata",
        1, commitment.insurance_premium_usd, false, 40);
    }

    if (commitment.premium_discount_usd > 0) {
      addLine("premium_discount",
        `Underwriting premium reduction token applied`,
        1, -commitment.premium_discount_usd, true, 50);
    }

    if (commitment.tax_usd > 0) {
      addLine("tax",
        `VAT / Service tax (${(TAX_RATE * 100).toFixed(1)}%)`,
        1, commitment.tax_usd, false, 90);
    }

    // Persist everything in a single transaction
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO commercial_billing_ledgers (
          id, tenant_id, invoice_number, period_start, period_end,
          tier_snapshot, monthly_fee_snapshot, included_runs_snapshot, overage_rate_snapshot,
          actual_runs, actual_monitors,
          base_fee_usd, overage_runs_usd, overage_monitors_usd, insurance_premium_usd,
          premium_discount_usd, tax_usd, total_usd,
          invoice_currency, fx_rate, total_local,
          status, issued_at, due_at, paid_at, payment_reference, payment_method,
          applied_token_id, invoice_hash, signature, notes, created_at, updated_at
        ) VALUES (
          @id, @tenant_id, @invoice_number, @period_start, @period_end,
          @tier_snapshot, @monthly_fee_snapshot, @included_runs_snapshot, @overage_rate_snapshot,
          @actual_runs, @actual_monitors,
          @base_fee_usd, @overage_runs_usd, @overage_monitors_usd, @insurance_premium_usd,
          @premium_discount_usd, @tax_usd, @total_usd,
          @invoice_currency, @fx_rate, @total_local,
          @status, @issued_at, @due_at, @paid_at, @payment_reference, @payment_method,
          @applied_token_id, @invoice_hash, @signature, @notes, @created_at, @updated_at
        )
      `).run(ledger);

      const lineStmt = this.db.prepare(`
        INSERT INTO invoice_line_items
          (id, ledger_id, tenant_id, item_type, description, quantity,
           unit_price_usd, line_total_usd, is_credit, sort_order, created_at)
        VALUES
          (@id, @ledger_id, @tenant_id, @item_type, @description, @quantity,
           @unit_price_usd, @line_total_usd, @is_credit, @sort_order, @created_at)
      `);
      for (const item of lineItems) lineStmt.run(item);

      // Mark token as applied
      if (token) {
        this.db.prepare(
          "UPDATE premium_reduction_tokens SET status='applied', applied_to_invoice=?, applied_at=? WHERE id=?"
        ).run(ledgerId, now.toISOString(), token.id);
      }

      // Reset period counters
      this.db.prepare(
        "UPDATE tenant_commercial_subscriptions SET runs_this_period=0, monitors_this_period=0, updated_at=? WHERE tenant_id=?"
      ).run(now.toISOString(), tenantId);
    })();

    return { ledger, lineItems };
  }

  // ── Underwriting Risk Scoring ──────────────────────────────────────────────

  /**
   * Computes a continuous underwriting risk score for the tenant by reading
   * system performance and anomaly logs over the last AUDIT_WINDOW_DAYS days.
   *
   * Scoring model (lower = less risk):
   *   Operational  (30%): query duration, slow queries, failover events, DB integrity
   *   Security     (30%): anomaly HIGH/CRITICAL count, auth lockouts
   *   Compliance   (20%): regulatory breaches, duplicate payouts, KYC failures
   *   Financial    (20%): payout failure rate, overage burst frequency
   *
   * Emits a premium_reduction_token (20/15/10%) for GREEN/AMBER/ORANGE bands.
   * RED band receives no token.
   */
  computeUnderwritingRiskScore(
    tenantId:   string,
    registryId: string
  ): UnderwritingRiskResult {
    const since = new Date(Date.now() - AUDIT_WINDOW_DAYS * 86_400_000).toISOString();
    const now   = new Date().toISOString();

    // ── Collect inputs ─────────────────────────────────────────────────────

    const payoutStats = this.db.prepare(`
      SELECT
        COUNT(*)                                                      AS total_runs,
        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END)        AS failed_runs,
        SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END)        AS duplicate_runs
      FROM payout_logs
      WHERE tenant_id = ? AND created_at >= ?
    `).get(tenantId, since) as { total_runs: number; failed_runs: number; duplicate_runs: number };

    const anomalyStats = this.db.prepare(`
      SELECT
        SUM(CASE WHEN risk_level = 'high'     THEN 1 ELSE 0 END)  AS cnt_high,
        SUM(CASE WHEN risk_level = 'critical' THEN 1 ELSE 0 END)  AS cnt_critical,
        SUM(CASE WHEN lockout_applied IS NOT NULL THEN 1 ELSE 0 END) AS cnt_lockouts
      FROM anomaly_logs
      WHERE tenant_id = ? AND created_at >= ?
    `).get(tenantId, since) as { cnt_high: number; cnt_critical: number; cnt_lockouts: number };

    const slowQueryStats = this.db.prepare(`
      SELECT
        COUNT(*)               AS cnt,
        AVG(duration_ms)       AS avg_ms
      FROM slow_query_log
      WHERE recorded_at >= ?
    `).get(since) as { cnt: number; avg_ms: number | null };

    const regulatoryBreaches = (this.db.prepare(`
      SELECT COUNT(*) AS cnt
      FROM regulatory_report_log
      WHERE dispatched_at >= ?
    `).get(since) as { cnt: number } | undefined)?.cnt ?? 0;

    const failoverEvents = (this.db.prepare(`
      SELECT COUNT(*) AS cnt FROM slow_query_log WHERE label LIKE '%failover%' AND recorded_at >= ?
    `).get(since) as { cnt: number } | undefined)?.cnt ?? 0;

    // DB integrity check
    let dbIntegrityOk = true;
    try {
      const integrityRow = this.db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      dbIntegrityOk = integrityRow.integrity_check === "ok";
    } catch { dbIntegrityOk = false; }

    const totalRuns     = payoutStats.total_runs      ?? 0;
    const failedRuns    = payoutStats.failed_runs     ?? 0;
    const duplicateRuns = payoutStats.duplicate_runs  ?? 0;
    const cntHigh       = anomalyStats.cnt_high       ?? 0;
    const cntCritical   = anomalyStats.cnt_critical   ?? 0;
    const cntLockouts   = anomalyStats.cnt_lockouts   ?? 0;
    const slowCount     = slowQueryStats.cnt          ?? 0;
    const avgQueryMs    = slowQueryStats.avg_ms       ?? 0;
    const payoutFailureRate = totalRuns > 0 ? (failedRuns / totalRuns) : 0;

    // ── Compute component scores ───────────────────────────────────────────
    // Each component is 0–100. We then weight them into a composite score.
    // Higher score = higher risk.

    // Operational (DB integrity, slow queries, failover events)
    let scoreOperational = 0;
    if (!dbIntegrityOk)       scoreOperational += 40;
    if (failoverEvents > 0)   scoreOperational += Math.min(failoverEvents * 15, 30);
    if (slowCount > 50)       scoreOperational += 20;
    else if (slowCount > 20)  scoreOperational += 10;
    else if (slowCount > 5)   scoreOperational += 5;
    if (avgQueryMs > 500)     scoreOperational += 10;
    else if (avgQueryMs > 200) scoreOperational += 5;
    scoreOperational = Math.min(scoreOperational, 100);

    // Security (anomaly events, auth lockouts)
    let scoreSecurity = 0;
    scoreSecurity += Math.min(cntCritical * 12, 48);
    scoreSecurity += Math.min(cntHigh      * 4,  24);
    scoreSecurity += Math.min(cntLockouts  * 3,  18);
    scoreSecurity  = Math.min(scoreSecurity, 100);

    // Compliance (regulatory breaches, duplicate payouts)
    let scoreCompliance = 0;
    scoreCompliance += Math.min(regulatoryBreaches * 20, 60);
    scoreCompliance += Math.min(duplicateRuns      * 8,  40);
    scoreCompliance  = Math.min(scoreCompliance, 100);

    // Financial (payout failure rate)
    let scoreFinancial = 0;
    if (payoutFailureRate > 0.25)      scoreFinancial = 100;
    else if (payoutFailureRate > 0.15) scoreFinancial = 75;
    else if (payoutFailureRate > 0.08) scoreFinancial = 50;
    else if (payoutFailureRate > 0.03) scoreFinancial = 25;
    else if (payoutFailureRate > 0.01) scoreFinancial = 10;

    // Weighted composite
    const compositeScore = Math.round(
      scoreOperational * 0.30 +
      scoreSecurity    * 0.30 +
      scoreCompliance  * 0.20 +
      scoreFinancial   * 0.20
    );

    const riskBand   = deriveRiskBand(compositeScore);
    const discountPct = discountForBand(riskBand);

    // ── Retrieve registry for golden thread ────────────────────────────────

    const registry = this.db
      .prepare("SELECT * FROM insurance_underwriting_registry WHERE id = ? AND tenant_id = ?")
      .get(registryId, tenantId) as InsuranceUnderwritingRegistry | undefined;

    if (!registry) {
      throw new Error(`No underwriting registry found for id=${registryId}, tenant=${tenantId}`);
    }

    const previousGoldenHash = registry.golden_thread_hash;

    // ── Build snapshot ─────────────────────────────────────────────────────

    const snapshotId    = crypto.randomUUID();
    const auditPeriodStart = since;
    const auditPeriodEnd   = now;

    const snapshotPayload = JSON.stringify({
      snapshotId, registryId, tenantId,
      compositeScore, riskBand, discountPct,
      scoreOperational, scoreSecurity, scoreCompliance, scoreFinancial,
      totalRuns, failedRuns, duplicateRuns, cntHigh, cntCritical, cntLockouts,
      slowCount, avgQueryMs, regulatoryBreaches, failoverEvents, dbIntegrityOk,
    });
    const snapshotHash = sha256(snapshotPayload);

    // Chain the golden thread: HMAC(prev_hash || snapshot_hash)
    const chainedHash  = hmac(`${previousGoldenHash}||${snapshotHash}`);

    // ── Persist audit snapshot FIRST (token FK depends on it) ─────────────

    let tokenId: string | null = null;

    this.db.prepare(`
      INSERT INTO underwriting_audit_snapshots (
        id, registry_id, tenant_id, audit_period_start, audit_period_end,
        total_validation_runs, failed_validation_runs,
        anomaly_count_high, anomaly_count_critical, payout_failure_rate,
        avg_query_duration_ms, slow_query_count, auth_lockout_count,
        duplicate_payout_count, regulatory_breach_count, db_integrity_ok, failover_events,
        score_operational, score_security, score_compliance, score_financial,
        composite_risk_score, resulting_risk_band, discount_pct_emitted, token_id,
        snapshot_hash, chained_hash, audited_at
      ) VALUES (
        @id, @registry_id, @tenant_id, @audit_period_start, @audit_period_end,
        @total_validation_runs, @failed_validation_runs,
        @anomaly_count_high, @anomaly_count_critical, @payout_failure_rate,
        @avg_query_duration_ms, @slow_query_count, @auth_lockout_count,
        @duplicate_payout_count, @regulatory_breach_count, @db_integrity_ok, @failover_events,
        @score_operational, @score_security, @score_compliance, @score_financial,
        @composite_risk_score, @resulting_risk_band, @discount_pct_emitted, @token_id,
        @snapshot_hash, @chained_hash, @audited_at
      )
    `).run({
      id:                      snapshotId,
      registry_id:             registryId,
      tenant_id:               tenantId,
      audit_period_start:      auditPeriodStart,
      audit_period_end:        auditPeriodEnd,
      total_validation_runs:   totalRuns,
      failed_validation_runs:  failedRuns,
      anomaly_count_high:      cntHigh,
      anomaly_count_critical:  cntCritical,
      payout_failure_rate:     payoutFailureRate,
      avg_query_duration_ms:   avgQueryMs,
      slow_query_count:        slowCount,
      auth_lockout_count:      cntLockouts,
      duplicate_payout_count:  duplicateRuns,
      regulatory_breach_count: regulatoryBreaches,
      db_integrity_ok:         dbIntegrityOk ? 1 : 0,
      failover_events:         failoverEvents,
      score_operational:       scoreOperational,
      score_security:          scoreSecurity,
      score_compliance:        scoreCompliance,
      score_financial:         scoreFinancial,
      composite_risk_score:    compositeScore,
      resulting_risk_band:     riskBand,
      discount_pct_emitted:    discountPct,
      token_id:                tokenId,
      snapshot_hash:           snapshotHash,
      chained_hash:            chainedHash,
      audited_at:              now,
    });

    // ── Emit premium reduction token AFTER snapshot exists ─────────────────

    if (discountPct !== null) {
      tokenId                   = crypto.randomUUID();
      const tokenExpiresAt      = new Date(Date.now() + 60 * 86_400_000).toISOString();
      const monthlyPremium      = (registry.base_annual_premium_usd / 12);
      const discountValueUsd    = Math.round(monthlyPremium * (discountPct / 100) * 100) / 100;

      const sig = tokenSignature({
        id:           tokenId,
        tenant_id:    tenantId,
        discount_pct: discountPct,
        snapshot_id:  snapshotId,
        expires_at:   tokenExpiresAt,
      });

      this.db.prepare(`
        INSERT INTO premium_reduction_tokens
          (id, tenant_id, registry_id, snapshot_id, discount_pct, discount_value_usd,
           status, expires_at, applied_to_invoice, applied_at, token_signature, issued_at)
        VALUES (?, ?, ?, ?, ?, ?, 'issued', ?, NULL, NULL, ?, ?)
      `).run(tokenId, tenantId, registryId, snapshotId, discountPct,
             discountValueUsd, tokenExpiresAt, sig, now);

      // Update snapshot with the token id now that token exists
      this.db.prepare(
        "UPDATE underwriting_audit_snapshots SET token_id = ? WHERE id = ?"
      ).run(tokenId, snapshotId);

      // Revoke older un-applied tokens (superseded)
      this.db.prepare(
        "UPDATE premium_reduction_tokens SET status='revoked' WHERE tenant_id=? AND status='issued' AND id != ?"
      ).run(tenantId, tokenId);
    }

    // ── Update registry with new score, band, and chained hash ────────────

    const newConsecutiveClean = riskBand === "RED"
      ? 0
      : registry.consecutive_clean_audits + 1;

    const effectivePremium = discountPct !== null
      ? Math.round(registry.base_annual_premium_usd * (1 - discountPct / 100) * 100) / 100
      : registry.base_annual_premium_usd;

    const nextAuditAt = new Date(Date.now() + AUDIT_WINDOW_DAYS * 86_400_000).toISOString();

    this.db.prepare(`
      UPDATE insurance_underwriting_registry SET
        risk_score                   = @risk_score,
        risk_band                    = @risk_band,
        verified_discount_pct        = @verified_discount_pct,
        effective_annual_premium_usd = @effective_annual_premium_usd,
        golden_thread_hash           = @golden_thread_hash,
        last_audit_at                = @last_audit_at,
        next_audit_at                = @next_audit_at,
        consecutive_clean_audits     = @consecutive_clean_audits,
        updated_at                   = @updated_at
      WHERE id = @id
    `).run({
      risk_score:                   compositeScore,
      risk_band:                    riskBand,
      verified_discount_pct:        discountPct,
      effective_annual_premium_usd: effectivePremium,
      golden_thread_hash:           chainedHash,
      last_audit_at:                now,
      next_audit_at:                nextAuditAt,
      consecutive_clean_audits:     newConsecutiveClean,
      updated_at:                   now,
      id:                           registryId,
    });

    return {
      registry_id:          registryId,
      tenant_id:            tenantId,
      composite_risk_score: compositeScore,
      risk_band:            riskBand,
      discount_pct:         discountPct,
      token_id:             tokenId,
      snapshot_id:          snapshotId,
      component_scores: {
        operational: scoreOperational,
        security:    scoreSecurity,
        compliance:  scoreCompliance,
        financial:   scoreFinancial,
      },
      inputs: {
        total_validation_runs:   totalRuns,
        failed_validation_runs:  failedRuns,
        anomaly_count_high:      cntHigh,
        anomaly_count_critical:  cntCritical,
        payout_failure_rate:     payoutFailureRate,
        avg_query_duration_ms:   avgQueryMs,
        slow_query_count:        slowCount,
        auth_lockout_count:      cntLockouts,
        duplicate_payout_count:  duplicateRuns,
        regulatory_breach_count: regulatoryBreaches,
        db_integrity_ok:         dbIntegrityOk,
        failover_events:         failoverEvents,
      },
    };
  }

  // ── Token Application ──────────────────────────────────────────────────────

  /**
   * Applies a previously issued premium reduction token to a ledger.
   * Validates the token signature and status before applying.
   * Recalculates the ledger total and adds a credit line item.
   */
  applyPremiumReductionToken(ledgerId: string, tokenId: string): CommercialBillingLedger {
    const ledger = this.db
      .prepare("SELECT * FROM commercial_billing_ledgers WHERE id = ?")
      .get(ledgerId) as CommercialBillingLedger | undefined;

    if (!ledger) throw new Error(`Ledger ${ledgerId} not found`);
    if (ledger.status !== "draft" && ledger.status !== "issued") {
      throw new Error(`Token can only be applied to draft or issued invoices; current status: ${ledger.status}`);
    }

    const token = this.db
      .prepare("SELECT * FROM premium_reduction_tokens WHERE id = ?")
      .get(tokenId) as PremiumReductionToken | undefined;

    if (!token) throw new Error(`Token ${tokenId} not found`);
    if (token.status !== "issued") throw new Error(`Token ${tokenId} is ${token.status} — not available`);
    if (token.tenant_id !== ledger.tenant_id) throw new Error("Token/ledger tenant mismatch");
    if (token.expires_at < new Date().toISOString()) throw new Error("Token has expired");

    // Verify token signature
    const expectedSig = tokenSignature({
      id:           token.id,
      tenant_id:    token.tenant_id,
      discount_pct: token.discount_pct,
      snapshot_id:  token.snapshot_id,
      expires_at:   token.expires_at,
    });
    if (token.token_signature !== expectedSig) {
      throw new Error("Token signature verification failed — token may be tampered");
    }

    const discountUsd = Math.min(token.discount_value_usd, ledger.insurance_premium_usd);
    const newTotal    = Math.round((ledger.total_usd - discountUsd) * 100) / 100;
    const now         = new Date().toISOString();

    // New signature over updated total
    const newSig = invoiceSignature({ ...ledger, total_usd: newTotal });
    const newHash = sha256(JSON.stringify({ ...ledger, total_usd: newTotal, applied_token_id: tokenId }));

    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE commercial_billing_ledgers SET
          premium_discount_usd = @premium_discount_usd,
          total_usd            = @total_usd,
          total_local          = @total_local,
          applied_token_id     = @applied_token_id,
          invoice_hash         = @invoice_hash,
          signature            = @signature,
          updated_at           = @updated_at
        WHERE id = @id
      `).run({
        premium_discount_usd: discountUsd,
        total_usd:            newTotal,
        total_local:          Math.round(newTotal * ledger.fx_rate * 100) / 100,
        applied_token_id:     tokenId,
        invoice_hash:         newHash,
        signature:            newSig,
        updated_at:           now,
        id:                   ledgerId,
      });

      this.db.prepare(`
        INSERT INTO invoice_line_items
          (id, ledger_id, tenant_id, item_type, description, quantity,
           unit_price_usd, line_total_usd, is_credit, sort_order, created_at)
        VALUES (?, ?, ?, 'premium_discount', ?, 1, ?, ?, 1, 55, ?)
      `).run(
        crypto.randomUUID(), ledgerId, ledger.tenant_id,
        `Premium reduction token applied (${token.discount_pct}% discount)`,
        -discountUsd, discountUsd, now
      );

      this.db.prepare(
        "UPDATE premium_reduction_tokens SET status='applied', applied_to_invoice=?, applied_at=? WHERE id=?"
      ).run(ledgerId, now, tokenId);
    })();

    return this.db
      .prepare("SELECT * FROM commercial_billing_ledgers WHERE id = ?")
      .get(ledgerId) as CommercialBillingLedger;
  }

  // ── Retrieval Helpers ──────────────────────────────────────────────────────

  /** Returns all ledgers for the tenant, newest first. */
  getLedgerHistory(tenantId: string, limit = 12): CommercialBillingLedger[] {
    return this.db
      .prepare("SELECT * FROM commercial_billing_ledgers WHERE tenant_id = ? ORDER BY period_start DESC LIMIT ?")
      .all(tenantId, limit) as CommercialBillingLedger[];
  }

  /** Returns line items for a ledger, ordered by sort_order. */
  getLineItems(ledgerId: string): InvoiceLineItem[] {
    return this.db
      .prepare("SELECT * FROM invoice_line_items WHERE ledger_id = ? ORDER BY sort_order ASC")
      .all(ledgerId) as InvoiceLineItem[];
  }

  /** Returns the current underwriting registry entry for the tenant. */
  getUnderwritingRegistry(tenantId: string): InsuranceUnderwritingRegistry | null {
    return this.db
      .prepare("SELECT * FROM insurance_underwriting_registry WHERE tenant_id = ? AND status = 'active' LIMIT 1")
      .get(tenantId) as InsuranceUnderwritingRegistry | null;
  }

  /** Returns the last N audit snapshots for a registry, newest first. */
  getAuditSnapshots(registryId: string, limit = 10): UnderwritingAuditSnapshot[] {
    return this.db
      .prepare("SELECT * FROM underwriting_audit_snapshots WHERE registry_id = ? ORDER BY audited_at DESC LIMIT ?")
      .all(registryId, limit) as UnderwritingAuditSnapshot[];
  }

  /** Returns all active (issued, unexpired) tokens for the tenant. */
  getActiveTokens(tenantId: string): PremiumReductionToken[] {
    return this.db
      .prepare(`
        SELECT * FROM premium_reduction_tokens
        WHERE tenant_id = ? AND status = 'issued' AND expires_at > ?
        ORDER BY discount_pct DESC
      `)
      .all(tenantId, new Date().toISOString()) as PremiumReductionToken[];
  }

  /**
   * Registers a new insurance policy in the underwriting registry.
   * Initialises the golden thread hash with the policy seed.
   */
  registerPolicy(params: {
    tenantId:             string;
    carrierName:          string;
    carrierId:            string;
    policyNumber:         string;
    coverageType:         CoverageType;
    coverageLimitUsd:     number;
    deductibleUsd:        number;
    baseAnnualPremiumUsd: number;
    policyStartDate:      string;
    policyEndDate:        string;
    jurisdiction?:        string;
  }): InsuranceUnderwritingRegistry {
    const id  = crypto.randomUUID();
    const now = new Date().toISOString();
    const seedHash = hmac(`${id}|${params.tenantId}|${params.policyNumber}|${params.carrierName}`);

    const registry: InsuranceUnderwritingRegistry = {
      id,
      tenant_id:                   params.tenantId,
      carrier_name:                params.carrierName,
      carrier_id:                  params.carrierId,
      policy_number:               params.policyNumber,
      coverage_type:               params.coverageType,
      coverage_limit_usd:          params.coverageLimitUsd,
      deductible_usd:              params.deductibleUsd,
      base_annual_premium_usd:     params.baseAnnualPremiumUsd,
      risk_score:                  50.00,
      risk_band:                   "AMBER",
      verified_discount_pct:       null,
      effective_annual_premium_usd: params.baseAnnualPremiumUsd,
      golden_thread_hash:          seedHash,
      policy_start_date:           params.policyStartDate,
      policy_end_date:             params.policyEndDate,
      last_audit_at:               now,
      next_audit_at:               new Date(Date.now() + AUDIT_WINDOW_DAYS * 86_400_000).toISOString(),
      consecutive_clean_audits:    0,
      status:                      "active",
      jurisdiction:                params.jurisdiction ?? "GH",
      created_at:                  now,
      updated_at:                  now,
    };

    this.db.prepare(`
      INSERT INTO insurance_underwriting_registry (
        id, tenant_id, carrier_name, carrier_id, policy_number, coverage_type,
        coverage_limit_usd, deductible_usd, base_annual_premium_usd,
        risk_score, risk_band, verified_discount_pct, effective_annual_premium_usd,
        golden_thread_hash, policy_start_date, policy_end_date,
        last_audit_at, next_audit_at, consecutive_clean_audits,
        status, jurisdiction, created_at, updated_at
      ) VALUES (
        @id, @tenant_id, @carrier_name, @carrier_id, @policy_number, @coverage_type,
        @coverage_limit_usd, @deductible_usd, @base_annual_premium_usd,
        @risk_score, @risk_band, @verified_discount_pct, @effective_annual_premium_usd,
        @golden_thread_hash, @policy_start_date, @policy_end_date,
        @last_audit_at, @next_audit_at, @consecutive_clean_audits,
        @status, @jurisdiction, @created_at, @updated_at
      )
    `).run(registry);

    return registry;
  }
}
