# Underwriting Calibration

**Audience:** the actuary or underwriter who provides loss-run data, plus the engineer who runs the calibration pipeline.

## What this is

The pricing constants in `src/lib/vessel-classes.ts` are placeholders. This document describes how to replace them with values fitted to real loss history.

## How calibration works

```
loss-run.csv  →  loader  →  per-class stats  →  fitter  →  CalibratedConfig
                                                                  ↓
                                                              validator
                                                                  ↓
                                              promotion (rewrite vessel-classes.ts)
```

Each stage is a separate, testable module:

- **`src/calibration/loader.ts`** — parses CSVs, normalizes vessel-class labels, aggregates per-class
- **`src/calibration/fitter.ts`** — transforms statistics into pricing coefficients
- **`scripts/calibrate.ts`** — CLI wrapping the pipeline

## Input format

One CSV per loss run. Required columns (case-insensitive header):

| Column | Type | Notes |
|---|---|---|
| `policy_year` | integer | 1900–2200 |
| `vessel_class` | text | normalized to internal key (see below) |
| `exposure_value` | number > 0 | gross tonnage for marine hull |
| `exposure_unit` | text | "GT" expected |
| `claim_count` | integer ≥ 0 | per vessel-year |
| `severity_total` | number ≥ 0 | sum of paid + outstanding, USD |
| `premium_earned` | number ≥ 0 | earned premium, USD |

One row per vessel-year. A vessel with multiple claims in one year is **one row** with summed severity.

A sample file lives at `data/calibration/sample-loss-run.csv` — use it for testing only, never as production input.

## Vessel-class label normalization

Free-form labels in the CSV are matched (case-insensitive substring) against:

| Pattern in CSV | Mapped to |
|---|---|
| "container ship" / "container vessel" / "containership" | `CONTAINER_SHIP` |
| "tugboat" / "tug " / "tug-" / "harbor tug" | `TUGBOAT` |

Unrecognized labels are dropped with a count in the output. To add support for a new class:

1. Add a mapping to `LABEL_NORMALIZATION` in `src/calibration/loader.ts`
2. Add the new key to `VesselClassKey` in `src/calibration/loss-run-schema.ts`
3. Add a default config export to `src/lib/vessel-classes.ts`

## The fitter

The fitter takes per-class statistics and emits coefficients. Currently only one fitter exists:

- **`nullFitter`** — returns the hardcoded values from `vessel-classes.ts` unchanged, stamped with provenance saying "no fitting was performed."

This is the right fitter to use:
- For pipeline smoke tests
- Before a real actuarial fit exists
- To verify the promotion workflow doesn't break anything

It is the **wrong** fitter to use for production. Output from `nullFitter` is identical to what's already in code and conveys no information about real-world loss behaviour.

### Writing a real fitter

A real fitter implements the `Fitter` type:

```typescript
type Fitter = (stats: VesselClassLossStats) => CalibratedConfig;
```

A real fitter typically uses:

- **Claim frequency** → curve-fit to derive `freq_anchor` (the frequency at which the multiplier equals 1) and `k_freq` (the slope of the response).
- **Mean severity per claim** → similar fit for `sev_anchor` and `k_sev`.
- **Loss ratio analysis across vessel-years** → calibrate `base_rate_per_exposure_day` against historical premium adequacy.
- **Quantile analysis of yearly variation** → derive pattern multipliers (`stable`, `rising`, `volatile`, `sparse`).

These are real actuarial methods. Maximum likelihood estimation, GLM with claim count as Poisson, severity as Gamma. The choice depends on:

- Data volume (≥1000 vessel-years per class for stable fits)
- Tail behaviour (severity distributions in marine are often Pareto-shaped)
- Trend (claim costs inflate; the fitter must adjust)
- Mix shift (the vessels written today may differ from those in the loss run)

None of this work belongs in this codebase. It belongs in an actuarial environment (R, Python, or specialist tools like Tyche). The fitter exposed here is the **interface** that work plugs into.

## Validation

`validateCalibratedConfig` checks plausibility ranges. Errors block promotion; warnings are printed and the operator decides.

**Hard errors** (script exits non-zero):
- Negative coefficients
- Zero anchors
- Non-positive base rate
- Non-positive exposure or coverage_days
- Pattern multiplier ≤ 0

**Warnings** (printed, do not block):
- Base rate outside [0.01, 100] USD/exposure/day
- `k_freq` > 2 or `k_sev` > 3 (very steep)
- Pattern multiplier outside [0.5, 5.0]
- `k_anom` > 50
- Input vessel-years < 50 (small-sample fit)

If you're confident in a warning override, run with `--apply` anyway. The validation output is recorded in the calibration provenance.

## Running the pipeline

### Dry run

```bash
ts-node scripts/calibrate.ts data/calibration/sample-loss-run.csv
```

Prints:
- Number of records parsed and skipped
- Per-class aggregate statistics
- Validation results
- Preview of what would be written

### Apply

```bash
ts-node scripts/calibrate.ts data/calibration/your-real-loss-run.csv --apply
```

Rewrites `src/lib/vessel-classes.ts`. The file's docstring header is regenerated with provenance for every class.

**After apply:**

```bash
git diff src/lib/vessel-classes.ts        # review changes
npm test                                  # confirm tests still pass
npx jest tests/risk-pricing-simulation    # confirm the simulation produces sane premium output
git commit -am "Calibrate vessel-classes against <loss-run-name>"
```

## Promotion to a DB table (future)

The current promotion writes coefficients to `vessel-classes.ts`. This means every calibration is a code change, which is appropriate while calibration is rare and reviewer-gated.

Once calibration happens quarterly or more often, move coefficients into a `vessel_class_configs` table. The pricing function looks them up at request time. This unlocks:

- Recalibrate without deploy
- A/B test calibrations
- Per-tenant calibration overrides

The migration is small (one table + a query in `priceFromProfile`). The new file structure should match the existing one closely so the diff is reviewable.

## Things that are NOT addressed here

- **Reserving** — IBNR (incurred but not reported) loss estimates require triangulation methods (Chain Ladder, Bornhuetter-Ferguson). Out of scope.
- **Trend adjustments** — claim costs inflate over time. The fitter should apply a trend factor; the framework here doesn't impose one.
- **Catastrophe modeling** — tail events (storms, named perils) require separate cat models. This pipeline assumes attritional losses only.
- **Reinsurance retention** — gross-up / cede calculations belong outside this pipeline.

These are the kinds of refinements an actuary brings. The codebase provides the seams; the science is theirs.
