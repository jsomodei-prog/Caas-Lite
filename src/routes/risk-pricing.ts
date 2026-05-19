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
 *     series: TimeSeriesDay[],                       // 30 entries, oldest first
 *     custom_config?: VesselClassConfig              // for "custom"
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
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { requireAccessToken } from "./auth";
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

// ─── Validation ───────────────────────────────────────────────────────────────

interface QuoteRequestBody {
  vessel_class: string;
  series:       TimeSeriesDay[];
  custom_config?: VesselClassConfig;
}

function validateSeries(series: unknown): { ok: true } | { ok: false; error: string } {
  if (!Array.isArray(series)) return { ok: false, error: "series must be an array" };
  if (series.length === 0)    return { ok: false, error: "series cannot be empty" };
  if (series.length > 365)    return { ok: false, error: "series cannot exceed 365 entries" };

  for (let i = 0; i < series.length; i++) {
    const d = series[i] as Partial<TimeSeriesDay>;
    if (typeof d?.date !== "string") return { ok: false, error: `series[${i}].date must be a string` };
    if (typeof d?.events !== "number"        || d.events < 0)        return { ok: false, error: `series[${i}].events invalid` };
    if (typeof d?.severity_sum !== "number"  || d.severity_sum < 0)  return { ok: false, error: `series[${i}].severity_sum invalid` };
    if (typeof d?.anomaly_count !== "number" || d.anomaly_count < 0) return { ok: false, error: `series[${i}].anomaly_count invalid` };
    if (typeof d?.drift_flag !== "boolean")  return { ok: false, error: `series[${i}].drift_flag must be boolean` };
  }
  return { ok: true };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function quote(req: Request, res: Response): Promise<void> {
  const body = req.body as QuoteRequestBody;

  if (!body || typeof body.vessel_class !== "string") {
    res.status(400).json({ error: "vessel_class is required" });
    return;
  }

  const seriesCheck = validateSeries(body.series);
  if (!seriesCheck.ok) {
    res.status(400).json({ error: seriesCheck.error });
    return;
  }

  // Resolve vessel class config
  let config: VesselClassConfig;
  if (body.vessel_class === "custom") {
    if (!body.custom_config) {
      res.status(400).json({ error: "custom_config required when vessel_class is 'custom'" });
      return;
    }
    config = body.custom_config;
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

  const profile = buildRiskProfile(body.series, DEFAULT_RISK_CONFIG);
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
  router.post("/quote", async_(quote));

  return router;
}

export default createRiskPricingRouter;
