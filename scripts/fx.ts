/**
 * src/services/fx.ts
 * Foreign-exchange conversion service.
 * USD is the platform's internal settlement currency.
 * All outbound payouts are converted to the agent's local currency at the
 * prevailing mid-market rate, with a configurable spread applied.
 *
 * Provider chain:
 *   1. Open Exchange Rates (primary)
 *   2. Fixer.io              (failover)
 *   3. ExchangeRate-API      (last resort)
 *
 * Rates are cached in SQLite (fx_rate_cache table) and in-process memory.
 * Every rate used in a live payout is written to fx_conversion_log for audit.
 *
 * Commit baseline: a4f5db6  |  Phase 9 build-out
 */

import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────────────────

/** ISO 4217 currency code. */
export type CurrencyCode = string;

export interface FxRate {
  /** Synthetic UUID used as a foreign key in payout_logs. */
  rate_id: string;
  base: "USD";
  target: CurrencyCode;
  /** Raw mid-market rate (1 USD = rate target units). */
  mid_rate: number;
  /** Platform spread fraction applied on top of mid-rate (e.g. 0.005 = 0.5 %). */
  spread_fraction: number;
  /** Effective rate after spread: mid_rate × (1 + spread_fraction). */
  effective_rate: number;
  provider: FxProviderName;
  fetched_at: string;
  /** ISO 8601 expiry — after this the rate must not be used for new payouts. */
  expires_at: string;
}

export interface FxConversion {
  rate_id: string;
  amount_usd: number;
  local_amount: number;
  local_currency: CurrencyCode;
  mid_rate: number;
  effective_rate: number;
  spread_fraction: number;
  provider: FxProviderName;
  converted_at: string;
}

export interface FxConversionLogRow {
  id: string;
  rate_id: string;
  payout_log_id: string | null;
  amount_usd: number;
  local_amount: number;
  local_currency: CurrencyCode;
  mid_rate: number;
  effective_rate: number;
  provider: FxProviderName;
  created_at: string;
}

export type FxProviderName =
  | "open_exchange_rates"
  | "fixer"
  | "exchangerate_api"
  | "manual_override";

export interface FxProvider {
  name: FxProviderName;
  /**
   * Fetches mid-market rates for all requested target currencies.
   * Base is always USD.
   * Returns a map of { [currencyCode]: rate }.
   */
  fetchRates(targets: CurrencyCode[]): Promise<Record<CurrencyCode, number>>;
}

// ─── Configuration ────────────────────────────────────────────────────────────

/** How long a cached rate remains valid for new payouts (minutes). */
const RATE_TTL_MINUTES = parseInt(process.env.FX_RATE_TTL_MINUTES ?? "15", 10);

/**
 * Platform spread applied over mid-market rate.
 * Covers FX risk and provider fees.  Default 0.5 %.
 */
const DEFAULT_SPREAD = parseFloat(process.env.FX_SPREAD_FRACTION ?? "0.005");

const OXR_APP_ID = process.env.OXR_APP_ID ?? "";
const FIXER_API_KEY = process.env.FIXER_API_KEY ?? "";
const EXCHANGERATE_API_KEY = process.env.EXCHANGERATE_API_KEY ?? "";

// ─── Provider Implementations ─────────────────────────────────────────────────

class OpenExchangeRatesProvider implements FxProvider {
  readonly name: FxProviderName = "open_exchange_rates";

  async fetchRates(targets: CurrencyCode[]): Promise<Record<CurrencyCode, number>> {
    if (!OXR_APP_ID) throw new Error("OXR_APP_ID not configured");
    const symbols = targets.join(",");
    const url = `https://openexchangerates.org/api/latest.json?app_id=${OXR_APP_ID}&base=USD&symbols=${symbols}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenExchangeRates [${res.status}]: ${body}`);
    }
    const data = (await res.json()) as { rates: Record<string, number> };
    return data.rates;
  }
}

class FixerProvider implements FxProvider {
  readonly name: FxProviderName = "fixer";

  async fetchRates(targets: CurrencyCode[]): Promise<Record<CurrencyCode, number>> {
    if (!FIXER_API_KEY) throw new Error("FIXER_API_KEY not configured");
    const symbols = targets.join(",");
    // Fixer free plan only supports EUR base; we convert via EUR→USD cross rate.
    const url = `http://data.fixer.io/api/latest?access_key=${FIXER_API_KEY}&base=EUR&symbols=USD,${symbols}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fixer [${res.status}]`);
    const data = (await res.json()) as { success: boolean; rates: Record<string, number> };
    if (!data.success) throw new Error("Fixer returned success=false");

    const eurUsd = data.rates["USD"];
    if (!eurUsd) throw new Error("Fixer did not return EUR/USD rate");

    const result: Record<CurrencyCode, number> = {};
    for (const code of targets) {
      const eurLocal = data.rates[code];
      if (eurLocal !== undefined) {
        // Convert: 1 USD = (1/eurUsd) EUR = (1/eurUsd)*eurLocal target units
        result[code] = eurLocal / eurUsd;
      }
    }
    return result;
  }
}

class ExchangeRateApiProvider implements FxProvider {
  readonly name: FxProviderName = "exchangerate_api";

  async fetchRates(targets: CurrencyCode[]): Promise<Record<CurrencyCode, number>> {
    if (!EXCHANGERATE_API_KEY) throw new Error("EXCHANGERATE_API_KEY not configured");
    const url = `https://v6.exchangerate-api.com/v6/${EXCHANGERATE_API_KEY}/latest/USD`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ExchangeRate-API [${res.status}]`);
    const data = (await res.json()) as {
      result: string;
      conversion_rates: Record<string, number>;
    };
    if (data.result !== "success") throw new Error("ExchangeRate-API returned non-success");

    const result: Record<CurrencyCode, number> = {};
    for (const code of targets) {
      if (data.conversion_rates[code] !== undefined) {
        result[code] = data.conversion_rates[code];
      }
    }
    return result;
  }
}

// ─── In-Memory Cache ──────────────────────────────────────────────────────────

interface CachedRate {
  rate: FxRate;
  expires_at_ms: number;
}

const memoryCache = new Map<CurrencyCode, CachedRate>();

function getCachedRate(currency: CurrencyCode): FxRate | null {
  const entry = memoryCache.get(currency);
  if (!entry) return null;
  if (Date.now() > entry.expires_at_ms) {
    memoryCache.delete(currency);
    return null;
  }
  return entry.rate;
}

function setCachedRate(rate: FxRate): void {
  memoryCache.set(rate.target, {
    rate,
    expires_at_ms: new Date(rate.expires_at).getTime(),
  });
}

// ─── Database Persistence ─────────────────────────────────────────────────────

function loadRateFromDb(db: DB, currency: CurrencyCode): FxRate | null {
  const row = db
    .prepare(
      `SELECT * FROM fx_rate_cache
       WHERE target = ? AND expires_at > ?
       ORDER BY fetched_at DESC
       LIMIT 1`
    )
    .get(currency, new Date().toISOString()) as FxRate | undefined;
  return row ?? null;
}

function persistRateToDb(db: DB, rate: FxRate): void {
  db.prepare(
    `INSERT OR REPLACE INTO fx_rate_cache
       (rate_id, base, target, mid_rate, spread_fraction, effective_rate,
        provider, fetched_at, expires_at)
     VALUES
       (@rate_id, @base, @target, @mid_rate, @spread_fraction, @effective_rate,
        @provider, @fetched_at, @expires_at)`
  ).run(rate);
}

// ─── Core FX Service ──────────────────────────────────────────────────────────

const PROVIDERS: FxProvider[] = [
  new OpenExchangeRatesProvider(),
  new FixerProvider(),
  new ExchangeRateApiProvider(),
];

/**
 * Fetches the prevailing USD→target mid-market rate from the provider chain.
 * Tries each provider in order; first success wins.
 * Rates are written to the in-memory cache and DB immediately.
 */
async function fetchLiveRate(
  db: DB,
  currency: CurrencyCode,
  spreadFraction: number = DEFAULT_SPREAD
): Promise<FxRate> {
  let lastError: Error | null = null;

  for (const provider of PROVIDERS) {
    try {
      const rates = await provider.fetchRates([currency]);
      const midRate = rates[currency];
      if (midRate === undefined || midRate <= 0) {
        throw new Error(`Provider ${provider.name} returned no rate for ${currency}`);
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + RATE_TTL_MINUTES * 60_000);

      const rate: FxRate = {
        rate_id: crypto.randomUUID(),
        base: "USD",
        target: currency,
        mid_rate: midRate,
        spread_fraction: spreadFraction,
        effective_rate: parseFloat((midRate * (1 + spreadFraction)).toFixed(6)),
        provider: provider.name,
        fetched_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
      };

      setCachedRate(rate);
      persistRateToDb(db, rate);
      return rate;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`[fx] Provider ${provider.name} failed: ${lastError.message}`);
    }
  }

  throw new Error(
    `All FX providers failed for currency ${currency}. Last error: ${lastError?.message}`
  );
}

/**
 * Returns a valid FxRate for the given currency.
 * Resolution order: memory cache → DB cache → live fetch.
 */
export async function getRate(
  db: DB,
  currency: CurrencyCode,
  spreadFraction: number = DEFAULT_SPREAD
): Promise<FxRate> {
  // 1. Memory cache
  const mem = getCachedRate(currency);
  if (mem) return mem;

  // 2. DB cache
  const dbRate = loadRateFromDb(db, currency);
  if (dbRate) {
    setCachedRate(dbRate);
    return dbRate;
  }

  // 3. Live fetch
  return fetchLiveRate(db, currency, spreadFraction);
}

/**
 * Converts a USD amount to a local currency amount using the prevailing rate.
 * Rounds to the precision appropriate for the target currency.
 *
 * @param db             SQLite handle for cache reads/writes and audit logging.
 * @param amountUsd      Amount in USD (platform settlement currency).
 * @param targetCurrency ISO 4217 currency code for the target country.
 * @param payoutLogId    Optional payout_logs.id to link the conversion audit record.
 */
export async function convertUsd(
  db: DB,
  amountUsd: number,
  targetCurrency: CurrencyCode,
  payoutLogId: string | null = null
): Promise<FxConversion> {
  if (targetCurrency === "USD") {
    const now = new Date().toISOString();
    const rateId = crypto.randomUUID();
    const conversion: FxConversion = {
      rate_id: rateId,
      amount_usd: amountUsd,
      local_amount: amountUsd,
      local_currency: "USD",
      mid_rate: 1,
      effective_rate: 1,
      spread_fraction: 0,
      provider: "manual_override",
      converted_at: now,
    };
    writeConversionLog(db, conversion, payoutLogId);
    return conversion;
  }

  const rate = await getRate(db, targetCurrency);
  const rawLocal = amountUsd * rate.effective_rate;
  const localAmount = roundLocalAmount(rawLocal, targetCurrency);
  const now = new Date().toISOString();

  const conversion: FxConversion = {
    rate_id: rate.rate_id,
    amount_usd: amountUsd,
    local_amount: localAmount,
    local_currency: targetCurrency,
    mid_rate: rate.mid_rate,
    effective_rate: rate.effective_rate,
    spread_fraction: rate.spread_fraction,
    provider: rate.provider,
    converted_at: now,
  };

  writeConversionLog(db, conversion, payoutLogId);
  return conversion;
}

/**
 * Rounds a local currency amount to the correct decimal precision.
 * Zero-decimal currencies (JPY, KRW, UGX, etc.) round to the nearest integer.
 * Three-decimal currencies (KWD, BHD, OMR) round to 3dp.
 * All others default to 2dp.
 */
export function roundLocalAmount(amount: number, currency: CurrencyCode): number {
  const zeroDp = new Set([
    "BIF","CLP","DJF","GNF","ISK","JPY","KMF","KRW","MGA",
    "PYG","RWF","UGX","VND","VUV","XAF","XOF","XPF",
  ]);
  const threeDp = new Set(["BHD","IQD","JOD","KWD","LYD","MRU","OMR","TND"]);

  if (zeroDp.has(currency)) return Math.round(amount);
  if (threeDp.has(currency)) return parseFloat(amount.toFixed(3));
  return parseFloat(amount.toFixed(2));
}

/**
 * Writes a conversion event to fx_conversion_log for compliance audit.
 */
function writeConversionLog(
  db: DB,
  conversion: FxConversion,
  payoutLogId: string | null
): void {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO fx_conversion_log
       (id, rate_id, payout_log_id, amount_usd, local_amount, local_currency,
        mid_rate, effective_rate, provider, created_at)
     VALUES
       (@id, @rate_id, @payout_log_id, @amount_usd, @local_amount,
        @local_currency, @mid_rate, @effective_rate, @provider, @created_at)`
  ).run({
    id,
    rate_id: conversion.rate_id,
    payout_log_id: payoutLogId,
    amount_usd: conversion.amount_usd,
    local_amount: conversion.local_amount,
    local_currency: conversion.local_currency,
    mid_rate: conversion.mid_rate,
    effective_rate: conversion.effective_rate,
    provider: conversion.provider,
    created_at: conversion.converted_at,
  });
}

/**
 * Registers a manual rate override in the DB cache.
 * Used for currencies not covered by automated providers, or during market
 * closures, with operator-supplied rates.  Requires explicit expiry.
 */
export function setManualRate(
  db: DB,
  currency: CurrencyCode,
  midRate: number,
  expiresAt: Date,
  spreadFraction: number = DEFAULT_SPREAD
): FxRate {
  if (midRate <= 0) throw new Error("midRate must be positive");
  if (expiresAt <= new Date()) throw new Error("expiresAt must be in the future");

  const rate: FxRate = {
    rate_id: crypto.randomUUID(),
    base: "USD",
    target: currency,
    mid_rate: midRate,
    spread_fraction: spreadFraction,
    effective_rate: parseFloat((midRate * (1 + spreadFraction)).toFixed(6)),
    provider: "manual_override",
    fetched_at: new Date().toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  setCachedRate(rate);
  persistRateToDb(db, rate);
  return rate;
}

/**
 * Returns the full conversion history for a given payout log entry.
 */
export function getConversionsForPayout(
  db: DB,
  payoutLogId: string
): FxConversionLogRow[] {
  return db
    .prepare("SELECT * FROM fx_conversion_log WHERE payout_log_id = ?")
    .all(payoutLogId) as FxConversionLogRow[];
}

/**
 * Returns paginated FX rate cache rows for auditing / monitoring.
 */
export function getRateHistory(
  db: DB,
  currency: CurrencyCode,
  limit = 50
): FxRate[] {
  return db
    .prepare(
      "SELECT * FROM fx_rate_cache WHERE target = ? ORDER BY fetched_at DESC LIMIT ?"
    )
    .all(currency, limit) as FxRate[];
}

/**
 * Purges expired rate cache rows older than `olderThanHours`.
 * Call from a scheduled maintenance job.
 */
export function purgeExpiredRates(db: DB, olderThanHours = 48): number {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString();
  const result = db
    .prepare("DELETE FROM fx_rate_cache WHERE expires_at < ?")
    .run(cutoff);
  return result.changes;
}

// ─── Required DB Schema (migration reference) ─────────────────────────────────
//
// CREATE TABLE IF NOT EXISTS fx_rate_cache (
//   rate_id          TEXT PRIMARY KEY,
//   base             TEXT NOT NULL DEFAULT 'USD',
//   target           TEXT NOT NULL,
//   mid_rate         REAL NOT NULL,
//   spread_fraction  REAL NOT NULL,
//   effective_rate   REAL NOT NULL,
//   provider         TEXT NOT NULL,
//   fetched_at       TEXT NOT NULL,
//   expires_at       TEXT NOT NULL
// );
// CREATE INDEX IF NOT EXISTS idx_fx_rate_target ON fx_rate_cache(target, expires_at);
//
// CREATE TABLE IF NOT EXISTS fx_conversion_log (
//   id               TEXT PRIMARY KEY,
//   rate_id          TEXT NOT NULL REFERENCES fx_rate_cache(rate_id),
//   payout_log_id    TEXT REFERENCES payout_logs(id),
//   amount_usd       REAL NOT NULL,
//   local_amount     REAL NOT NULL,
//   local_currency   TEXT NOT NULL,
//   mid_rate         REAL NOT NULL,
//   effective_rate   REAL NOT NULL,
//   provider         TEXT NOT NULL,
//   created_at       TEXT NOT NULL
// );
