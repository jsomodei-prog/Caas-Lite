/**
 * src/calibration/loader.ts
 * Loads and validates historical loss-run CSVs.
 *
 * Input format (one row per vessel-year, header row required):
 *
 *   policy_year,vessel_class,exposure_value,exposure_unit,claim_count,severity_total,premium_earned
 *   2022,Container Ship,95000,GT,0,0,1500000
 *   2022,Container Ship,98000,GT,1,450000,1620000
 *   2022,Tugboat - Harbor,320,GT,0,0,95000
 *   2023,Tugboat - Harbor,340,GT,2,180000,98000
 *
 * The loader:
 *   1. Parses the CSV (no external dep — RFC 4180 subset, no embedded quotes)
 *   2. Validates required columns and numeric ranges
 *   3. Normalizes free-form vessel_class labels to our internal keys
 *   4. Aggregates into VesselClassLossStats per class
 *
 * What this does NOT do:
 *   - Time-windowing (caller decides which years to include)
 *   - Trending (calibration step adjusts for trend separately)
 *   - IBNR adjustments (caller must use closed years only)
 *
 * No external dependencies — built-in fs + crypto only.
 */

import fs from "fs";
import type {
  LossRunRecord,
  VesselClassKey,
  VesselClassLabel,
  VesselClassLossStats,
} from "./loss-run-schema";

// ─── Label Normalization ─────────────────────────────────────────────────────

/**
 * Maps free-form vessel-class labels (as they appear in carrier data) to
 * our internal VesselClassKey. Add entries here as new carrier sources
 * are onboarded.
 *
 * Matching is case-insensitive and uses substring containment.
 */
const LABEL_NORMALIZATION: Array<{ match: string; key: VesselClassKey }> = [
  { match: "container ship",   key: "CONTAINER_SHIP" },
  { match: "container vessel", key: "CONTAINER_SHIP" },
  { match: "containership",    key: "CONTAINER_SHIP" },
  { match: "tugboat",          key: "TUGBOAT"        },
  { match: "tug ",             key: "TUGBOAT"        },
  { match: "tug-",             key: "TUGBOAT"        },
  { match: "harbor tug",       key: "TUGBOAT"        },
];

export function normalizeVesselClass(raw: VesselClassLabel): VesselClassKey | null {
  const haystack = raw.toLowerCase().trim();
  for (const { match, key } of LABEL_NORMALIZATION) {
    if (haystack.includes(match)) return key;
  }
  return null;
}

// ─── CSV Parsing ──────────────────────────────────────────────────────────────

const REQUIRED_HEADERS = [
  "policy_year",
  "vessel_class",
  "exposure_value",
  "exposure_unit",
  "claim_count",
  "severity_total",
  "premium_earned",
] as const;

interface ParseResult {
  records:  LossRunRecord[];
  skipped:  { line_number: number; reason: string }[];
}

export function parseLossRunCSV(csv: string): ParseResult {
  // Normalize line endings, drop trailing blank lines
  const lines = csv.replace(/\r\n/g, "\n").split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    throw new Error("parseLossRunCSV: input is empty");
  }

  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  for (const required of REQUIRED_HEADERS) {
    if (!header.includes(required)) {
      throw new Error(`parseLossRunCSV: missing required column "${required}"`);
    }
  }

  // Build column-index map
  const idx: Record<string, number> = {};
  header.forEach((h, i) => { idx[h] = i; });

  const records: LossRunRecord[] = [];
  const skipped: { line_number: number; reason: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const lineNo = i + 1;   // 1-indexed, accounting for header
    const cells  = lines[i].split(",").map(c => c.trim());

    if (cells.length !== header.length) {
      skipped.push({ line_number: lineNo, reason: `expected ${header.length} columns, got ${cells.length}` });
      continue;
    }

    const rec = tryParseRow(cells, idx);
    if ("error" in rec) {
      skipped.push({ line_number: lineNo, reason: rec.error });
    } else {
      records.push(rec.record);
    }
  }

  return { records, skipped };
}

function tryParseRow(
  cells: string[],
  idx: Record<string, number>
): { record: LossRunRecord } | { error: string } {
  const numeric = (name: string): number | { error: string } => {
    const raw = cells[idx[name]];
    const n   = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return { error: `"${name}" must be a non-negative number (got "${raw}")` };
    }
    return n;
  };

  const policy_year_n    = numeric("policy_year");
  if (typeof policy_year_n !== "number") return policy_year_n;
  if (policy_year_n < 1900 || policy_year_n > 2200) {
    return { error: `"policy_year" out of range (got ${policy_year_n})` };
  }

  const exposure_value_n = numeric("exposure_value");
  if (typeof exposure_value_n !== "number") return exposure_value_n;
  if (exposure_value_n === 0) {
    return { error: `"exposure_value" cannot be zero` };
  }

  const claim_count_n    = numeric("claim_count");
  if (typeof claim_count_n !== "number") return claim_count_n;
  if (!Number.isInteger(claim_count_n)) {
    return { error: `"claim_count" must be an integer (got ${claim_count_n})` };
  }

  const severity_total_n = numeric("severity_total");
  if (typeof severity_total_n !== "number") return severity_total_n;

  const premium_earned_n = numeric("premium_earned");
  if (typeof premium_earned_n !== "number") return premium_earned_n;

  const vessel_class = cells[idx["vessel_class"]];
  const exposure_unit = cells[idx["exposure_unit"]];
  if (!vessel_class) return { error: `"vessel_class" cannot be empty` };
  if (!exposure_unit) return { error: `"exposure_unit" cannot be empty` };

  return {
    record: {
      policy_year:    policy_year_n,
      vessel_class,
      exposure_value: exposure_value_n,
      exposure_unit,
      claim_count:    claim_count_n,
      severity_total: severity_total_n,
      premium_earned: premium_earned_n,
    },
  };
}

// ─── File loader ─────────────────────────────────────────────────────────────

export function loadLossRunFile(path: string): ParseResult {
  if (!fs.existsSync(path)) {
    throw new Error(`loadLossRunFile: file not found: ${path}`);
  }
  const csv = fs.readFileSync(path, "utf-8");
  return parseLossRunCSV(csv);
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Groups records by normalized vessel class and computes per-class
 * aggregate statistics. Records whose vessel_class doesn't normalize
 * are dropped; the count is returned for visibility.
 */
export function aggregateByVesselClass(records: LossRunRecord[]): {
  stats:   Map<VesselClassKey, VesselClassLossStats>;
  dropped: { vessel_class: string; rows: number }[];
} {
  const grouped = new Map<VesselClassKey, LossRunRecord[]>();
  const dropped = new Map<string, number>();

  for (const rec of records) {
    const key = normalizeVesselClass(rec.vessel_class);
    if (!key) {
      dropped.set(rec.vessel_class, (dropped.get(rec.vessel_class) ?? 0) + 1);
      continue;
    }
    const bucket = grouped.get(key) ?? [];
    bucket.push(rec);
    grouped.set(key, bucket);
  }

  const stats = new Map<VesselClassKey, VesselClassLossStats>();
  for (const [key, recs] of grouped.entries()) {
    const totalClaims    = recs.reduce((s, r) => s + r.claim_count, 0);
    const totalSeverity  = recs.reduce((s, r) => s + r.severity_total, 0);
    const totalExposure  = recs.reduce((s, r) => s + r.exposure_value, 0);
    const totalPremium   = recs.reduce((s, r) => s + r.premium_earned, 0);

    stats.set(key, {
      vessel_class_key:        key,
      total_vessel_years:      recs.length,
      total_claims:            totalClaims,
      total_severity_usd:      totalSeverity,
      total_exposure:          totalExposure,
      total_premium_earned:    totalPremium,
      claim_frequency_rate:    recs.length > 0 ? totalClaims / recs.length : 0,
      mean_severity_per_claim: totalClaims > 0 ? totalSeverity / totalClaims : null,
      loss_ratio:              totalPremium > 0 ? totalSeverity / totalPremium : 0,
      earliest_year:           Math.min(...recs.map(r => r.policy_year)),
      latest_year:             Math.max(...recs.map(r => r.policy_year)),
    });
  }

  return {
    stats,
    dropped: Array.from(dropped.entries()).map(([vessel_class, rows]) => ({ vessel_class, rows })),
  };
}
