/**
 * src/lib/risk-profile.ts
 * Pure function: 30-day historical time-series → exponentially-weighted risk profile.
 *
 * Input shape (one entry per day, oldest first):
 *   [
 *     { date: "2026-04-19", events: 12, severity_sum: 84.5, anomaly_count: 1, drift_flag: false },
 *     ...
 *   ]
 *
 * Output: a single RiskProfile object with EWMA-aggregated signals.
 * Recent days are weighted higher than older days via an exponential
 * decay factor — so a recent spike matters more than an old one of the
 * same size.
 *
 * Why EWMA and not a sliding window:
 *   Sliding windows give equal weight to all days in the window and zero
 *   weight outside it, which produces step-function premium movements as
 *   events fall off the back of the window. EWMA gives a smooth, monotonic
 *   response to new evidence and is the standard pre-actuarial signal
 *   smoothing for short-horizon premium models.
 *
 * What this does NOT do:
 *   - Decide a premium. That's premium-pricing.ts.
 *   - Detect anomalies. The caller supplies anomaly_count per day.
 *   - Validate vessel class. Profile is signal-agnostic.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TimeSeriesDay {
  /** ISO date (YYYY-MM-DD). Used for ordering and reporting only. */
  date: string;
  /** Decision/operation events on this day. */
  events: number;
  /** Sum of per-event severity scores. Severity scale is caller-defined. */
  severity_sum: number;
  /** Count of anomalies flagged for the day. */
  anomaly_count: number;
  /** True if the day showed compliance/operational drift signals. */
  drift_flag: boolean;
}

export interface RiskProfile {
  // Aggregate counts (unweighted)
  total_events:        number;
  total_anomalies:     number;
  drift_days:          number;
  series_days:         number;

  // EWMA-weighted signals (recent days count more)
  ewma_events_per_day:    number;
  ewma_severity_per_event: number;
  ewma_anomaly_rate:       number;   // anomalies / events

  // Trajectory: positive = trending worse, negative = improving
  // Computed as (recent half mean) - (older half mean), on EWMA basis
  trajectory_events:    number;
  trajectory_severity:  number;
  trajectory_anomalies: number;

  // Coarse classification consumed by premium-pricing.ts
  // 'stable' | 'rising' | 'volatile' | 'sparse'
  pattern: RiskPattern;

  window: { from: string; to: string; days: number };
}

export type RiskPattern = "stable" | "rising" | "volatile" | "sparse";

export interface RiskProfileConfig {
  /**
   * EWMA decay factor. 1.0 = no decay (all days equal); approaching 0 = only
   * today matters. 0.85 is a reasonable middle ground for a 30-day series:
   * day-30 carries ~1% of day-1's weight.
   *
   * CALIBRATE: this needs tuning against real claims data. Lower decay
   * (more memory) is appropriate when losses are rare events with long
   * predictive tails; higher decay is appropriate when conditions change
   * fast (e.g., crew/route changes).
   */
  ewma_decay: number;

  /** Days below this count → 'sparse' pattern regardless of other signals. */
  sparse_threshold_events_per_day: number;

  /** Trajectory threshold for 'rising'. CALIBRATE. */
  rising_trajectory_threshold: number;

  /** Coefficient of variation above which a series is 'volatile'. CALIBRATE. */
  volatile_cv_threshold: number;
}

/** Sensible defaults for the placeholder calibration. CALIBRATE all of these. */
export const DEFAULT_RISK_CONFIG: RiskProfileConfig = {
  ewma_decay:                       0.85,
  sparse_threshold_events_per_day:  2,
  rising_trajectory_threshold:      0.20,   // 20% increase in recent half
  volatile_cv_threshold:            1.0,    // stddev > mean
};

// ─── Core ────────────────────────────────────────────────────────────────────

/**
 * Builds a risk profile from a chronologically-ordered time series.
 * The series should be sorted oldest-first; the function does not re-sort.
 * Throws if the series is empty or contains negative values.
 */
export function buildRiskProfile(
  series: TimeSeriesDay[],
  config: RiskProfileConfig = DEFAULT_RISK_CONFIG
): RiskProfile {
  if (series.length === 0) {
    throw new Error("buildRiskProfile: series is empty");
  }
  for (const [i, d] of series.entries()) {
    if (d.events < 0 || d.severity_sum < 0 || d.anomaly_count < 0) {
      throw new Error(`buildRiskProfile: series[${i}] has negative values`);
    }
  }

  // EWMA: most-recent day has weight 1, prior day has weight decay^1, etc.
  // Compute weights once, normalised so they sum to 1.
  const n       = series.length;
  const weights = new Array<number>(n);
  let weightSum = 0;
  for (let i = 0; i < n; i++) {
    // i=0 is oldest, i=n-1 is most recent → exponent = (n-1-i)
    const w = Math.pow(config.ewma_decay, n - 1 - i);
    weights[i] = w;
    weightSum += w;
  }
  // Normalise (avoids weights summing to >1 when decay≈1)
  for (let i = 0; i < n; i++) weights[i] /= weightSum;

  // EWMA aggregates
  let ewmaEvents      = 0;
  let ewmaSeveritySum = 0;
  let ewmaAnomalies   = 0;
  for (let i = 0; i < n; i++) {
    ewmaEvents      += weights[i] * series[i].events;
    ewmaSeveritySum += weights[i] * series[i].severity_sum;
    ewmaAnomalies   += weights[i] * series[i].anomaly_count;
  }
  const ewmaSeverityPerEvent = ewmaEvents > 0 ? ewmaSeveritySum / ewmaEvents : 0;
  const ewmaAnomalyRate      = ewmaEvents > 0 ? ewmaAnomalies   / ewmaEvents : 0;

  // Trajectory: compare recent half vs older half on EWMA basis
  const mid = Math.floor(n / 2);
  const traj = (fn: (d: TimeSeriesDay) => number): number => {
    const older  = series.slice(0, mid).map(fn);
    const recent = series.slice(mid).map(fn);
    const meanOf = (xs: number[]) =>
      xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
    const o = meanOf(older);
    const r = meanOf(recent);
    return o > 0 ? (r - o) / o : (r > 0 ? 1 : 0);
  };
  const trajectoryEvents    = traj(d => d.events);
  const trajectorySeverity  = traj(d => d.severity_sum);
  const trajectoryAnomalies = traj(d => d.anomaly_count);

  // Aggregate unweighted counts
  const totalEvents    = series.reduce((s, d) => s + d.events, 0);
  const totalAnomalies = series.reduce((s, d) => s + d.anomaly_count, 0);
  const driftDays      = series.filter(d => d.drift_flag).length;

  // Pattern classification
  const meanEvents = totalEvents / n;
  const stddevEvents = Math.sqrt(
    series.reduce((s, d) => s + (d.events - meanEvents) ** 2, 0) / n
  );
  const cv = meanEvents > 0 ? stddevEvents / meanEvents : 0;

  let pattern: RiskPattern;
  if (meanEvents < config.sparse_threshold_events_per_day) {
    pattern = "sparse";
  } else if (trajectoryEvents > config.rising_trajectory_threshold ||
             trajectoryAnomalies > config.rising_trajectory_threshold) {
    pattern = "rising";
  } else if (cv > config.volatile_cv_threshold) {
    pattern = "volatile";
  } else {
    pattern = "stable";
  }

  return {
    total_events:            totalEvents,
    total_anomalies:         totalAnomalies,
    drift_days:              driftDays,
    series_days:             n,
    ewma_events_per_day:     round(ewmaEvents,      3),
    ewma_severity_per_event: round(ewmaSeverityPerEvent, 3),
    ewma_anomaly_rate:       round(ewmaAnomalyRate, 4),
    trajectory_events:       round(trajectoryEvents,    3),
    trajectory_severity:     round(trajectorySeverity,  3),
    trajectory_anomalies:    round(trajectoryAnomalies, 3),
    pattern,
    window: {
      from: series[0].date,
      to:   series[n - 1].date,
      days: n,
    },
  };
}

function round(x: number, places: number): number {
  const p = Math.pow(10, places);
  return Math.round(x * p) / p;
}
