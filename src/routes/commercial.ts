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
 *
 * Phase 15 slice 7:
 *   - 7 single-use schemas applied via validate() middleware at mount time.
 *     The 3 GETs that read only X-Tenant-ID (invoice-certificate, subscription,
 *     tokens) are out of scope — header validation lives upstream.
 *   - Schemas: InvoiceSummaryQuery, InvoiceParams, GenerateInvoiceBody,
 *     RegisterPolicyBody, UnderwritingAuditBody, CreateSubscriptionBody,
 *     ApplyTokenBody.
 *   - Slice 6g HIGH-3 fx_rate guard (with the documented
 *     `parseFloat("0") || 1.0` bug fix) is fully absorbed by
 *     `z.coerce.number().positive().finite().default(1.0)` on
 *     GenerateInvoiceBody. The legacy inline block is replaced; the
 *     bug-history rationale is preserved in the schema's doc comment so
 *     the institutional memory survives the refactor.
 *   - Local validTiers constant inside createSubscription() removed
 *     (the schema's z.enum absorbs the membership check).
 *
 * Phase 15 slice 7.5 (follow-up):
 *   - RegisterPolicyBody.coverage_type tightened from z.string().min(1)
 *     to z.enum([...]) using the literal 6-value set extracted from
 *     ../services/commercialEngine (CoverageType union at line 39 of
 *     that file). The `as CoverageType` bridge cast in registerPolicy()
 *     is removed — z.infer now produces the correct nominal type.
 *
 *     CORRECTION to a slice 7 claim: the slice 7 header said
 *     "engine.registerPolicy() still throws on unknown CoverageType
 *     values, so the contract is preserved." That was WRONG. The engine
 *     accepts the string verbatim and INSERTs it directly into the
 *     coverage_type column — there is no runtime enum check inside the
 *     engine. If the DB column lacks a CHECK constraint, slice 7
 *     accepted arbitrary garbage. Slice 7.5 closes this gap at the
 *     validation boundary.
 *
 *   - InvoiceSummaryQuery.status enum corrected from the slice 7 guess
 *     of {issued, paid, overdue, void} to match the actual LedgerStatus
 *     union from commercialEngine line 37:
 *       {draft, issued, paid, overdue, voided, disputed}
 *     Slice 7 was missing draft/disputed entirely and had "void" (the
 *     doc's guess) where the real value is "voided". This would have
 *     400'd legitimate ?status=draft and ?status=disputed requests in
 *     production. Pure regression fix.
 *
 *   - SYMMETRIC CLEANUP (not in original slice 7.5 scope but applied for
 *     consistency): the equivalent `body.tier as SubscriptionTier` bridge
 *     cast in createSubscription() is also dropped, since the schema's
 *     z.enum(["PAY_AS_YOU_GO", ...]) already produces the exact
 *     SubscriptionTier union the engine declares. The type-only imports
 *     of `SubscriptionTier` and `CoverageType` from commercialEngine are
 *     no longer referenced anywhere in this file and have been removed.
 *     Behavior unchanged; this is a TypeScript-only tidy.
 *
 * BEHAVIOR CHANGES from slice 7 (intentional — see enumeration doc):
 *   - GET /invoice-summary  limit/offset garbage strings  was parseInt→NaN
 *     used unchecked in SQL (empty result or error) → now 400.
 *   - GET /invoice-summary  status=<unknown>  previously hit the DB with
 *     the bad value (returning empty result) → now 400. The status enum
 *     is the full LedgerStatus union {draft, issued, paid, overdue,
 *     voided, disputed} (corrected in slice 7.5 from the slice 7 guess).
 *   - GET /invoice/:id  id=<non-uuid>  previously hit the DB (404 on miss)
 *     → now 400. Same caveat as elsewhere; update fixtures if needed.
 *   - POST /invoice/generate  invoice_currency=<not 3 chars>  was accepted
 *     → now 400 (.length(3) for ISO 4217). ⚠ FLAGGED: if any fixture uses
 *     "USDC" (4 chars, stablecoin) or similar, switch to z.string().min(1).
 *   - POST /insurance/register  coverage_limit_usd=0  was rejected (falsy
 *     check) → still rejected, now via .positive(). Same for
 *     base_annual_premium_usd. ⚠ DELIBERATE TIGHTENING: deductible_usd=0
 *     was rejected by the falsy check → now ACCEPTED via .nonnegative().
 *     A zero-deductible policy is legitimate; this is an intentional fix.
 *   - POST /insurance/register  policy_start_date / policy_end_date  must
 *     match /^\d{4}-\d{2}-\d{2}$/ → was any string. Engine-level date
 *     range validation (cross-field) stays inline / in the engine.
 *   - POST /insurance/audit  registry_id=<non-uuid>  → now 400.
 *   - POST /subscription/create  invoice_currency=<not 3 chars>  → 400
 *     (same caveat as generateInvoice).
 *   - POST /token/apply  ledger_id or token_id non-uuid  → now 400.
 *   - All bodies: unknown fields silently ignored → now 400 (.strict()).
 *
 * NO BEHAVIOR CHANGES for:
 *   - X-Tenant-ID header parsing via getTenantId() (throws 400 if missing;
 *     schemas do not cover headers per the slice 7 convention).
 *   - requireRole() role enforcement (still 403 with required/actual).
 *   - HMAC tamper-evidence on invoices / certificates (Slice 6b origin;
 *     still computed via loadHmacSecret + crypto.createHmac).
 *   - Slice 6b.4 audit log on policy registration (commercialAuditLog
 *     called outside the engine's transaction — same residual atomicity
 *     gap as before, documented in the call site comment).
 *   - Slice 6b.5 audit log on token application.
 *   - Ledger-belongs-to-tenant 403 on /token/apply (semantic, retained).
 *   - The 4-band insurance certificate response shape, golden thread
 *     integrity check, days-to-expiry/audit math.
 *   - Engine-level cross-field validation on RegisterPolicyBody (date
 *     range, policy_number uniqueness) and CreateSubscriptionBody
 *     (CUSTOM tier with no custom_* fields — flagged as a future
 *     hardening per Appendix C, NOT applied in slice 7).
 *
 * Pre-merge checks the implementation session should run:
 *   - npm test (all 143 existing tests must stay green)
 *   - grep -r validTiers src/ — must return no matches (the constant
 *     was function-local to createSubscription)
 *   - Verify test fixtures: any invoice_currency value should be 3 chars;
 *     any UUID field (id, ledger_id, token_id, registry_id) should be
 *     a real UUID; any policy_start_date / policy_end_date should match
 *     YYYY-MM-DD form.
 *   - ⚠ NEW IN SLICE 7.5: any /invoice-summary test that sends
 *     ?status=void will now 400 — the real value is "voided". Update
 *     fixtures. Any /insurance/register test that sends a coverage_type
 *     outside the 6-value CoverageType union will now 400 — verify
 *     fixtures use one of: cyber_liability, professional_indemnity,
 *     fintech_comprehensive, data_breach, operational_risk,
 *     regulatory_defence.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { requireAccessToken }  from "./auth";
import { validate } from "../middleware/validate";
import { CommercialEngine, loadHmacSecret } from "../services/commercialEngine";
import type { CaaSRole } from "./auth";
import { commercialAuditLog } from "../lib/audit";

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Query schema for GET /invoice-summary.
 *
 * - limit: int 1..50, default 12. Matches the legacy `Math.min(parseInt(...), 50)`
 *   clamping but now rejects garbage instead of producing NaN.
 * - offset: int >= 0, default 0.
 * - status: full LedgerStatus union from commercialEngine.ts line 37
 *   {draft, issued, paid, overdue, voided, disputed}. SLICE 7.5
 *   CORRECTION: slice 7 inferred {issued, paid, overdue, void} from the
 *   SUM CASE clauses in the aggregates query — but those clauses are
 *   computed values, not the column's valid range. The actual column
 *   constraint is wider AND has "voided" (not "void"). Slice 7 would
 *   have 400'd legitimate ?status=draft and ?status=disputed requests.
 *   This is a regression fix; ensure no fixtures send ?status=void
 *   (the misspelling) — they need to be updated to "voided".
 */
const InvoiceSummaryQuery = z.object({
  limit:  z.coerce.number().int().min(1).max(50).default(12),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["draft", "issued", "paid", "overdue", "voided", "disputed"]).optional(),
}).strict();

/**
 * Params schema for GET /invoice/:id.
 *
 * commercial_billing_ledgers.id is assumed UUID per the codebase convention.
 * If the column is something else (auto-incr int, invoice-number string),
 * loosen here and in the enumeration doc's Appendix A.
 */
const InvoiceParams = z.object({
  id: z.string().uuid(),
}).strict();

/**
 * Body schema for POST /invoice/generate.
 *
 * Slice 6g HIGH-3 history (preserved for institutional memory):
 *   The previous handler used `parseFloat(fxRateRaw) || 1.0`, which had
 *   two bugs:
 *     1. parseFloat("0") || 1.0 evaluates to 1.0 because 0 is falsy.
 *        A legitimate zero-rate input would be silently overwritten.
 *     2. Negative rates and NaN passed through silently when paired with
 *        the OR fallback that only catches NaN. We never want a negative
 *        multiplier on an invoice — it would flip totals to refunds.
 *
 *   The slice 6g fix introduced an explicit NaN + positivity check
 *   returning 400 on bad input, defaulting only when fx_rate was omitted.
 *   This schema captures BOTH guarantees in one expression:
 *     - .positive()  rejects 0 and negatives (fixes bug 1 and bug 2)
 *     - .finite()    rejects NaN and ±Infinity (fixes bug 2)
 *     - .default(1.0) handles the documented optional case
 *   z.coerce.number() handles both string-encoded ("1.05") and numeric
 *   (1.05) JSON inputs, matching the legacy parseFloat behavior.
 *
 * invoice_currency: BEHAVIOR CHANGE — was any string, now must be exactly
 *   3 characters (ISO 4217). If a fixture uses "USDC" or similar, loosen
 *   to z.string().min(1).default("USD"). The default of "USD" matches
 *   the legacy `?? "USD"` fallback.
 */
const GenerateInvoiceBody = z.object({
  fx_rate:          z.coerce.number().positive().finite().default(1.0),
  invoice_currency: z.string().length(3).default("USD"),
}).strict();

/**
 * Body schema for POST /insurance/register.
 *
 * SLICE 7.5: coverage_type is now z.enum(...) with the literal 6-value
 * CoverageType union extracted from commercialEngine.ts line 39. Slice 7
 * left this as z.string().min(1) because commercialEngine.ts wasn't
 * available to inspect; that gap is now closed.
 *
 * IMPORTANT — engine does NOT validate coverageType at runtime:
 *   CommercialEngine.registerPolicy accepts the string verbatim and
 *   INSERTs it into the coverage_type column without any enum check.
 *   The TypeScript `CoverageType` parameter type is enforced only at
 *   compile time. This schema is therefore the ONLY runtime gate on
 *   coverage_type validity in the request path. Do not loosen it
 *   without also adding an engine-level check, or the column will
 *   accept arbitrary strings.
 *
 * BEHAVIOR CHANGES:
 *   - coverage_limit_usd / base_annual_premium_usd: .positive() preserves
 *     the legacy falsy-check rejection of 0 explicitly.
 *   - deductible_usd: .nonnegative() now accepts 0 (was rejected by the
 *     falsy check). Intentional fix — a zero-deductible policy is
 *     legitimate. Flagged in the header block.
 *   - policy_start_date / policy_end_date: must match YYYY-MM-DD form.
 *     The legacy handler accepted any string and passed it through to
 *     the engine, which would likely fail downstream. Engine-level
 *     cross-field date range validation (start < end) stays in the engine.
 *   - SLICE 7.5: coverage_type must be one of the 6 CoverageType union
 *     values. Slice 7 accepted any non-empty string; slice 7.5 closes
 *     this to the literal set.
 */
const RegisterPolicyBody = z.object({
  carrier_name:            z.string().min(1),
  carrier_id:              z.string().min(1),
  policy_number:           z.string().min(1),
  coverage_type:           z.enum([
    "cyber_liability",
    "professional_indemnity",
    "fintech_comprehensive",
    "data_breach",
    "operational_risk",
    "regulatory_defence",
  ]),
  coverage_limit_usd:      z.coerce.number().positive().finite(),
  deductible_usd:          z.coerce.number().nonnegative().finite(),
  base_annual_premium_usd: z.coerce.number().positive().finite(),
  policy_start_date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  policy_end_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  jurisdiction:            z.string().min(1).optional(),
}).strict();

/**
 * Body schema for POST /insurance/audit.
 *
 * registry_id is assumed UUID per the codebase convention. The legacy
 * handler used `String(... ?? "")` then a non-empty check, which would
 * have accepted any non-empty string and 404'd at the engine call.
 */
const UnderwritingAuditBody = z.object({
  registry_id: z.string().uuid(),
}).strict();

/**
 * Body schema for POST /subscription/create.
 *
 * - tier: z.enum absorbs the legacy `validTiers.includes(body.tier)` check.
 *   The local validTiers constant has been removed from createSubscription().
 * - invoice_currency: same length-3 caveat as GenerateInvoiceBody.
 * - All custom_* fields: optional non-negative finite numbers; the int
 *   fields (custom_runs, custom_monitors) use .int() because they're
 *   counts.
 *
 * NOT enforced (intentionally — possible future hardening per Appendix C):
 *   - When tier === "CUSTOM", at least one custom_* field. The current
 *     handler passes undefined to the engine for missing values; schema
 *     matches that. If business logic later requires CUSTOM to have at
 *     least one custom field, add a .refine() here.
 */
const CreateSubscriptionBody = z.object({
  tier:                   z.enum(["PAY_AS_YOU_GO", "GROWTH", "ENTERPRISE", "CUSTOM"]),
  billing_cycle:          z.enum(["monthly", "quarterly", "annual"]).optional(),
  invoice_currency:       z.string().length(3).optional(),
  contract_ref:           z.string().min(1).optional(),
  custom_fee:             z.coerce.number().nonnegative().finite().optional(),
  custom_runs:            z.coerce.number().int().nonnegative().optional(),
  custom_monitors:        z.coerce.number().int().nonnegative().optional(),
  custom_overage_rate:    z.coerce.number().nonnegative().finite().optional(),
  custom_monitor_overage: z.coerce.number().nonnegative().finite().optional(),
}).strict();

/**
 * Body schema for POST /token/apply.
 *
 * Both IDs are assumed UUID. The ledger-belongs-to-tenant 403 check
 * downstream is RETAINED — schema only validates shape, not authorization.
 */
const ApplyTokenBody = z.object({
  ledger_id: z.string().uuid(),
  token_id:  z.string().uuid(),
}).strict();

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

/**
 * Reads the authenticated user's id off the request. requireAccessToken
 * middleware sets req.caasUserId from the JWT sub claim. Returns null
 * (not "system") so commercial_audit_log.actor_user_id is recorded NULL
 * if the caller is somehow unauthenticated — matches the column's
 * nullable semantics for system-triggered events.
 */
function getActorId(req: Request): string | null {
  return (req as Request & { caasUserId?: string }).caasUserId ?? null;
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
 *
 * After validate({ query: InvoiceSummaryQuery }):
 *   - limit is a clamped int (1..50) with default 12
 *   - offset is a non-negative int with default 0
 *   - status, if present, is one of {issued, paid, overdue, void}
 *   - The legacy parseInt+Math.min logic is absorbed; garbage 400s now.
 */
async function getInvoiceSummary(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const engine   = getEngine(req);
  const db       = getDb(req);

  const { limit, offset, status } =
    req.query as unknown as z.infer<typeof InvoiceSummaryQuery>;

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
      const HMAC_SECRET = loadHmacSecret();
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
 *
 * After validate({ params: InvoiceParams }), req.params.id is a validated
 * UUID string.
 */
async function getInvoice(req: Request, res: Response): Promise<void> {
  const tenantId  = getTenantId(req);
  const db        = getDb(req);
  const engine    = getEngine(req);
  const { id: ledgerId } = req.params as z.infer<typeof InvoiceParams>;

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
 *
 * After validate({ body: GenerateInvoiceBody }):
 *   - fx_rate is a positive finite number with default 1.0 (Slice 6g HIGH-3
 *     guarantee preserved — see schema comment for the bug history).
 *   - invoice_currency is a 3-char ISO 4217 code with default "USD".
 *   - The legacy inline parseFloat + NaN/positivity guard block is gone;
 *     the schema captures the same invariants in one expression.
 */
async function generateInvoice(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const engine   = getEngine(req);

  const { fx_rate: fxRate, invoice_currency: invoiceCurrency } =
    req.body as z.infer<typeof GenerateInvoiceBody>;

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
  const HMAC_SECRET = loadHmacSecret();
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
 *
 * After validate({ body: RegisterPolicyBody }):
 *   - All 9 required fields are present and well-typed.
 *   - Numeric fields are coerced and constrained (.positive() on
 *     premium/limit, .nonnegative() on deductible).
 *   - Date fields match YYYY-MM-DD form.
 *   - coverage_type is one of the 6 CoverageType union values (slice 7.5).
 *   - The legacy `for (const field of required) { if (!body[field]) ... }`
 *     loop is absorbed; the local `required` const has been removed.
 */
async function registerPolicy(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const engine   = getEngine(req);

  // body.coverage_type is now a CoverageType-shaped literal (z.enum from
  // the schema produces the exact union the engine declares), so no
  // bridge cast is needed at the engine call site.
  const body = req.body as z.infer<typeof RegisterPolicyBody>;

  const registry = engine.registerPolicy({
    tenantId,
    carrierName:          body.carrier_name,
    carrierId:            body.carrier_id,
    policyNumber:         body.policy_number,
    coverageType:         body.coverage_type,
    coverageLimitUsd:     body.coverage_limit_usd,
    deductibleUsd:        body.deductible_usd,
    baseAnnualPremiumUsd: body.base_annual_premium_usd,
    policyStartDate:      body.policy_start_date,
    policyEndDate:        body.policy_end_date,
    jurisdiction:         body.jurisdiction,
  });

  // Slice 6b.4: audit policy registration. CommercialEngine.registerPolicy
  // writes the insurance_underwriting_registry row but not commercial_audit_log
  // — the engine uses HMAC tamper-evidence on the registry row itself for
  // integrity. That covers state integrity but not actor attribution.
  // This audit row closes the actor-attribution gap.
  // NOTE: not inside the engine's transaction — same residual atomicity
  // gap as regulatoryIngest /onboard. Acceptable: registration is rare,
  // and the audit failure window is microseconds.
  commercialAuditLog(
    getDb(req), tenantId, getActorId(req),
    "insurance_policy", String(registry.id),
    "register",
    null,
    JSON.stringify({
      carrier_id:    body.carrier_id,
      policy_number: body.policy_number,
      coverage_type: body.coverage_type,
      risk_band:     registry.risk_band,
    }),
    {
      coverage_limit_usd:       body.coverage_limit_usd,
      base_annual_premium_usd:  body.base_annual_premium_usd,
      policy_start_date:        body.policy_start_date,
      policy_end_date:          body.policy_end_date,
    }
  );

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
 *
 * After validate({ body: UnderwritingAuditBody }), registry_id is a
 * validated UUID string. The legacy String(... ?? "") + non-empty check
 * is absorbed.
 */
async function triggerUnderwritingAudit(req: Request, res: Response): Promise<void> {
  const tenantId  = getTenantId(req);
  const engine    = getEngine(req);
  const { registry_id: registryId } = req.body as z.infer<typeof UnderwritingAuditBody>;

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
 *
 * After validate({ body: CreateSubscriptionBody }):
 *   - tier is a validated SubscriptionTier enum value.
 *   - All optional custom_* fields are coerced numbers with sane
 *     constraints. The legacy `Number(body.custom_fee)` etc. casts at
 *     the engine call site are redundant — the schema has already
 *     produced numbers via z.coerce.number().
 *   - The local validTiers constant has been removed.
 */
async function createSubscription(req: Request, res: Response): Promise<void> {
  const tenantId = getTenantId(req);
  const engine   = getEngine(req);

  const body = req.body as z.infer<typeof CreateSubscriptionBody>;

  const sub = engine.createSubscription({
    tenantId,
    tier:                 body.tier,
    billingCycle:         body.billing_cycle,
    contractRef:          body.contract_ref,
    invoiceCurrency:      body.invoice_currency,
    customFee:            body.custom_fee,
    customRuns:           body.custom_runs,
    customMonitors:       body.custom_monitors,
    customOverageRate:    body.custom_overage_rate,
    customMonitorOverage: body.custom_monitor_overage,
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
 *
 * After validate({ body: ApplyTokenBody }), both IDs are validated UUIDs.
 * The legacy two presence guards are absorbed. The ledger-belongs-to-tenant
 * 403 check stays inline — semantic authorization, not shape.
 */
async function applyToken(req: Request, res: Response): Promise<void> {
  const engine   = getEngine(req);
  const tenantId = getTenantId(req);

  const { ledger_id, token_id } = req.body as z.infer<typeof ApplyTokenBody>;

  // Verify ledger belongs to this tenant
  const ledger = getDb(req)
    .prepare("SELECT tenant_id FROM commercial_billing_ledgers WHERE id = ?")
    .get(ledger_id) as { tenant_id: string } | undefined;

  if (!ledger) { res.status(404).json({ error: "Invoice not found" }); return; }
  if (ledger.tenant_id !== tenantId) { res.status(403).json({ error: "Invoice belongs to different tenant" }); return; }

  const updated = engine.applyPremiumReductionToken(ledger_id, token_id);

  // Slice 6b.5: audit token application. Token redemption changes an
  // invoice's total — without this, "who applied which discount and when"
  // is invisible. The engine's HMAC tamper-evidence on the ledger row
  // proves no row was edited outside the engine, but doesn't say WHO.
  commercialAuditLog(
    getDb(req), tenantId, getActorId(req),
    "premium_reduction_token", token_id,
    "apply",
    null,
    JSON.stringify({
      ledger_id,
      invoice_number: updated.invoice_number,
      new_total_usd:  updated.total_usd,
      discount_usd:   updated.premium_discount_usd,
    }),
    { invoice_id: updated.id }
  );

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

  // Each schema is single-use — no Appendix B reuse for commercial routes.
  // validate() is composed at mount time per-route. The ordering pattern
  // across slice 7 is: requireAccessToken (router-level) → requireRole →
  // validate → async_(handler). requireRole runs before validate so an
  // insufficient-role caller gets 403 instead of 400, mirroring the
  // requireBusinessPlane → validate ordering in provisioning.ts.

  // Invoice routes — Executive only
  router.get("/invoice-summary",      requireRole("Executive"),             validate({ query: InvoiceSummaryQuery }), async_(getInvoiceSummary));
  router.get("/invoice/:id",          requireRole("Executive"),             validate({ params: InvoiceParams }),      async_(getInvoice));
  router.post("/invoice/generate",    requireRole("Executive"),             validate({ body: GenerateInvoiceBody }),  async_(generateInvoice));

  // Insurance routes
  router.get("/insurance-certificate", requireRole("Executive", "Auditor"),                                           async_(getInsuranceCertificate));
  router.post("/insurance/register",  requireRole("Executive"),             validate({ body: RegisterPolicyBody }),   async_(registerPolicy));
  router.post("/insurance/audit",     requireRole("Executive"),             validate({ body: UnderwritingAuditBody }), async_(triggerUnderwritingAudit));

  // Subscription routes
  router.get("/subscription",         requireRole("Executive", "Auditor"),                                            async_(getSubscription));
  router.post("/subscription/create", requireRole("Executive"),             validate({ body: CreateSubscriptionBody }), async_(createSubscription));

  // Token routes
  router.post("/token/apply",         requireRole("Executive"),             validate({ body: ApplyTokenBody }),       async_(applyToken));
  router.get("/tokens",               requireRole("Executive", "Auditor"),                                            async_(getTokens));

  return router;
}

// Exported for tests that want to assert the schemas directly without
// constructing an Express request.
export {
  InvoiceSummaryQuery,
  InvoiceParams,
  GenerateInvoiceBody,
  RegisterPolicyBody,
  UnderwritingAuditBody,
  CreateSubscriptionBody,
  ApplyTokenBody,
};

export default createCommercialRouter;
