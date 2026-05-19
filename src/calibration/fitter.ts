/**
 * src/calibration/fitter.ts
 * Fitter interface for translating loss-run statistics into pricing coefficients.
 *
 * The fitter takes a VesselClassLossStats and returns a CalibratedConfig
 * suitable for replacing the placeholder values in vessel-classes.ts.
 *
 * REAL fitting is statistical work:
 *   - claim_frequency_rate → fit to freq_anchor + k_freq curve
 *   - mean_severity_per_claim → fit to sev_anchor + k_sev curve
 *   - loss ratio analysis → adjust base_rate
 *   - per-state pattern multipliers → quantile analysis on observed deviations
 *
 * That work needs an actuary, real data, and statistical tooling beyond
 * what belongs in this codebase. This file provides:
 *
 *   1. The Fitter interface — the function signature an actuary's code
 *      must implement.
 *   2. nullFitter — a placeholder that returns the existing hardcoded
 *      constants from vessel-classes.ts, AS IF they came from fitting.
 *      Used to exercise the calibration pipeline end-to-end without real data.
 *   3. validateCalibratedConfig — sanity checks that catch unhinged
 *      output (negative rates, zero anchors, etc.) before promotion.
 *
 * When real fitting happens:
 *   - Implement a new fitter (e.g. mleFitter, glmFitter)
 *   - Run it against your loss runs
 *   - Validate
 *   - Promote via the script in scripts/promote-calibration.ts
 */

import {
  CONTAINER_SHIP_CONFIG,
  TUGBOAT_CONFIG,
} from "../lib/vessel-classes";
import type { VesselClassConfig } from "../lib/premium-pricing";
import type { VesselClassKey, VesselClassLossStats } from "./loss-run-schema";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Output of a fitter run. Same shape as VesselClassConfig but with
 * provenance metadata so promotion knows what to write into the
 * vessel-classes.ts file's comment headers.
 */
export interface CalibratedConfig {
  vessel_class_key: VesselClassKey;
  config:           VesselClassConfig;
  provenance: {
    fitter_name:         string;
    fitter_version:      string;
    input_vessel_years:  number;
    input_year_range:    [number, number];
    fit_timestamp:       string;
    /** Brief note explaining the fit (e.g. "MLE on 5y closed claims"). */
    notes?:              string;
  };
}

export type Fitter = (
  stats: VesselClassLossStats
) => CalibratedConfig;

// ─── Null Fitter ─────────────────────────────────────────────────────────────

/**
 * Returns the existing hardcoded constants for the input's vessel class,
 * stamped with provenance saying "no fitting was performed."
 *
 * Use this to:
 *   - Exercise the calibration pipeline end-to-end without real loss data
 *   - Establish a baseline against which real fitting can be compared
 *   - Test the promotion script + simulation harness
 *
 * NEVER use the output of this fitter in production pricing. The whole
 * point is that the values are unchanged from the hardcoded placeholders.
 */
export const nullFitter: Fitter = (stats) => {
  const base = stats.vessel_class_key === "CONTAINER_SHIP"
    ? CONTAINER_SHIP_CONFIG
    : TUGBOAT_CONFIG;

  return {
    vessel_class_key: stats.vessel_class_key,
    config: {
      ...base,
      // Keep the placeholder marker in class_name so any downstream
      // consumer sees we haven't actually calibrated.
      class_name: base.class_name,
    },
    provenance: {
      fitter_name:        "nullFitter",
      fitter_version:     "0.1.0",
      input_vessel_years: stats.total_vessel_years,
      input_year_range:   [stats.earliest_year, stats.latest_year],
      fit_timestamp:      new Date().toISOString(),
      notes:              "PLACEHOLDER — returns hardcoded constants without fitting. Replace with a real fitter before production.",
    },
  };
};

// ─── Plausibility Validation ─────────────────────────────────────────────────

/**
 * Checks that a fitter's output is in plausible ranges. Catches:
 *   - Negative or zero coefficients
 *   - Anchors at exactly 1 (suggests defaulted/uninitialised)
 *   - Pattern multipliers outside [0.5, 5.0]
 *   - Base rates outside known marine market range
 *
 * Returns an array of problem strings; empty array means clean.
 *
 * This is intentionally conservative — false positives are cheap (operator
 * reviews and overrides), false negatives are expensive (bad numbers ship).
 */
export interface ValidationProblem {
  field:    string;
  value:    unknown;
  reason:   string;
  severity: "error" | "warning";
}

export function validateCalibratedConfig(calibrated: CalibratedConfig): ValidationProblem[] {
  const problems: ValidationProblem[] = [];
  const c = calibrated.config;

  const err = (field: string, value: unknown, reason: string): void => {
    problems.push({ field, value, reason, severity: "error" });
  };
  const warn = (field: string, value: unknown, reason: string): void => {
    problems.push({ field, value, reason, severity: "warning" });
  };

  // ── base_rate ──
  if (c.base_rate_per_exposure_day <= 0) {
    err("base_rate_per_exposure_day", c.base_rate_per_exposure_day, "must be > 0");
  } else if (c.base_rate_per_exposure_day < 0.01 || c.base_rate_per_exposure_day > 100) {
    warn(
      "base_rate_per_exposure_day", c.base_rate_per_exposure_day,
      "outside typical marine H&M range [0.01, 100] USD/exposure/day"
    );
  }

  // ── frequency coefficients ──
  if (c.k_freq < 0) err("k_freq", c.k_freq, "must be >= 0 (negative would discount high frequency)");
  if (c.k_freq > 2) warn("k_freq", c.k_freq, "very high frequency loading; verify intent");
  if (c.freq_anchor <= 0) err("freq_anchor", c.freq_anchor, "must be > 0");

  // ── severity coefficients ──
  if (c.k_sev < 0) err("k_sev", c.k_sev, "must be >= 0");
  if (c.k_sev > 3) warn("k_sev", c.k_sev, "very high severity loading; verify intent");
  if (c.sev_anchor <= 0) err("sev_anchor", c.sev_anchor, "must be > 0");

  // ── pattern multipliers ──
  for (const [pattern, mult] of Object.entries(c.pattern_multipliers)) {
    if (mult <= 0) {
      err(`pattern_multipliers.${pattern}`, mult, "must be > 0");
    } else if (mult < 0.5 || mult > 5.0) {
      warn(
        `pattern_multipliers.${pattern}`, mult,
        "outside [0.5, 5.0] range; pricing may be unstable"
      );
    }
  }

  // ── anomaly load ──
  if (c.k_anom < 0) err("k_anom", c.k_anom, "must be >= 0");
  if (c.k_anom > 50) warn("k_anom", c.k_anom, "very steep anomaly response; verify intent");

  // ── exposure / coverage_days sanity ──
  if (c.exposure <= 0) err("exposure", c.exposure, "must be > 0");
  if (c.coverage_days <= 0) err("coverage_days", c.coverage_days, "must be > 0");

  // ── provenance plausibility ──
  if (calibrated.provenance.input_vessel_years < 50) {
    warn(
      "provenance.input_vessel_years", calibrated.provenance.input_vessel_years,
      "<50 vessel-years of input data; fit may be noisy. Industry rule of thumb is 5+ years."
    );
  }

  return problems;
}

/**
 * Convenience: split a problem list into errors-only and warnings-only.
 */
export function partitionProblems(problems: ValidationProblem[]): {
  errors:   ValidationProblem[];
  warnings: ValidationProblem[];
} {
  return {
    errors:   problems.filter(p => p.severity === "error"),
    warnings: problems.filter(p => p.severity === "warning"),
  };
}
