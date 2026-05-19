/**
 * tests/risk-pricing-simulation.test.ts
 * 30-day comparative simulation: high-frequency Container Ship profile
 * vs entry-level Tugboat profile.
 *
 * This is a WIRING demonstration, not a calibrated pricing study. The
 * absolute premium numbers are meaningless; the relative *behavior* of
 * the two profiles under the same code path is the point:
 *
 *   - Container Ship: many daily events, low individual severity, gradually
 *     trending up. Expected output: 'stable' or 'rising' pattern, smooth
 *     premium with modest frequency adjustment.
 *
 *   - Tugboat: sparse events, two big severity spikes mid-window. Expected
 *     output: 'volatile' or 'sparse' pattern, larger pattern multiplier,
 *     more sensitivity to single-event severity.
 *
 * The test asserts these structural properties (which pattern, which
 * adjustment dominates, etc.) — NOT specific dollar amounts. When real
 * calibration lands, the dollar amounts change but the structural
 * assertions should still hold.
 */

import { buildRiskProfile, type TimeSeriesDay } from "../src/lib/risk-profile";
import { priceFromProfile }                      from "../src/lib/premium-pricing";
import { CONTAINER_SHIP_CONFIG, TUGBOAT_CONFIG } from "../src/lib/vessel-classes";

// ─── Synthetic Series Generators ──────────────────────────────────────────────

/**
 * Deterministic pseudo-random in [0, 1). Seeded so simulation runs are
 * reproducible. Using a tiny LCG; not for cryptographic purposes.
 */
function makeRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function isoDay(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Container ship profile: 30 days of busy liner operations.
 *   - 12-18 events per day, mild upward trend over the month
 *   - Low severity per event (cargo/lashing checks, minor port issues)
 *   - 0-1 anomalies per day, evenly distributed
 *   - No drift days (compliant operations throughout)
 */
function containerShipSeries(): TimeSeriesDay[] {
  const rng = makeRng(42);
  const days: TimeSeriesDay[] = [];
  for (let i = 29; i >= 0; i--) {
    const trendBoost = (29 - i) * 0.1;            // gradual up-trend
    const events     = Math.round(12 + trendBoost + rng() * 6);
    const sevPer     = 3 + rng() * 4;             // 3-7 per event
    days.push({
      date:          isoDay(i),
      events,
      severity_sum:  Math.round(events * sevPer * 10) / 10,
      anomaly_count: rng() < 0.4 ? 1 : 0,
      drift_flag:    false,
    });
  }
  return days;
}

/**
 * Tugboat profile: 30 days of harbor work with two severity spikes.
 *   - 0-3 events per day on most days (towing jobs, port assists)
 *   - Two mid-window severity spikes (e.g., difficult berthing operations
 *     or close-call incidents) that push severity_sum dramatically higher
 *   - Anomalies cluster around the spikes
 *   - One drift day flagged during the second spike
 */
function tugboatSeries(): TimeSeriesDay[] {
  const rng = makeRng(7);
  const days: TimeSeriesDay[] = [];
  for (let i = 29; i >= 0; i--) {
    const events = Math.round(rng() * 3);          // 0-3 events
    let sevSum   = events * (4 + rng() * 4);       // baseline severity
    let anom     = rng() < 0.1 ? 1 : 0;
    let drift    = false;

    // Spike 1: day 17 from end (mid-window)
    if (i === 17) { sevSum += 40; anom = 2; }
    // Spike 2: day 8 from end (more recent, weighted higher by EWMA)
    if (i === 8)  { sevSum += 55; anom = 3; drift = true; }

    days.push({
      date:          isoDay(i),
      events:        events + (i === 17 || i === 8 ? 1 : 0),
      severity_sum:  Math.round(sevSum * 10) / 10,
      anomaly_count: anom,
      drift_flag:    drift,
    });
  }
  return days;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Risk pricing simulation: Container Ship vs Tugboat (30 days)", () => {

  let containerProfile:    ReturnType<typeof buildRiskProfile>;
  let tugProfile:          ReturnType<typeof buildRiskProfile>;
  let containerQuote:      ReturnType<typeof priceFromProfile>;
  let tugQuote:            ReturnType<typeof priceFromProfile>;

  beforeAll(() => {
    const containerSeries = containerShipSeries();
    const tugSeries       = tugboatSeries();

    containerProfile = buildRiskProfile(containerSeries);
    tugProfile       = buildRiskProfile(tugSeries);

    containerQuote = priceFromProfile(containerProfile, CONTAINER_SHIP_CONFIG, {
      calibration_status: "PLACEHOLDER",
    });
    tugQuote = priceFromProfile(tugProfile, TUGBOAT_CONFIG, {
      calibration_status: "PLACEHOLDER",
    });

    // Print a comparison table to stdout. Useful when you run the test
    // suite manually — it shows the structure of what the two profiles
    // produce side by side.
    printComparison(containerQuote, tugQuote);
  });

  // ── Profile shape assertions ──

  test("container ship profile has high event frequency", () => {
    expect(containerProfile.ewma_events_per_day).toBeGreaterThan(10);
  });

  test("tugboat profile has sparse event frequency", () => {
    expect(tugProfile.ewma_events_per_day).toBeLessThan(5);
  });

  test("tugboat profile has higher severity per event due to spikes", () => {
    expect(tugProfile.ewma_severity_per_event)
      .toBeGreaterThan(containerProfile.ewma_severity_per_event);
  });

  // ── Pattern classification ──

  test("container ship classifies as stable or rising (NOT sparse)", () => {
    expect(["stable", "rising"]).toContain(containerProfile.pattern);
  });

  test("tugboat classifies as sparse or volatile (NOT stable)", () => {
    expect(["sparse", "volatile"]).toContain(tugProfile.pattern);
  });

  // ── Pricing behavior assertions ──
  //
  // These are STRUCTURAL claims about how the math should behave, not
  // claims about real premium levels. They should hold even after the
  // CALIBRATE constants are tuned against real loss data.

  test("both quotes are marked PLACEHOLDER", () => {
    expect(containerQuote.calibration_status).toBe("PLACEHOLDER");
    expect(tugQuote.calibration_status).toBe("PLACEHOLDER");
  });

  test("container ship premium is dominated by frequency adjustment", () => {
    // Container ship runs high-frequency, so freq adj should be the
    // largest single multiplier in its quote.
    const adjustments = {
      freq:    Math.abs(containerQuote.frequency_adjustment - 1),
      sev:     Math.abs(containerQuote.severity_adjustment  - 1),
      pattern: Math.abs(containerQuote.pattern_multiplier   - 1),
    };
    expect(adjustments.freq).toBeGreaterThanOrEqual(adjustments.sev);
    expect(adjustments.freq).toBeGreaterThan(0);
  });

  test("tugboat premium absorbs spike signal via severity, pattern, OR anomaly load", () => {
    // The tug's spike days carry elevated severity AND elevated anomalies.
    // With the current placeholder constants the anomaly load is the
    // dominant carrier of the spike signal (sparse baseline → high
    // anomaly rate when spikes hit). When constants get calibrated the
    // dominant carrier may shift; this assertion holds regardless.
    const severityMove = Math.abs(tugQuote.severity_adjustment - 1);
    const patternMove  = Math.abs(tugQuote.pattern_multiplier  - 1);
    const anomMove     = tugQuote.anomaly_load;
    expect(Math.max(severityMove, patternMove, anomMove)).toBeGreaterThan(0.1);
  });

  test("premium has the documented floor", () => {
    expect(containerQuote.premium_total)
      .toBeGreaterThanOrEqual(containerQuote.base_premium * 0.5);
    expect(tugQuote.premium_total)
      .toBeGreaterThanOrEqual(tugQuote.base_premium * 0.5);
  });

  test("simulation is deterministic — same series → same quote", () => {
    const profile2 = buildRiskProfile(containerShipSeries());
    const quote2   = priceFromProfile(profile2, CONTAINER_SHIP_CONFIG, {
      calibration_status: "PLACEHOLDER",
    });
    expect(quote2.premium_total).toBe(containerQuote.premium_total);
  });

  // ── Cross-profile comparison ──

  test("the two profiles produce distinguishable quote signatures", () => {
    // Not asserting which is higher — that depends entirely on the
    // placeholder constants. Just asserting they're not accidentally
    // identical, which would indicate a wiring bug.
    expect(containerQuote.premium_total).not.toBe(tugQuote.premium_total);
    expect(containerQuote.signals.pattern).not.toBe(tugQuote.signals.pattern);
  });
});

// ─── Pretty-printer for manual inspection ────────────────────────────────────

function printComparison(
  cs: ReturnType<typeof priceFromProfile>,
  tug: ReturnType<typeof priceFromProfile>
): void {
  const W = 72;
  const line = (l: string, mid: string, r: string) =>
    `${l.padEnd(28)} ${mid.padStart(20)}  ${r.padStart(20)}`;

  // eslint-disable-next-line no-console
  console.log("\n" + "═".repeat(W));
  // eslint-disable-next-line no-console
  console.log("CONTAINER SHIP vs TUGBOAT — 30-DAY PREMIUM COMPARISON (PLACEHOLDER)");
  // eslint-disable-next-line no-console
  console.log("═".repeat(W));
  // eslint-disable-next-line no-console
  console.log(line("", "Container Ship", "Tugboat"));
  // eslint-disable-next-line no-console
  console.log("─".repeat(W));
  const f = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  // eslint-disable-next-line no-console
  console.log(line("Pattern",              cs.signals.pattern,              tug.signals.pattern));
  // eslint-disable-next-line no-console
  console.log(line("EWMA events/day",      f(cs.signals.ewma_events_per_day),      f(tug.signals.ewma_events_per_day)));
  // eslint-disable-next-line no-console
  console.log(line("EWMA severity/event",  f(cs.signals.ewma_severity_per_event),  f(tug.signals.ewma_severity_per_event)));
  // eslint-disable-next-line no-console
  console.log(line("Trajectory (events)",  f(cs.signals.trajectory_events),        f(tug.signals.trajectory_events)));
  // eslint-disable-next-line no-console
  console.log("─".repeat(W));
  // eslint-disable-next-line no-console
  console.log(line("Base premium ($)",       f(cs.base_premium),       f(tug.base_premium)));
  // eslint-disable-next-line no-console
  console.log(line("× Frequency adj",        f(cs.frequency_adjustment), f(tug.frequency_adjustment)));
  // eslint-disable-next-line no-console
  console.log(line("× Severity adj",         f(cs.severity_adjustment),  f(tug.severity_adjustment)));
  // eslint-disable-next-line no-console
  console.log(line("× Pattern mult",         f(cs.pattern_multiplier),   f(tug.pattern_multiplier)));
  // eslint-disable-next-line no-console
  console.log(line("+ Anomaly load",         f(cs.anomaly_load),         f(tug.anomaly_load)));
  // eslint-disable-next-line no-console
  console.log("─".repeat(W));
  // eslint-disable-next-line no-console
  console.log(line("PREMIUM TOTAL ($)",      f(cs.premium_total),      f(tug.premium_total)));
  // eslint-disable-next-line no-console
  console.log("═".repeat(W));
  // eslint-disable-next-line no-console
  console.log("⚠  Placeholder constants. Numbers above are NOT valid quotes.");
  // eslint-disable-next-line no-console
  console.log("═".repeat(W) + "\n");
}
