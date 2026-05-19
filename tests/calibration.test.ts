/**
 * tests/calibration.test.ts
 * Tests for the calibration pipeline.
 *
 * Validates:
 *   1. CSV parser handles valid + invalid input correctly
 *   2. Label normalization maps known patterns and rejects unknown
 *   3. Aggregation produces correct per-class statistics
 *   4. nullFitter returns config matching the existing hardcoded constants
 *   5. validateCalibratedConfig catches negative, zero, and out-of-range values
 */

import path from "path";
import {
  parseLossRunCSV,
  loadLossRunFile,
  normalizeVesselClass,
  aggregateByVesselClass,
} from "../src/calibration/loader";
import {
  nullFitter,
  validateCalibratedConfig,
  partitionProblems,
} from "../src/calibration/fitter";
import {
  CONTAINER_SHIP_CONFIG,
  TUGBOAT_CONFIG,
} from "../src/lib/vessel-classes";

// ─── CSV parsing ──────────────────────────────────────────────────────────────

describe("parseLossRunCSV", () => {
  test("parses a minimal valid CSV", () => {
    const csv = [
      "policy_year,vessel_class,exposure_value,exposure_unit,claim_count,severity_total,premium_earned",
      "2023,Container Ship,100000,GT,1,500000,1500000",
    ].join("\n");
    const { records, skipped } = parseLossRunCSV(csv);
    expect(records).toHaveLength(1);
    expect(skipped).toHaveLength(0);
    expect(records[0]).toMatchObject({
      policy_year: 2023,
      vessel_class: "Container Ship",
      exposure_value: 100000,
      claim_count: 1,
    });
  });

  test("rejects empty input", () => {
    expect(() => parseLossRunCSV("")).toThrow(/empty/);
  });

  test("rejects header missing required columns", () => {
    expect(() => parseLossRunCSV("policy_year,foo\n2023,bar")).toThrow(/missing required column/);
  });

  test("skips rows with negative numerics, reports reason", () => {
    const csv = [
      "policy_year,vessel_class,exposure_value,exposure_unit,claim_count,severity_total,premium_earned",
      "2023,Container Ship,100000,GT,1,500000,1500000",
      "2023,Container Ship,-1000,GT,0,0,500000",
    ].join("\n");
    const { records, skipped } = parseLossRunCSV(csv);
    expect(records).toHaveLength(1);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/exposure_value/);
  });

  test("skips rows with non-integer claim_count", () => {
    const csv = [
      "policy_year,vessel_class,exposure_value,exposure_unit,claim_count,severity_total,premium_earned",
      "2023,Container Ship,100000,GT,1.5,500000,1500000",
    ].join("\n");
    const { records, skipped } = parseLossRunCSV(csv);
    expect(records).toHaveLength(0);
    expect(skipped[0].reason).toMatch(/integer/);
  });

  test("handles trailing blank lines and \\r\\n line endings", () => {
    const csv =
      "policy_year,vessel_class,exposure_value,exposure_unit,claim_count,severity_total,premium_earned\r\n" +
      "2023,Container Ship,100000,GT,0,0,1500000\r\n" +
      "\r\n\r\n";
    const { records } = parseLossRunCSV(csv);
    expect(records).toHaveLength(1);
  });
});

// ─── Normalization ────────────────────────────────────────────────────────────

describe("normalizeVesselClass", () => {
  test.each([
    ["Container Ship",      "CONTAINER_SHIP"],
    ["container vessel",    "CONTAINER_SHIP"],
    ["CONTAINERSHIP - MAX", "CONTAINER_SHIP"],
    ["Tugboat - Harbor",    "TUGBOAT"],
    ["Tug Operations",      "TUGBOAT"],
    ["harbor tug",          "TUGBOAT"],
  ])("normalizes '%s' to %s", (input, expected) => {
    expect(normalizeVesselClass(input)).toBe(expected);
  });

  test("returns null for unknown labels", () => {
    expect(normalizeVesselClass("Bulk Carrier")).toBeNull();
    expect(normalizeVesselClass("")).toBeNull();
  });
});

// ─── Aggregation ──────────────────────────────────────────────────────────────

describe("aggregateByVesselClass", () => {
  test("groups records and computes correct stats", () => {
    const records = [
      { policy_year: 2022, vessel_class: "Container Ship", exposure_value: 100000, exposure_unit: "GT", claim_count: 1, severity_total: 500000, premium_earned: 1500000 },
      { policy_year: 2022, vessel_class: "Container Ship", exposure_value: 100000, exposure_unit: "GT", claim_count: 0, severity_total: 0,      premium_earned: 1500000 },
      { policy_year: 2023, vessel_class: "Tugboat - Harbor", exposure_value: 300, exposure_unit: "GT", claim_count: 1, severity_total: 200000, premium_earned: 90000 },
    ];
    const { stats, dropped } = aggregateByVesselClass(records);

    expect(stats.size).toBe(2);
    expect(dropped).toHaveLength(0);

    const cs = stats.get("CONTAINER_SHIP")!;
    expect(cs.total_vessel_years).toBe(2);
    expect(cs.total_claims).toBe(1);
    expect(cs.claim_frequency_rate).toBe(0.5);
    expect(cs.mean_severity_per_claim).toBe(500000);
    expect(cs.loss_ratio).toBeCloseTo(500000 / 3000000, 5);

    const tug = stats.get("TUGBOAT")!;
    expect(tug.total_vessel_years).toBe(1);
    expect(tug.mean_severity_per_claim).toBe(200000);
  });

  test("reports dropped unmapped labels", () => {
    const records = [
      { policy_year: 2023, vessel_class: "Bulk Carrier", exposure_value: 1000, exposure_unit: "GT", claim_count: 0, severity_total: 0, premium_earned: 50000 },
    ];
    const { stats, dropped } = aggregateByVesselClass(records);
    expect(stats.size).toBe(0);
    expect(dropped).toEqual([{ vessel_class: "Bulk Carrier", rows: 1 }]);
  });

  test("mean_severity_per_claim is null when no claims", () => {
    const records = [
      { policy_year: 2023, vessel_class: "Container Ship", exposure_value: 100000, exposure_unit: "GT", claim_count: 0, severity_total: 0, premium_earned: 1500000 },
    ];
    const { stats } = aggregateByVesselClass(records);
    expect(stats.get("CONTAINER_SHIP")!.mean_severity_per_claim).toBeNull();
  });
});

// ─── nullFitter ───────────────────────────────────────────────────────────────

describe("nullFitter", () => {
  test("returns CONTAINER_SHIP_CONFIG unchanged", () => {
    const stats = {
      vessel_class_key: "CONTAINER_SHIP" as const,
      total_vessel_years: 100, total_claims: 5, total_severity_usd: 2500000,
      total_exposure: 10000000, total_premium_earned: 150000000,
      claim_frequency_rate: 0.05, mean_severity_per_claim: 500000,
      loss_ratio: 0.017, earliest_year: 2019, latest_year: 2023,
    };
    const result = nullFitter(stats);
    expect(result.vessel_class_key).toBe("CONTAINER_SHIP");
    // Same coefficients as the hardcoded constant
    expect(result.config.base_rate_per_exposure_day).toBe(CONTAINER_SHIP_CONFIG.base_rate_per_exposure_day);
    expect(result.config.k_freq).toBe(CONTAINER_SHIP_CONFIG.k_freq);
    expect(result.config.k_sev).toBe(CONTAINER_SHIP_CONFIG.k_sev);
    expect(result.provenance.fitter_name).toBe("nullFitter");
    expect(result.provenance.notes).toMatch(/PLACEHOLDER/);
  });

  test("returns TUGBOAT_CONFIG for tugboat input", () => {
    const stats = {
      vessel_class_key: "TUGBOAT" as const,
      total_vessel_years: 80, total_claims: 7, total_severity_usd: 1400000,
      total_exposure: 25000, total_premium_earned: 7200000,
      claim_frequency_rate: 0.0875, mean_severity_per_claim: 200000,
      loss_ratio: 0.194, earliest_year: 2020, latest_year: 2023,
    };
    const result = nullFitter(stats);
    expect(result.config.k_freq).toBe(TUGBOAT_CONFIG.k_freq);
    expect(result.config.pattern_multipliers.rising).toBe(TUGBOAT_CONFIG.pattern_multipliers.rising);
  });
});

// ─── Validation ───────────────────────────────────────────────────────────────

describe("validateCalibratedConfig", () => {
  function baseCalibration() {
    return {
      vessel_class_key: "CONTAINER_SHIP" as const,
      config: { ...CONTAINER_SHIP_CONFIG },
      provenance: {
        fitter_name: "test", fitter_version: "0",
        input_vessel_years: 200, input_year_range: [2019, 2023] as [number, number],
        fit_timestamp: "2026-05-19T00:00:00Z",
      },
    };
  }

  test("clean config produces no errors", () => {
    const problems = validateCalibratedConfig(baseCalibration());
    const { errors } = partitionProblems(problems);
    expect(errors).toHaveLength(0);
  });

  test("flags negative k_freq as error", () => {
    const c = baseCalibration();
    c.config.k_freq = -0.1;
    const { errors } = partitionProblems(validateCalibratedConfig(c));
    expect(errors.some(e => e.field === "k_freq")).toBe(true);
  });

  test("flags zero freq_anchor as error", () => {
    const c = baseCalibration();
    c.config.freq_anchor = 0;
    const { errors } = partitionProblems(validateCalibratedConfig(c));
    expect(errors.some(e => e.field === "freq_anchor")).toBe(true);
  });

  test("flags out-of-range pattern multiplier as warning, not error", () => {
    const c = baseCalibration();
    c.config.pattern_multipliers = { ...c.config.pattern_multipliers, rising: 6.0 };
    const { errors, warnings } = partitionProblems(validateCalibratedConfig(c));
    expect(errors).toHaveLength(0);
    expect(warnings.some(w => w.field.includes("rising"))).toBe(true);
  });

  test("flags <50 vessel-years as warning", () => {
    const c = baseCalibration();
    c.provenance.input_vessel_years = 30;
    const { warnings } = partitionProblems(validateCalibratedConfig(c));
    expect(warnings.some(w => w.field.includes("input_vessel_years"))).toBe(true);
  });
});

// ─── Sample CSV end-to-end ───────────────────────────────────────────────────

describe("sample loss run", () => {
  test("loads, aggregates, and fits without errors", () => {
    const csvPath = path.resolve(__dirname, "..", "data", "calibration", "sample-loss-run.csv");
    const { records, skipped } = loadLossRunFile(csvPath);

    expect(records.length).toBeGreaterThan(0);
    expect(skipped).toHaveLength(0);

    const { stats } = aggregateByVesselClass(records);
    expect(stats.size).toBe(2);
    expect(stats.has("CONTAINER_SHIP")).toBe(true);
    expect(stats.has("TUGBOAT")).toBe(true);

    for (const s of stats.values()) {
      const calibrated = nullFitter(s);
      const { errors } = partitionProblems(validateCalibratedConfig(calibrated));
      // nullFitter returns the existing hardcoded constants which we know pass.
      // Allow warnings (sample has small N), but never errors.
      expect(errors).toHaveLength(0);
    }
  });
});
