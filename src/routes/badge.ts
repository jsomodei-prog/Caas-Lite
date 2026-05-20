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
 * Phase 15 slice 7:
 *   - tenantId param now validated via BadgeParams (z.string().min(1)) at
 *     the validate() middleware boundary. Legacy String() coercion removed.
 *   - sig query parameter is DELIBERATELY NOT validated by schema. See the
 *     BadgeQuery comment below for the privacy rationale; the inline
 *     `if (!presented)` 404 check is preserved verbatim.
 *
 * NO BEHAVIOR CHANGES in slice 7 for this route. The params schema accepts
 * the same set of tenantId strings the route accepted before (any non-empty
 * string), and the sig handling is untouched.
 *
 * Pre-merge checks the implementation session should run:
 *   - npm test (all 143 existing tests must stay green; the preflight test
 *     at tests/preflight-validate.test.ts covers the validate() middleware)
 *   - Manually verify: GET /api/v1/badge/<unknown-tenant>            → 404
 *                      GET /api/v1/badge/<unknown-tenant>?sig=foo    → 404
 *                      GET /api/v1/badge/<known-tenant>              → 404 (no sig)
 *                      GET /api/v1/badge/<known-tenant>?sig=wrong    → 404
 *     All four MUST return the same {error: "Not found"} body. Any
 *     distinction between them is a privacy regression — see the
 *     "Why BadgeQuery is not applied" note in the Schemas section.
 *
 * TODO(phase15):
 *   - PATCH /api/v1/badge/:tenantId  internal endpoint to refresh state
 *     and resign. Called from the insurance recompute path.
 *   - Surface signature in the provisioning response so embedders can
 *     grab it during onboarding.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { validate } from "../middleware/validate";
import { signBadgeState, verifyBadgeSignature } from "../lib/badge-secrets";

// Re-export signBadgeState so existing callers (badge-sync, tests) keep
// working without an import-path change.
export { signBadgeState };

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * tenantId here is the embedder-presented tenant identifier string, NOT a
 * UUID — the trust_badge_registry is keyed on whatever tenant_id the embedder
 * provides at provisioning time, and the dashboard surfaces that same string
 * back to them. Using z.string().min(1) rather than z.uuid() to match current
 * behavior; tightening to UUID would be a behavior change and is flagged in
 * the slice 7 enumeration doc as NOT in scope.
 */
const BadgeParams = z.object({
  tenantId: z.string().min(1),
}).strict();

/**
 * Why BadgeQuery is NOT applied to this route
 * ============================================
 *
 * The natural schema would be:
 *
 *   const BadgeQuery = z.object({
 *     sig: z.string().min(1),
 *   }).strict();
 *
 * Applied via validate({ params, query }), this would cause requests with
 * a missing or empty `sig` parameter to return 400 instead of the current
 * 404. That sounds like a normal correctness improvement, but it leaks
 * information that the current handler deliberately conceals.
 *
 * The endpoint's auth model gives EVERY failure mode the same response
 * (404 + "Not found"): unknown tenantId, known tenantId with wrong sig,
 * known tenantId with missing sig, known tenantId with stale sig from a
 * rotated-out secret. An attacker probing tenant existence cannot tell
 * any of these apart. Applying a query schema would split "missing sig"
 * off into 400, letting the attacker distinguish "the validator ran"
 * (route exists, structure was checked) from "the validator was bypassed"
 * (still 404 only for genuinely-unknown tenants in some future code path).
 *
 * The inline `if (!presented)` check below produces the same 404 for the
 * missing-sig case as for every other failure, which is the property we
 * want to preserve. Per the slice 7 enumeration doc Appendix C: "Do not
 * apply BadgeQuery to this route. Validate params only."
 *
 * If a future slice wants to enforce sig presence at the schema layer
 * AND preserve the 404 response shape, the right place is a custom
 * validate() variant that maps query errors to 404, not BadgeQuery here.
 */

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDb(req: Request): DB {
  return (req.app.locals as { db: DB }).db;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

async function getBadgeState(req: Request, res: Response): Promise<void> {
  const db        = getDb(req);
  // After validate({ params: BadgeParams }), req.params.tenantId is a
  // validated non-empty string. The legacy String() wrap is unnecessary.
  // The query.sig handling is INTENTIONALLY untouched — see BadgeQuery
  // note in the Schemas section for why this is not schema-validated.
  const { tenantId } = req.params as z.infer<typeof BadgeParams>;
  const presented    = String(req.query.sig ?? "");

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
  //
  // validate({ params: BadgeParams }) only — query is INTENTIONALLY not
  // schema-validated to preserve the 404-vs-400 privacy property. See
  // the BadgeQuery comment in the Schemas section above.
  router.get(
    "/:tenantId",
    validate({ params: BadgeParams }),
    async_(getBadgeState),
  );

  // Explicit OPTIONS handler so browser preflights succeed. The
  // permissiveCors middleware mounted at the app level has already set
  // Access-Control-Allow-* headers; this handler just responds 204 so
  // the browser proceeds with the real request.
  router.options("/:tenantId", (_req, res) => { res.status(204).end(); });

  return router;
}

// Exported for tests that want to assert the schema directly without
// constructing an Express request.
export { BadgeParams };

export default createBadgeRouter;
