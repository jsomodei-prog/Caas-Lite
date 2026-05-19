/**
 * src/lib/vessel-classes.ts
 *
 * Vessel class pricing configurations. EVERY NUMBER IN THIS FILE IS A
 * PLACEHOLDER. None are calibrated against real loss data, IUMI references,
 * Lloyd's rates, or any other authoritative source.
 *
 * What you'd need to make these real:
 *   - base_rate_per_exposure_day: published IUMI H&M base rates by vessel
 *     class and route, adjusted for current market conditions.
 *   - k_freq / freq_anchor: fit against claim frequency distributions from
 *     a reinsurer's loss runs over a representative period (typically 5y+).
 *   - k_sev / sev_anchor: same but against severity-per-claim distributions.
 *   - pattern_multipliers: calibrated against operational risk premiums
 *     observed in protection-and-indemnity (P&I) club rate cards.
 *   - k_anom: derived from operational incident-to-claim conversion rates.
 *
 * Until those calibrations land, every quote produced from these configs
 * carries calibration_status: "PLACEHOLDER" — surfaced in the API response
 * so no consumer can mistake it for a real price.
 */

import type { VesselClassConfig } from "./premium-pricing";

// ─── Container Ship (high-frequency profile) ──────────────────────────────────

/**
 * Profile: large container vessel on liner trade. Many daily operational
 * decisions (port calls, lashing, ballast ops), most low-severity. The
 * pricing model expects this profile to produce "stable" patterns with
 * occasional "rising" excursions during weather seasons.
 */
export const CONTAINER_SHIP_CONFIG: VesselClassConfig = {
  class_name: "Container Ship — Suezmax (PLACEHOLDER)",

  // CALIBRATE: real value would be IUMI hull rate × current market factor.
  // Placeholder: $0.50 per GT per day → ~$1.5M/year on a 100k GT vessel.
  base_rate_per_exposure_day: 0.50,

  exposure:      100_000,   // gross tonnage (PLACEHOLDER)
  coverage_days: 30,

  // CALIBRATE: container ships are event-heavy by nature; freq_anchor
  // should reflect baseline operations, not be triggered by them.
  k_freq:      0.30,
  freq_anchor: 15,           // events/day considered normal

  // CALIBRATE.
  k_sev:      0.40,
  sev_anchor: 5.0,           // severity score per event considered normal

  // CALIBRATE. Pattern multipliers compress for high-frequency profiles
  // because variance is expected — a "volatile" container ship is still
  // operating within its risk envelope.
  pattern_multipliers: {
    stable:    1.00,
    rising:    1.20,
    volatile:  1.10,
    sparse:    0.85,         // unusually quiet → likely a lay-up period
  },

  // CALIBRATE.
  k_anom: 8.0,
};

// ─── Tugboat (entry-level profile) ────────────────────────────────────────────

/**
 * Profile: harbor or coastal tug. Sparse operational events, but each event
 * carries higher severity tail risk (collision, tow line failure). The
 * pricing model expects this profile to produce "sparse" patterns with
 * occasional severe-event spikes that materially move the premium.
 */
export const TUGBOAT_CONFIG: VesselClassConfig = {
  class_name: "Tugboat — Harbor (PLACEHOLDER)",

  // CALIBRATE.
  base_rate_per_exposure_day: 3.00,   // $/GT/day — higher rate, much lower GT

  exposure:      350,        // gross tonnage (PLACEHOLDER, typical harbor tug)
  coverage_days: 30,

  // CALIBRATE. Lower freq_anchor → tugboat is more sensitive to event
  // count increases. A tug going from 1 event/day to 3 is a much bigger
  // signal than a container ship going from 15 to 17.
  k_freq:      0.50,
  freq_anchor: 2,

  // CALIBRATE. Higher k_sev → severity matters more for tugs because tail
  // events dominate the loss distribution.
  k_sev:      0.80,
  sev_anchor: 8.0,

  // CALIBRATE. Pattern multipliers spread wider — a "rising" or "volatile"
  // tug is a strong signal because the baseline is so low.
  pattern_multipliers: {
    stable:    1.00,
    rising:    1.60,
    volatile:  1.45,
    sparse:    0.95,
  },

  // CALIBRATE.
  k_anom: 15.0,
};
