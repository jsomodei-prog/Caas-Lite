/**
 * src/routes/badge.ts
 * Phase 15 — Public-facing trust badge endpoint.
 *
 * Endpoint:
 *   GET /api/v1/badge/:tenantId?sig=<state_signature>
 *
 * Auth model:
 *   - NOT JWT, NOT API key. Tenant-public.
 *   - Authenticated by presenting the current state_signature value
 *     stored in trust_badge_registry. The signature is an HMAC computed
 *     server-side over (tenant_id, badge_state, state_changed_at) and is
 *     surfaced to the embedder via the dashboard at provisioning time.
 *   - If the signature doesn't match what's currently stored, return 404
 *     (don't distinguish "wrong sig" from "no tenant" — same response).
 *   - When the badge state changes, the signature changes too. Old
 *     embed URLs go stale; embedders must refresh their sig from the
 *     dashboard. This is intentional: it makes badge state cryptographically
 *     pinned to an external attestation moment.
 *
 * Also exposes the helper used to compute signatures, so other parts of
 * the system (state transition handlers in the insurance route, the
 * badge management endpoint TODO'd below) can reuse it.
 *
 * TODO(phase15):
 *   - PATCH /api/v1/badge/:tenantId  internal endpoint to refresh state
 *     and resign. Called from the insurance recompute path.
 *   - Surface signature in the provisioning response so embedders can
 *     grab it during onboarding.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { signBadgeState, verifyBadgeSignature } from "../lib/badge-secrets";

// Re-export signBadgeState so existing callers (badge-sync, tests) keep
// working without an import-path change.
export { signBadgeState };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDb(req: Request): DB {
  return (req.app.locals as { db: DB }).db;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function getBadgeState(req: Request, res: Response): Promise<void> {
  const db        = getDb(req);
  const tenantId  = String(req.params.tenantId);
  const presented = String(req.query.sig ?? "");

  if (!presented) { res.status(404).json({ error: "Not found" }); return; }

  const row = db.prepare(`
    SELECT badge_state, state_signature, state_reason, state_changed_at
    FROM trust_badge_registry
    WHERE tenant_id = ?
  `).get(tenantId) as
    | {
        badge_state:      string;
        state_signature:  string;
        state_reason:     string | null;
        state_changed_at: string;
      }
    | undefined;

  if (!row) { res.status(404).json({ error: "Not found" }); return; }

  // Verify against current AND previous secrets. Accepts signatures minted
  // under either, so a recent secret rotation doesn't immediately 404
  // every embedder. The stored state_signature is also accepted as-is —
  // it always matches the current secret after boot-time resigning.
  const presentedMatchesStored =
    presented.length === row.state_signature.length &&
    safeStringsEqual(presented, row.state_signature);

  if (!presentedMatchesStored) {
    const verdict = verifyBadgeSignature(
      presented, tenantId, row.badge_state, row.state_changed_at
    );
    if (verdict === "invalid") {
      res.status(404).json({ error: "Not found" });
      return;
    }
    // verdict === "previous": signal to the embedder that they should
    // refresh their pinned signature, but DO serve the response.
    if (verdict === "previous") {
      res.setHeader("X-Badge-Signature-Stale", "true");
    }
  }

  // Permissive CORS for badge embeds — the response contains nothing more
  // sensitive than what the embedder already knows by holding the signature.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=30");

  res.json({
    badge_state:      row.badge_state,
    state_reason:     row.state_reason,
    state_changed_at: row.state_changed_at,
  });
}

function safeStringsEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ─── Router Assembly ──────────────────────────────────────────────────────────

export function createBadgeRouter(): Router {
  const router = Router();

  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  // No requireAccessToken — this endpoint is signature-gated, public-ish.
  router.get("/:tenantId", async_(getBadgeState));

  // Explicit OPTIONS handler so browser preflights succeed. The
  // permissiveCors middleware mounted at the app level has already set
  // Access-Control-Allow-* headers; this handler just responds 204 so
  // the browser proceeds with the real request.
  router.options("/:tenantId", (_req, res) => { res.status(204).end(); });

  return router;
}

export default createBadgeRouter;
