/**
 * src/lib/premium-pricing.ts
 * Pure function: RiskProfile + VesselClassConfig → PremiumQuote.
 *
 * Every coefficient is an explicit input. The function does math; the
 * caller decides the numbers. This separation is intentional: when real
 * loss data arrives, only the config files change — the math is stable.
 *
 *   premium = base_rate
 *           × frequency_adjustment(profile)
 *           × severity_adjustment(profile)
 *           × pattern_multiplier(profile)
 *           × exposure
 *
 * The four adjustments are themselves explicit functions of profile signals
 * with named, configurable coefficients. There is exactly one place in this
 * file where a number is not provided by the config: the floor that prevents
 * premiums from going negative or zero. That floor is 0.5× base_rate and
 * documented at its usage site.
 */

import type { RiskProfile, RiskPattern } from "./risk-profile";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VesselClassConfig {
  /** Display name, e.g. "Container Ship — Suezmax", "Tugboat — Harbor". */
  class_name: string;

  /**
   * Base rate in the quote's currency unit per exposure unit per day.
   *
   * For marine hull-and-machinery cover this is typically USD per
   * (gross-tonnage × day) and is set against published IUMI / Lloyd's
   * indices. CALIBRATE: placeholder values in vessel-classes.ts are NOT
   * real reference rates.
   */
  base_rate_per_exposure_day: number;

  /** Exposure unit: usually GT (gross tonnage), TEU, or a dimensionless 1. */
  exposure: number;

  /** Coverage window — 30 days for a monthly quote. */
  coverage_days: number;

  /**
   * Coefficients applied to the EWMA frequency signal. The formula is:
   *   frequency_adjustment = 1 + k_freq × log1p(ewma_events_per_day / freq_anchor)
   *
   * log1p() because the relationship between event rate and loss expectation
   * is sublinear — doubling event rate doesn't double risk, it's typically
   * the square root or log of that. Anchor is the "neutral" rate at which
   * adjustment = 1.
   *
   * CALIBRATE: k_freq and freq_anchor against actual claim frequency curves.
   */
  k_freq:      number;
  freq_anchor: number;

  /**
   * Coefficients for severity adjustment:
   *   severity_adjustment = 1 + k_sev × (ewma_severity_per_event / sev_anchor - 1)
   *
   * Linear in severity-per-event because severity directly scales loss size,
   * unlike frequency which has the sublinear dynamic above.
   *
   * CALIBRATE.
   */
  k_sev:      number;
  sev_anchor: number;

  /**
   * Pattern multipliers. Applied as a flat multiplier based on the coarse
   * pattern classification from RiskProfile. CALIBRATE.
   */
  pattern_multipliers: Record<RiskPattern, number>;

  /**
   * Anomaly load: every percentage point of EWMA anomaly rate adds this
   * to the multiplier. So anomaly_rate = 0.02 (2%) adds 0.02 × k_anom.
   *
   * CALIBRATE.
   */
  k_anom: number;
}

export interface PremiumQuote {
  vessel_class: string;
  currency_unit: "USD";       // Hard-coded for now; expand when international
  coverage_days: number;
  exposure: number;

  // Stepwise breakdown so an underwriter can audit the quote
  base_premium:           number;   // base_rate × exposure × coverage_days
  frequency_adjustment:   number;
  severity_adjustment:    number;
  pattern_multiplier:     number;
  anomaly_load:           number;

  /** Final premium = base × all adjustments, floored at 50% of base. */
  premium_total: number;

  /** Profile-derived signals the underwriter would want to see. */
  signals: {
    pattern:              RiskPattern;
    ewma_events_per_day:  number;
    ewma_severity_per_event: number;
    ewma_anomaly_rate:    number;
    trajectory_events:    number;
  };

  /** Honesty flag: every quote produced with placeholder constants is marked. */
  calibration_status: "PLACEHOLDER" | "CALIBRATED";

  generated_at: string;
}

// ─── Core ─────────────────────────────────────────────────────────────────────

const PREMIUM_FLOOR_RATIO = 0.5;  // see usage site

export function priceFromProfile(
  profile: RiskProfile,
  config: VesselClassConfig,
  opts: { calibration_status?: "PLACEHOLDER" | "CALIBRATED" } = {}
): PremiumQuote {
  const basePremium =
    config.base_rate_per_exposure_day * config.exposure * config.coverage_days;

  // Frequency: sublinear, log1p-shaped
  const freqAdj = 1 + config.k_freq *
    Math.log1p(profile.ewma_events_per_day / Math.max(config.freq_anchor, 1e-9));

  // Severity: linear in per-event severity vs anchor
  const sevAdj = 1 + config.k_sev *
    (profile.ewma_severity_per_event / Math.max(config.sev_anchor, 1e-9) - 1);

  // Pattern: flat lookup
  const patternMult = config.pattern_multipliers[profile.pattern] ?? 1.0;

  // Anomaly load: additive on the multiplier
  const anomLoad = config.k_anom * profile.ewma_anomaly_rate;

  const combined = freqAdj * sevAdj * patternMult * (1 + anomLoad);
  const rawTotal = basePremium * combined;

  // Floor: premiums never below 50% of base. Justification: a vessel can't
  // become safer than its baseline class implies just because a 30-day
  // window happened to be quiet. Underwriting reality is that base rates
  // already factor in best-case operations. If your model wants no floor,
  // pass a config with multipliers that bottom out at 1.0 themselves.
  const total = Math.max(rawTotal, basePremium * PREMIUM_FLOOR_RATIO);

  return {
    vessel_class:         config.class_name,
    currency_unit:        "USD",
    coverage_days:        config.coverage_days,
    exposure:             config.exposure,
    base_premium:         round(basePremium, 2),
    frequency_adjustment: round(freqAdj,     4),
    severity_adjustment:  round(sevAdj,      4),
    pattern_multiplier:   round(patternMult, 4),
    anomaly_load:         round(anomLoad,    4),
    premium_total:        round(total,       2),
    signals: {
      pattern:                 profile.pattern,
      ewma_events_per_day:     profile.ewma_events_per_day,
      ewma_severity_per_event: profile.ewma_severity_per_event,
      ewma_anomaly_rate:       profile.ewma_anomaly_rate,
      trajectory_events:       profile.trajectory_events,
    },
    calibration_status: opts.calibration_status ?? "PLACEHOLDER",
    generated_at: new Date().toISOString(),
  };
}

function round(x: number, places: number): number {
  const p = Math.pow(10, places);
  return Math.round(x * p) / p;
}
