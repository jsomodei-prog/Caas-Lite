/**
 * src/calibration/loss-run-schema.ts
 * Schema for historical loss-run records used as calibration input.
 *
 * A "loss run" is the industry term for a claim history report — one row
 * per claim or per claim-free vessel-year. Real loss runs come from
 * reinsurance carriers, P&I clubs, or internal claim databases.
 *
 * This schema defines what we EXPECT the input to look like. A real loss
 * run will have many more columns; the loader normalizes whatever the
 * carrier provides into this minimal shape.
 *
 * NOTE: This is the data calibration consumes, NOT the data we generate.
 * The format here is dictated by what reinsurance carriers typically
 * produce, not by what's convenient for our code.
 */

import type { AccountTier } from "../routes/provisioning";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Vessel-class label as it appears in input data. Free-form text so we
 * can match real-world descriptions; mapped to our internal VesselClassKey
 * by the loader's normalization step.
 */
export type VesselClassLabel = string;

/**
 * Our internal vessel-class identifier. Must match a key in vessel-classes.ts.
 * Currently CONTAINER_SHIP and TUGBOAT.
 */
export type VesselClassKey = "CONTAINER_SHIP" | "TUGBOAT";

/**
 * One loss-run record. Represents a single vessel-year of exposure with
 * any associated claims aggregated. A vessel with multiple claims in one
 * year contributes ONE row with claim_count > 0 and severity_total summed.
 *
 * Fields:
 *   policy_year       : ISO year of the policy period
 *   vessel_class      : raw label from the source data (normalized later)
 *   exposure_value    : numeric measure of exposure (GT for marine hull)
 *   exposure_unit     : human-readable unit; for validation only
 *   claim_count       : claims reported in this vessel-year (0 = clean year)
 *   severity_total    : total paid + outstanding losses for this row, USD
 *   premium_earned    : earned premium for this vessel-year, USD
 *
 * What is INTENTIONALLY omitted:
 *   - Per-claim payout amounts (would need a separate per-claim table)
 *   - IBNR (incurred but not reported) loss estimates — we use closed years only
 *   - Deductibles, retentions, ceded amounts — calibration uses ground-up losses
 */
export interface LossRunRecord {
  policy_year:    number;
  vessel_class:   VesselClassLabel;
  exposure_value: number;
  exposure_unit:  string;
  claim_count:    number;
  severity_total: number;
  premium_earned: number;
}

/**
 * Aggregated statistics derived from a set of loss runs for one vessel class.
 * The fitter consumes this; the calibration output is computed from it.
 */
export interface VesselClassLossStats {
  vessel_class_key:        VesselClassKey;
  total_vessel_years:      number;
  total_claims:            number;
  total_severity_usd:      number;
  total_exposure:          number;
  total_premium_earned:    number;

  /** Claims per vessel-year. The primary frequency signal. */
  claim_frequency_rate:    number;
  /** Mean severity per claim (USD). Undefined when total_claims === 0. */
  mean_severity_per_claim: number | null;
  /** Loss ratio: total_severity / total_premium_earned. */
  loss_ratio:              number;

  /** ISO date range observed in the input. */
  earliest_year: number;
  latest_year:   number;
}

// ─── Re-export AccountTier so calibration can map class-tier coverage if needed ──

export type { AccountTier };
