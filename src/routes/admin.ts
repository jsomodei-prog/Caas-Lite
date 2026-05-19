/**
 * src/routes/admin.ts
 * Business-plane admin endpoints. Currently small — just the external
 * cron entry point for warranty recompute. Grows as other "operator
 * action" surfaces emerge (forced badge re-sync, manual reinstatement,
 * etc.).
 *
 * Endpoint:
 *   POST /api/v1/admin/recompute-all
 *
 * Auth:
 *   - Requires JWT with plane_role === 'global_super_admin' on the user
 *     record in the database (looked up by the JWT 'sub' claim).
 *   - For cron-style automated callers, mint a long-lived JWT against
 *     the platform super-admin and inject it as the cron job's auth
 *     header. Rotate that JWT via standard auth flows.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import type { Database as DB } from "better-sqlite3";
import { requireAccessToken } from "./auth";
import { requireBusinessPlane } from "../middleware/dualPlaneAuth";
import { recomputeAllWarranties } from "../lib/recompute-scheduler";

// ─── Handler ──────────────────────────────────────────────────────────────────

async function recomputeAll(req: Request, res: Response): Promise<void> {
  const db = (req.app.locals as { db: DB }).db;
  const summary = recomputeAllWarranties(db);
  res.json(summary);
}

// ─── Router Assembly ──────────────────────────────────────────────────────────

export function createAdminRouter(): Router {
  const router = Router();

  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  router.use(requireAccessToken);

  router.post(
    "/recompute-all",
    requireBusinessPlane(["global_super_admin"]),
    async_(recomputeAll)
  );

  return router;
}

export default createAdminRouter;
