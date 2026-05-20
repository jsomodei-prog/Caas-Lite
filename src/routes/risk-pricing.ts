/**
 * src/routes/risk-pricing.ts
 * Phase 15 — endpoint wrapper for the risk profile + premium pricing pipeline.
 *
 * Endpoint (JWT-authenticated):
 *   POST /api/v1/risk-pricing/quote
 *
 * Body:
 *   {
 *     vessel_class: "CONTAINER_SHIP" | "TUGBOAT",   // or "custom" with config
 *     series: TimeSeriesDay[],                       // 1..365 entries, oldest first
 *     custom_config?: VesselClassConfig              // required iff vessel_class === "custom"
 *   }
 *
 * Response:
 *   {
 *     profile: RiskProfile,
 *     quote:   PremiumQuote
 *   }
 *
 * The endpoint is pure compute — no DB writes, no side effects, no audit log.
 * It's a calculator. State (saving a quote, binding to a policy) is a separate
 * concern handled by src/routes/insurance.ts.
 *
 * Phase 15 slice 7:
 *   - Replaced handwritten validateSeries() and the typeof / empty-body guards
 *     with a Zod schema (QuoteBody) applied via the validate() middleware.
 *   - vessel_class === "custom" cross-field check is RETAINED inline because
 *     it preserves a specific user-facing error message and is the same
 *     ergonomic choice the enumeration doc flagged as "implementation session's
 *     call". Could be moved into a .refine() if the schema becomes the single
 *     source of truth.
 *   - VESSEL_CLASSES registry lookup is RETAINED inline because new vessel
 *     classes are designed to be added over time without touching the schema.
 *
 * Pre-merge checks the implementation session should run:
 *   - npm test (the preflight + this file's tests must still pass)
 *   - grep -r validateSeries src/  — must return no matches outside this file
 *     (the function was not exported; if anything imported it, that broke)
 *   - Verify app.ts mounts this router unchanged
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { requireAccessToken } from "./auth";
import { validate } from "../middleware/validate";
import {
  buildRiskProfile,
  DEFAULT_RISK_CONFIG,
  type TimeSeriesDay,
} from "../lib/risk-profile";
import {
  priceFromProfile,
  type VesselClassConfig,
} from "../lib/premium-pricing";
import {
  CONTAINER_SHIP_CONFIG,
  TUGBOAT_CONFIG,
} from "../lib/vessel-classes";

// ─── Vessel class lookup ──────────────────────────────────────────────────────

const VESSEL_CLASSES: Record<string, VesselClassConfig> = {
  CONTAINER_SHIP: CONTAINER_SHIP_CONFIG,
  TUGBOAT:        TUGBOAT_CONFIG,
};

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * One day of the input time series.
 *
 * The shape mirrors TimeSeriesDay from ../lib/risk-profile. We cannot import
 * a Zod-generated schema for that type because risk-profile.ts exposes only
 * the TypeScript type; the schema lives here and is checked structurally.
 *
 * Constraints come from the legacy validateSeries() function:
 *   - date must be a string (no further format check; legacy did not enforce
 *     ISO 8601, and tightening would be a behavior change flagged for a
 *     future hardening pass — see slice 7 enumeration doc, risk-pricing.ts
 *     NOTE 3).
 *   - events / severity_sum / anomaly_count must be non-negative finite numbers.
 *   - drift_flag must be a boolean.
 */
const TimeSeriesDaySchema = z.object({
  date:          z.string().min(1),
  events:        z.number().nonnegative().finite(),
  severity_sum:  z.number().nonnegative().finite(),
  anomaly_count: z.number().nonnegative().finite(),
  drift_flag:    z.boolean(),
}).strict();

/**
 * Body schema for POST /quote.
 *
 * - vessel_class is z.string().min(1) rather than z.enum([...]) because the
 *   VESSEL_CLASSES registry is designed to grow. Validity of the specific
 *   string is gated by the registry lookup in the handler, which returns 400
 *   with the available classes listed (better UX than a Zod enum error for
 *   discoverability). See enumeration doc NOTE 1.
 *
 * - custom_config is z.record(z.unknown()) because VesselClassConfig from
 *   ../lib/premium-pricing is a structured type we have not schema'd in this
 *   slice. The handler passes it through to priceFromProfile() which performs
 *   its own internal validation. Tightening this to a proper schema is flagged
 *   as a follow-up (enumeration doc NOTE 2). The handler does an `as` cast at
 *   the call site to satisfy TypeScript.
 *
 * - series upper bound (365) mirrors legacy validateSeries; lower bound (1)
 *   mirrors the legacy "cannot be empty" check.
 */
const QuoteBody = z.object({
  vessel_class:  z.string().min(1),
  series:        z.array(TimeSeriesDaySchema).min(1).max(365),
  custom_config: z.record(z.unknown()).optional(),
}).strict();

type QuoteBodyType = z.infer<typeof QuoteBody>;

// ─── Handler ──────────────────────────────────────────────────────────────────

async function quote(req: Request, res: Response): Promise<void> {
  // After validate({ body: QuoteBody }), req.body is the parsed, typed shape.
  // The cast here is a local convenience — Zod's inferred type does not
  // automatically flow onto express.Request without an augmentation we
  // haven't added in slice 7.
  const body = req.body as QuoteBodyType;

  // Resolve vessel class config.
  //
  // Two checks RETAINED from the legacy handler — both express semantic
  // (not just shape) intent and have specific user-facing error messages
  // the Zod schema does not produce:
  //   1. "custom" requires custom_config (cross-field rule).
  //   2. Unknown vessel_class string returns the list of available classes
  //      so the caller knows what to try next.
  let config: VesselClassConfig;
  if (body.vessel_class === "custom") {
    if (!body.custom_config) {
      res.status(400).json({
        error: "custom_config required when vessel_class is 'custom'",
      });
      return;
    }
    // See QuoteBody.custom_config NOTE: we accept z.record(z.unknown()) and
    // cast at the boundary. priceFromProfile validates the structure itself.
    config = body.custom_config as VesselClassConfig;
  } else {
    const found = VESSEL_CLASSES[body.vessel_class];
    if (!found) {
      res.status(400).json({
        error: `Unknown vessel_class. Available: ${Object.keys(VESSEL_CLASSES).join(", ")}, or 'custom'`,
      });
      return;
    }
    config = found;
  }

  // series is already validated by Zod to be a non-empty TimeSeriesDay[].
  // The cast satisfies buildRiskProfile's parameter type — z.infer produces
  // a structurally compatible shape but TypeScript needs the nominal hint.
  const profile = buildRiskProfile(body.series as TimeSeriesDay[], DEFAULT_RISK_CONFIG);
  const premium = priceFromProfile(profile, config, {
    calibration_status: "PLACEHOLDER",
  });

  res.json({
    profile,
    quote: premium,
    // Surfaced at top level too so consumers can't miss it.
    calibration_status: "PLACEHOLDER",
    warning: "All coefficients in this quote are placeholder values. Do not use for binding.",
  });
}

// ─── Router Assembly ──────────────────────────────────────────────────────────

export function createRiskPricingRouter(): Router {
  const router = Router();

  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  router.use(requireAccessToken);

  // validate({ body: QuoteBody }) runs BEFORE the async handler. On failure
  // it calls next(AppError.badRequest(...)) which the global error handler
  // serializes; the async handler is never invoked.
  router.post("/quote", validate({ body: QuoteBody }), async_(quote));

  return router;
}

// Exported for tests that want to assert the schema directly without
// constructing an Express request.
export { QuoteBody, TimeSeriesDaySchema };

export default createRiskPricingRouter;
