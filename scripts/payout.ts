/**
 * src/services/payout.ts
 * Idempotent MoMo / Card sweep automation with HMAC transaction-signature locks.
 *
 * Settlement currency : USD (internal platform)
 * Disbursement currency: local currency of the agent's country, converted at
 *                        prevailing market rates via src/services/fx.ts.
 * Country requirements : per-country method support, KYC tiers, withholding
 *                        tax, and regulatory reporting enforced via
 *                        src/config/countryRequirements.ts.
 *
 * Commit baseline: a4f5db6  |  Phase 9 build-out
 */

import crypto from "crypto";
import type { Database as DB, Statement } from "better-sqlite3";
import { convertUsd } from "./fx";
import type { FxConversion } from "./fx";
import {
  getCountryRequirement,
  getMethodConfig,
  getBreachedThresholds,
  meetsKycRequirement,
} from "../config/countryRequirements";
import type { KycTier } from "../config/countryRequirements";

// ─── Types ────────────────────────────────────────────────────────────────────

export type PayoutMethod = "momo" | "card";

export type PayoutStatus =
  | "pending"
  | "processing"
  | "success"
  | "failed"
  | "duplicate";

export interface AgentPayoutRecord {
  id: string;
  tenant_id: string;
  name: string;
  /** Platform settlement balance in USD. */
  balance_usd: number;
  payout_method: PayoutMethod;
  card_token: string | null;
  /** Minimum USD balance required before a payout is triggered. */
  payout_threshold_usd: number;
  locked: 0 | 1;
  momo_number: string | null;
  momo_provider: string | null;
  /** ISO 3166-1 alpha-2 — drives local currency and all compliance rules. */
  country_code: string;
  /** Agent's verified KYC tier. */
  kyc_tier: KycTier;
}

export interface PayoutLogRow {
  id: string;
  agent_id: string;
  tenant_id: string;
  /** USD amount disbursed (platform settlement currency). */
  amount_usd: number;
  /** Net amount credited to the agent in local currency after withholding tax. */
  local_amount: number;
  /** ISO 4217 local currency code. */
  local_currency: string;
  /** Mid-market rate applied (1 USD = fx_mid_rate local units). */
  fx_mid_rate: number;
  /** Effective rate after platform spread. */
  fx_effective_rate: number;
  /** FK → fx_rate_cache.rate_id for full audit trail. */
  fx_rate_id: string;
  method: PayoutMethod;
  idempotency_key: string;
  signature: string;
  status: PayoutStatus;
  provider_reference: string | null;
  failure_reason: string | null;
  /** Withholding tax amount deducted in local currency. */
  withholding_tax_local: number;
  /** Whether a regulatory report has been filed for this payout. */
  regulatory_report_filed: 0 | 1;
  created_at: string;
  settled_at: string | null;
}

export interface PayoutResult {
  idempotency_key: string;
  agent_id: string;
  status: PayoutStatus;
  amount_usd: number;
  local_amount: number;
  local_currency: string;
  fx_mid_rate: number;
  fx_effective_rate: number;
  withholding_tax_local: number;
  provider_reference: string | null;
  failure_reason: string | null;
}

export interface SweepSummary {
  tenant_id: string;
  swept_at: string;
  total_agents_evaluated: number;
  total_initiated: number;
  total_duplicates: number;
  total_failed: number;
  total_amount_usd: number;
  results: PayoutResult[];
}

// ─── Configuration ─────────────────────────────────────────────────────────────

const HMAC_SECRET = process.env.PAYOUT_HMAC_SECRET ?? (() => {
  throw new Error("PAYOUT_HMAC_SECRET environment variable is not set");
})();

const MOMO_API_BASE =
  process.env.MOMO_API_BASE ?? "https://sandbox.momodeveloper.mtn.com";
const MOMO_SUBSCRIPTION_KEY = process.env.MOMO_SUBSCRIPTION_KEY ?? "";
const MOMO_API_USER        = process.env.MOMO_API_USER        ?? "";
const MOMO_API_KEY_SECRET  = process.env.MOMO_API_KEY_SECRET  ?? "";
const MOMO_TARGET_ENV      = process.env.MOMO_TARGET_ENV      ?? "sandbox";

const CARD_GATEWAY_BASE   = process.env.CARD_GATEWAY_BASE   ?? "https://api.stripe.com";
const CARD_GATEWAY_SECRET = process.env.CARD_GATEWAY_SECRET ?? "";

const REGULATORY_REPORT_WEBHOOK = process.env.REGULATORY_REPORT_WEBHOOK ?? "";

/** Reserve fraction retained in agent accounts per compliance policy (15 %). */
const RESERVE_FRACTION = 0.15;

/** Global USD hard cap — amounts above this require manual approval. */
const SWEEP_HARD_CAP_USD = 50_000;

/**
 * Zero-decimal currencies: amounts sent to gateways must be whole integers.
 * Three-decimal currencies: multiply by 1 000 for gateway sub-unit encoding.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF","CLP","DJF","GNF","ISK","JPY","KMF","KRW","MGA",
  "PYG","RWF","UGX","VND","VUV","XAF","XOF","XPF",
]);
const THREE_DECIMAL_CURRENCIES = new Set([
  "BHD","IQD","JOD","KWD","LYD","MRU","OMR","TND",
]);

function toSubunit(amount: number, currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return Math.round(amount);
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return Math.round(amount * 1_000);
  return Math.round(amount * 100);
}

// ─── HMAC Signature Utilities ─────────────────────────────────────────────────

/**
 * Deterministic HMAC-SHA256 idempotency key.
 * country_code is included so that a re-keyed agent gets a fresh key.
 */
export function deriveIdempotencyKey(
  agentId: string,
  amountUsd: number,
  method: PayoutMethod,
  countryCode: string,
  bucketDate: Date = new Date()
): string {
  const bucket  = bucketDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const payload = `${agentId}:${amountUsd.toFixed(2)}:${method}:${countryCode}:${bucket}`;
  return crypto.createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
}

/**
 * Signs a payout log row.
 * FX fields are included so post-hoc rate manipulation is detectable.
 */
export function signPayoutEntry(
  idempotencyKey: string,
  agentId: string,
  amountUsd: number,
  localAmount: number,
  localCurrency: string,
  fxEffectiveRate: number,
  status: PayoutStatus,
  createdAt: string
): string {
  const payload = [
    idempotencyKey, agentId,
    amountUsd.toFixed(2), localAmount.toFixed(6),
    localCurrency, fxEffectiveRate.toFixed(6),
    status, createdAt,
  ].join("|");
  return crypto.createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
}

/** Constant-time comparison to prevent timing attacks on HMAC verification. */
export function verifyPayoutSignature(
  entry: Pick<
    PayoutLogRow,
    | "idempotency_key" | "agent_id" | "amount_usd" | "local_amount"
    | "local_currency" | "fx_effective_rate" | "status" | "created_at" | "signature"
  >
): boolean {
  const expected = signPayoutEntry(
    entry.idempotency_key, entry.agent_id, entry.amount_usd,
    entry.local_amount, entry.local_currency, entry.fx_effective_rate,
    entry.status, entry.created_at
  );
  try {
    return crypto.timingSafeEqual(
      Buffer.from(entry.signature, "hex"),
      Buffer.from(expected, "hex")
    );
  } catch {
    return false;
  }
}

// ─── Regulatory Reporting ─────────────────────────────────────────────────────

async function fileRegulatoryReports(
  payoutLogId: string,
  agentId: string,
  tenantId: string,
  countryCode: string,
  localAmount: number,
  localCurrency: string,
  amountUsd: number,
  createdAt: string
): Promise<void> {
  const breached = getBreachedThresholds(countryCode, localAmount);
  if (breached.length === 0) return;

  for (const threshold of breached) {
    const report = {
      report_type: "regulatory_threshold_breach",
      payout_log_id: payoutLogId,
      agent_id: agentId,
      tenant_id: tenantId,
      country_code: countryCode,
      local_amount: localAmount,
      local_currency: localCurrency,
      amount_usd: amountUsd,
      threshold_local: threshold.amount_local,
      authority: threshold.authority,
      legal_ref: threshold.legal_ref,
      must_file_by: new Date(
        new Date(createdAt).getTime() + threshold.report_within_hours * 3_600_000
      ).toISOString(),
      generated_at: createdAt,
      signature: crypto
        .createHmac("sha256", HMAC_SECRET)
        .update(`${payoutLogId}:${threshold.authority}:${localAmount}`)
        .digest("hex"),
    };

    if (REGULATORY_REPORT_WEBHOOK) {
      fetch(REGULATORY_REPORT_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(report),
      }).catch((err) =>
        console.error(`[payout] Regulatory report webhook error: ${err}`)
      );
    } else {
      console.warn("[payout][regulatory_report]", JSON.stringify(report));
    }
  }
}

// ─── MoMo API Client ──────────────────────────────────────────────────────────

interface MoMoTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface MoMoTransferResponse {
  referenceId: string;
  status: "SUCCESSFUL" | "FAILED" | "PENDING";
  reason?: string;
}

async function fetchMoMoAccessToken(): Promise<string> {
  const credentials = Buffer.from(
    `${MOMO_API_USER}:${MOMO_API_KEY_SECRET}`
  ).toString("base64");
  const res = await fetch(`${MOMO_API_BASE}/disbursement/token/`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Ocp-Apim-Subscription-Key": MOMO_SUBSCRIPTION_KEY,
      "X-Target-Environment": MOMO_TARGET_ENV,
    },
  });
  if (!res.ok)
    throw new Error(`MoMo token [${res.status}]: ${await res.text()}`);
  return ((await res.json()) as MoMoTokenResponse).access_token;
}

async function initiateMoMoTransfer(
  accessToken: string,
  referenceId: string,
  localAmount: number,
  localCurrency: string,
  momoNumber: string,
  agentName: string,
  idempotencyKey: string
): Promise<void> {
  const res = await fetch(`${MOMO_API_BASE}/disbursement/v1_0/transfer`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Ocp-Apim-Subscription-Key": MOMO_SUBSCRIPTION_KEY,
      "X-Target-Environment": MOMO_TARGET_ENV,
      "X-Reference-Id": referenceId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: localAmount.toFixed(2),
      currency: localCurrency,
      externalId: idempotencyKey,
      payee: { partyIdType: "MSISDN", partyId: momoNumber },
      payerMessage: "CaaS agent payout",
      payeeNote: `Payout for ${agentName}`,
    }),
  });
  if (res.status !== 202)
    throw new Error(
      `MoMo transfer initiation [${res.status}]: ${await res.text()}`
    );
}

async function pollMoMoTransferStatus(
  accessToken: string,
  referenceId: string,
  maxAttempts = 6,
  intervalMs = 5_000
): Promise<MoMoTransferResponse> {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(
      `${MOMO_API_BASE}/disbursement/v1_0/transfer/${referenceId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Ocp-Apim-Subscription-Key": MOMO_SUBSCRIPTION_KEY,
          "X-Target-Environment": MOMO_TARGET_ENV,
        },
      }
    );
    if (!res.ok)
      throw new Error(`MoMo poll [${res.status}]: ${await res.text()}`);
    const data = (await res.json()) as MoMoTransferResponse;
    if (data.status === "SUCCESSFUL" || data.status === "FAILED") return data;
    if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { referenceId, status: "PENDING" };
}

// ─── Card Gateway Client (Stripe) ─────────────────────────────────────────────

async function initiateCardTransfer(
  cardToken: string,
  localAmountSubunit: number,
  localCurrency: string,
  idempotencyKey: string,
  agentName: string
): Promise<{ providerReference: string }> {
  // Step 1 — create or resolve external account recipient.
  const recipientRes = await fetch(`${CARD_GATEWAY_BASE}/v1/recipients`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CARD_GATEWAY_SECRET}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": `rcpt-${idempotencyKey}`,
    },
    body: new URLSearchParams({
      type: "card",
      card: cardToken,
      email: `${agentName.toLowerCase().replace(/\s+/g, ".")}@caas.agent`,
      currency: localCurrency.toLowerCase(),
    }).toString(),
  });
  if (!recipientRes.ok)
    throw new Error(
      `Card recipient [${recipientRes.status}]: ${await recipientRes.text()}`
    );
  const recipient = (await recipientRes.json()) as { id: string };

  // Step 2 — initiate payout in local currency.
  const payoutRes = await fetch(`${CARD_GATEWAY_BASE}/v1/payouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CARD_GATEWAY_SECRET}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Idempotency-Key": idempotencyKey,
    },
    body: new URLSearchParams({
      amount: localAmountSubunit.toString(),
      currency: localCurrency.toLowerCase(),
      recipient: recipient.id,
      statement_descriptor: "CAAS PAYOUT",
    }).toString(),
  });
  if (!payoutRes.ok)
    throw new Error(
      `Card payout [${payoutRes.status}]: ${await payoutRes.text()}`
    );
  const payout = (await payoutRes.json()) as { id: string };
  return { providerReference: payout.id };
}

// ─── Database Helpers ─────────────────────────────────────────────────────────

interface PreparedStatements {
  findEligibleAgents: Statement;
  findExistingLog: Statement;
  insertLog: Statement;
  updateLogStatus: Statement;
  debitAgentBalance: Statement;
  restoreAgentBalance: Statement;
  markRegulatoryReportFiled: Statement;
}

function prepareStatements(db: DB): PreparedStatements {
  return {
    findEligibleAgents: db.prepare(`
      SELECT id, tenant_id, name,
             balance_usd, payout_method, card_token, payout_threshold_usd,
             locked, momo_number, momo_provider, country_code, kyc_tier
      FROM agents
      WHERE tenant_id = ?
        AND locked = 0
        AND balance_usd >= payout_threshold_usd
        AND payout_method IS NOT NULL
        AND country_code IS NOT NULL
    `),

    findExistingLog: db.prepare(`
      SELECT id, status, provider_reference, local_amount, local_currency,
             fx_mid_rate, fx_effective_rate, withholding_tax_local
      FROM payout_logs
      WHERE idempotency_key = ?
      LIMIT 1
    `),

    insertLog: db.prepare(`
      INSERT INTO payout_logs
        (id, agent_id, tenant_id, amount_usd, local_amount, local_currency,
         fx_mid_rate, fx_effective_rate, fx_rate_id, method,
         idempotency_key, signature, status, provider_reference, failure_reason,
         withholding_tax_local, regulatory_report_filed, created_at, settled_at)
      VALUES
        (@id, @agent_id, @tenant_id, @amount_usd, @local_amount, @local_currency,
         @fx_mid_rate, @fx_effective_rate, @fx_rate_id, @method,
         @idempotency_key, @signature, @status, @provider_reference, @failure_reason,
         @withholding_tax_local, 0, @created_at, @settled_at)
    `),

    updateLogStatus: db.prepare(`
      UPDATE payout_logs
      SET status             = @status,
          provider_reference = @provider_reference,
          failure_reason     = @failure_reason,
          settled_at         = @settled_at
      WHERE idempotency_key  = @idempotency_key
    `),

    debitAgentBalance: db.prepare(`
      UPDATE agents
      SET balance_usd = balance_usd - @amount
      WHERE id = @agent_id AND balance_usd >= @amount
    `),

    restoreAgentBalance: db.prepare(`
      UPDATE agents
      SET balance_usd = balance_usd + @amount
      WHERE id = @agent_id
    `),

    markRegulatoryReportFiled: db.prepare(`
      UPDATE payout_logs SET regulatory_report_filed = 1 WHERE id = @id
    `),
  };
}

// ─── Internal Failure Factory ─────────────────────────────────────────────────

function failResult(
  agent: AgentPayoutRecord,
  amountUsd: number,
  localCurrency: string,
  fxMidRate: number,
  fxEffectiveRate: number,
  withholdingTaxLocal: number,
  reason: string
): PayoutResult {
  return {
    idempotency_key: "",
    agent_id: agent.id,
    status: "failed",
    amount_usd: amountUsd,
    local_amount: 0,
    local_currency: localCurrency,
    fx_mid_rate: fxMidRate,
    fx_effective_rate: fxEffectiveRate,
    withholding_tax_local: withholdingTaxLocal,
    provider_reference: null,
    failure_reason: reason,
  };
}

// ─── Core Sweep Logic ─────────────────────────────────────────────────────────

async function processAgentPayout(
  agent: AgentPayoutRecord,
  stmts: PreparedStatements,
  db: DB,
  sweepDate: Date
): Promise<PayoutResult> {

  // ── Step 1: Resolve country requirements ──
  let countryReq: ReturnType<typeof getCountryRequirement>;
  try {
    countryReq = getCountryRequirement(agent.country_code);
  } catch (err) {
    return failResult(agent, 0, "USD", 0, 1, 0,
      `Unsupported country: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Step 2: KYC tier gate ──
  if (!meetsKycRequirement(agent.kyc_tier, agent.country_code)) {
    return failResult(agent, 0, countryReq.local_currency, 0, 1, 0,
      `Agent KYC tier "${agent.kyc_tier}" does not meet the ` +
      `"${countryReq.min_kyc_tier}" requirement for ${countryReq.country_name}`);
  }

  // ── Step 3: Method availability check ──
  let methodConfig: ReturnType<typeof getMethodConfig>;
  try {
    methodConfig = getMethodConfig(agent.country_code, agent.payout_method);
  } catch (err) {
    return failResult(agent, 0, countryReq.local_currency, 0, 1, 0,
      err instanceof Error ? err.message : String(err));
  }

  // ── Step 4: USD disburseable (15 % reserve retained) ──
  const disbursableUsd = parseFloat(
    (agent.balance_usd * (1 - RESERVE_FRACTION)).toFixed(2)
  );

  if (disbursableUsd <= 0) {
    return failResult(agent, 0, countryReq.local_currency, 0, 1, 0,
      "Disbursable USD is zero after 15 % reserve deduction");
  }

  if (disbursableUsd > SWEEP_HARD_CAP_USD) {
    return failResult(agent, disbursableUsd, countryReq.local_currency, 0, 1, 0,
      `$${disbursableUsd.toFixed(2)} exceeds global hard cap ` +
      `$${SWEEP_HARD_CAP_USD.toLocaleString()} — manual approval required`);
  }

  // ── Step 5: FX conversion USD → local currency ──
  let conversion: FxConversion;
  try {
    conversion = await convertUsd(db, disbursableUsd, countryReq.local_currency);
  } catch (err) {
    return failResult(agent, disbursableUsd, countryReq.local_currency, 0, 1, 0,
      `FX conversion failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── Step 6: Withholding tax (deducted from local amount) ──
  const withholdingTaxLocal = parseFloat(
    (conversion.local_amount * countryReq.withholding_tax_rate).toFixed(2)
  );
  const netLocalAmount = parseFloat(
    (conversion.local_amount - withholdingTaxLocal).toFixed(2)
  );

  // ── Step 7: Country method limit enforcement ──
  if (netLocalAmount < methodConfig.min_local) {
    return failResult(agent, disbursableUsd, countryReq.local_currency,
      conversion.mid_rate, conversion.effective_rate, withholdingTaxLocal,
      `Net ${countryReq.local_currency} ${netLocalAmount} is below ` +
      `the ${agent.payout_method} minimum of ${methodConfig.min_local} ` +
      `in ${countryReq.country_name}`);
  }

  if (netLocalAmount > methodConfig.max_local) {
    return failResult(agent, disbursableUsd, countryReq.local_currency,
      conversion.mid_rate, conversion.effective_rate, withholdingTaxLocal,
      `Net ${countryReq.local_currency} ${netLocalAmount} exceeds ` +
      `the ${agent.payout_method} maximum of ${methodConfig.max_local} ` +
      `in ${countryReq.country_name}`);
  }

  // ── Step 8: Idempotency check ──
  const idempotencyKey = deriveIdempotencyKey(
    agent.id, disbursableUsd, agent.payout_method, agent.country_code, sweepDate
  );

  type ExistingLog = {
    id: string;
    status: PayoutStatus;
    provider_reference: string | null;
    local_amount: number;
    local_currency: string;
    fx_mid_rate: number;
    fx_effective_rate: number;
    withholding_tax_local: number;
  };
  const existing = stmts.findExistingLog.get(idempotencyKey) as
    ExistingLog | undefined;

  if (existing) {
    return {
      idempotency_key: idempotencyKey,
      agent_id: agent.id,
      status: "duplicate",
      amount_usd: disbursableUsd,
      local_amount: existing.local_amount,
      local_currency: existing.local_currency,
      fx_mid_rate: existing.fx_mid_rate,
      fx_effective_rate: existing.fx_effective_rate,
      withholding_tax_local: existing.withholding_tax_local,
      provider_reference: existing.provider_reference,
      failure_reason: null,
    };
  }

  // ── Step 9: Atomic DB lock — insert "pending" + debit balance ──
  const createdAt = new Date().toISOString();
  const logId    = crypto.randomUUID();
  const signature = signPayoutEntry(
    idempotencyKey, agent.id, disbursableUsd, netLocalAmount,
    countryReq.local_currency, conversion.effective_rate, "pending", createdAt
  );

  try {
    db.transaction(() => {
      stmts.insertLog.run({
        id: logId, agent_id: agent.id, tenant_id: agent.tenant_id,
        amount_usd: disbursableUsd, local_amount: netLocalAmount,
        local_currency: countryReq.local_currency,
        fx_mid_rate: conversion.mid_rate, fx_effective_rate: conversion.effective_rate,
        fx_rate_id: conversion.rate_id, method: agent.payout_method,
        idempotency_key: idempotencyKey, signature, status: "pending",
        provider_reference: null, failure_reason: null,
        withholding_tax_local: withholdingTaxLocal,
        created_at: createdAt, settled_at: null,
      });
      const info = stmts.debitAgentBalance.run({
        amount: disbursableUsd, agent_id: agent.id,
      });
      if (info.changes === 0) {
        throw new Error(
          "Insufficient USD balance — concurrent modification detected"
        );
      }
    })();
  } catch (lockErr: unknown) {
    return {
      idempotency_key: idempotencyKey, agent_id: agent.id,
      status: "failed", amount_usd: disbursableUsd,
      local_amount: netLocalAmount, local_currency: countryReq.local_currency,
      fx_mid_rate: conversion.mid_rate, fx_effective_rate: conversion.effective_rate,
      withholding_tax_local: withholdingTaxLocal, provider_reference: null,
      failure_reason: lockErr instanceof Error ? lockErr.message : String(lockErr),
    };
  }

  // ── Step 10: Dispatch to payment provider ──
  let providerReference: string | null = null;
  let finalStatus: PayoutStatus = "failed";
  let failureReason: string | null = null;

  try {
    if (agent.payout_method === "momo") {
      if (!agent.momo_number)
        throw new Error("Agent has no momo_number configured");
      const token = await fetchMoMoAccessToken();
      const refId  = crypto.randomUUID();
      await initiateMoMoTransfer(
        token, refId, netLocalAmount, countryReq.local_currency,
        agent.momo_number, agent.name, idempotencyKey
      );
      const result = await pollMoMoTransferStatus(token, refId);
      providerReference = result.referenceId;
      finalStatus =
        result.status === "SUCCESSFUL" ? "success" :
        result.status === "PENDING"    ? "processing" : "failed";
      if (result.status === "FAILED")
        failureReason = result.reason ?? "MoMo provider returned FAILED";

    } else if (agent.payout_method === "card") {
      if (!agent.card_token)
        throw new Error("Agent has no card_token configured");
      const subunit = toSubunit(netLocalAmount, countryReq.local_currency);
      const { providerReference: ref } = await initiateCardTransfer(
        agent.card_token, subunit, countryReq.local_currency,
        idempotencyKey, agent.name
      );
      providerReference = ref;
      finalStatus = "processing"; // Confirmed via webhook.

    } else {
      throw new Error(`Unknown payout_method: ${agent.payout_method}`);
    }
  } catch (dispatchErr: unknown) {
    finalStatus  = "failed";
    failureReason =
      dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr);
    stmts.restoreAgentBalance.run({ amount: disbursableUsd, agent_id: agent.id });
  }

  stmts.updateLogStatus.run({
    status: finalStatus,
    provider_reference: providerReference,
    failure_reason: failureReason,
    settled_at: finalStatus === "success" ? new Date().toISOString() : null,
    idempotency_key: idempotencyKey,
  });

  // ── Step 11: Non-blocking regulatory reporting ──
  if (finalStatus === "success" || finalStatus === "processing") {
    fileRegulatoryReports(
      logId, agent.id, agent.tenant_id, agent.country_code,
      netLocalAmount, countryReq.local_currency, disbursableUsd, createdAt
    ).then(() => {
      stmts.markRegulatoryReportFiled.run({ id: logId });
    }).catch((err) => console.error("[payout] Regulatory report error:", err));
  }

  return {
    idempotency_key: idempotencyKey, agent_id: agent.id, status: finalStatus,
    amount_usd: disbursableUsd, local_amount: netLocalAmount,
    local_currency: countryReq.local_currency,
    fx_mid_rate: conversion.mid_rate, fx_effective_rate: conversion.effective_rate,
    withholding_tax_local: withholdingTaxLocal,
    provider_reference: providerReference, failure_reason: failureReason,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Executes the full tenant-scoped payout sweep.
 *
 * Each agent is disbursed in their local country currency at the prevailing
 * USD mid-market rate plus platform spread.  Withholding tax, method limits,
 * KYC tier, and regulatory thresholds are enforced per country.
 * All payouts within a UTC calendar day are idempotent.
 */
export async function runPayoutSweep(
  tenantId: string,
  db: DB,
  sweepDate: Date = new Date()
): Promise<SweepSummary> {
  const stmts  = prepareStatements(db);
  const agents = stmts.findEligibleAgents.all(tenantId) as AgentPayoutRecord[];

  const results: PayoutResult[] = [];
  let totalInitiated = 0, totalDuplicates = 0, totalFailed = 0, totalAmountUsd = 0;

  for (const agent of agents) {
    const result = await processAgentPayout(agent, stmts, db, sweepDate);
    results.push(result);
    if (result.status === "success" || result.status === "processing") {
      totalInitiated++; totalAmountUsd += result.amount_usd;
    } else if (result.status === "duplicate") {
      totalDuplicates++;
    } else {
      totalFailed++;
    }
  }

  return {
    tenant_id: tenantId, swept_at: new Date().toISOString(),
    total_agents_evaluated: agents.length, total_initiated: totalInitiated,
    total_duplicates: totalDuplicates, total_failed: totalFailed,
    total_amount_usd: parseFloat(totalAmountUsd.toFixed(2)),
    results,
  };
}

/**
 * Resolves a pending payout — called from provider webhook handlers.
 * On terminal failure the debited USD is returned to the agent's balance.
 */
export function settlePayout(
  db: DB,
  idempotencyKey: string,
  finalStatus: "success" | "failed",
  providerReference: string | null,
  failureReason: string | null
): void {
  const stmts = prepareStatements(db);
  stmts.updateLogStatus.run({
    status: finalStatus, provider_reference: providerReference,
    failure_reason: failureReason,
    settled_at: finalStatus === "success" ? new Date().toISOString() : null,
    idempotency_key: idempotencyKey,
  });
  if (finalStatus === "failed") {
    const log = db
      .prepare("SELECT agent_id, amount_usd FROM payout_logs WHERE idempotency_key = ?")
      .get(idempotencyKey) as { agent_id: string; amount_usd: number } | undefined;
    if (log) {
      stmts.restoreAgentBalance.run({ amount: log.amount_usd, agent_id: log.agent_id });
    }
  }
}

/** Paginated payout history for a tenant, newest-first. */
export function getPayoutHistory(
  db: DB, tenantId: string, limit = 100, offset = 0
): PayoutLogRow[] {
  return db
    .prepare(
      "SELECT * FROM payout_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    )
    .all(tenantId, limit, offset) as PayoutLogRow[];
}

/**
 * Returns payout log rows whose HMAC signatures do not match.
 * An empty list means the log has not been tampered with.
 */
export function auditPayoutLogIntegrity(db: DB, tenantId: string): PayoutLogRow[] {
  const rows = db
    .prepare("SELECT * FROM payout_logs WHERE tenant_id = ?")
    .all(tenantId) as PayoutLogRow[];
  return rows.filter((row) => !verifyPayoutSignature(row));
}
