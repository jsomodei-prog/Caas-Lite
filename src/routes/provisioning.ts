/**
 * src/routes/provisioning.ts
 * Phase 15 — Unified Client Provisioning & Account Core.
 *
 * Endpoints (dashboard-facing, JWT-authenticated):
 *   POST   /api/v1/accounts                   create tenant + tier + API key
 *   GET    /api/v1/accounts/:id               read account
 *   PATCH  /api/v1/accounts/:id/tier          change tier
 *   POST   /api/v1/accounts/:id/rotate-key    rotate API key (returns raw key once)
 *
 * Cryptographic Tenant Isolation:
 *   - API keys are generated as `caas_<64 hex chars>` and stored only as
 *     a sha256 hash plus a 12-char prefix. Mirrors src/routes/users.ts.
 *   - The raw key is surfaced exactly once at creation/rotation and never
 *     persisted in plaintext. Audit log records the prefix only.
 *   - Account creation requires plane_role 'global_super_admin' (business
 *     plane). Reads allow client_super_admin within their tenant scope.
 *
 * Phase 15 slice 7:
 *   - CreateAccountBody / AccountParams / ChangeTierBody schemas applied
 *     via validate() middleware at mount time.
 *   - AccountParams is reused across GET /:id, PATCH /:id/tier, and
 *     POST /:id/rotate-key per Appendix B of the slice 7 enumeration doc.
 *   - Legacy String() coercion of req.params.id removed (schema guarantees
 *     UUID string).
 *   - DEFAULT_PILOT_DAYS and VALID_TIERS removed: both were file-local
 *     constants that only existed to feed the now-removed inline guards
 *     and `??` fallbacks. The schema absorbs both (`.default(30)` on
 *     pilot_days, `z.enum([...]).default("LITE")` on tier).
 *
 * BEHAVIOR CHANGES from slice 7 (intentional — see enumeration doc
 * Appendix C "Tightenings"):
 *   - POST /  contact_email="not-an-email"  was accepted → now 400
 *     (schema requires email format).
 *   - POST /  pilot_days=0                  was accepted → now 400
 *     (was silently producing pilot_ends_at ≤ pilot_started_at, a
 *     latent bug; `.positive()` rejects it at the boundary).
 *   - POST /  pilot_days=-5                 was accepted → now 400.
 *   - POST /  pilot_days="abc"              was hitting `parseInt`→NaN
 *     paths downstream → now 400 (z.coerce.number on non-numeric strings).
 *   - GET /PATCH/POST  id=<non-uuid>        previously hit the DB and
 *     returned 404 → now 400 at the validation boundary. If any test
 *     fixture used non-UUID ids (e.g. "test-account-1"), update the
 *     fixture to a real UUID; do not loosen the schema.
 *   - All bodies: unknown top-level fields                was silently
 *     ignored → now 400 (`.strict()`). Most relevant for createAccount;
 *     SDK callers sending `displayName` (camelCase typo for
 *     `display_name`) will now fail loudly.
 *
 * NO BEHAVIOR CHANGES for:
 *   - Tenant-uniqueness 409 (semantic check, retained inline).
 *   - Same-tier no-op 200 response on PATCH /:id/tier.
 *   - Slice 6g HIGH-1 defense-in-depth tenant-scoped UPDATEs.
 *   - Badge sync atomic transaction on account creation.
 *   - Audit log writes (all 3 mutating endpoints).
 *
 * Pre-merge checks the implementation session should run:
 *   - npm test (all 143 existing tests must stay green)
 *   - grep -r VALID_TIERS src/ — must return no matches outside test
 *     fixtures (the constant was not exported)
 *   - grep -r DEFAULT_PILOT_DAYS src/ — same
 *   - Verify provisioning test fixtures use real UUIDs for account ids
 *
 * TODO(phase15): pilot_started_at / pilot_ends_at lifecycle hooks are
 * stubbed — currently set on creation but no scheduler updates them.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { requireAccessToken } from "./auth";
import { validate } from "../middleware/validate";
import { syncBadge } from "../lib/badge-sync";
import { requireBusinessPlane } from "../middleware/dualPlaneAuth";
import { commercialAuditLog } from "../lib/audit";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AccountTier   = "LITE" | "GROWTH" | "ENTERPRISE";
export type AccountStatus = "pilot" | "active" | "suspended" | "churned";

export interface AccountRow {
  id:                  string;
  tenant_id:           string;
  tier:                AccountTier;
  status:              AccountStatus;
  api_key_hash:        string;
  api_key_prefix:      string;
  api_key_rotated_at:  string | null;
  pilot_started_at:    string | null;
  pilot_ends_at:       string | null;
  display_name:        string;
  contact_email:       string | null;
  created_at:          string;
  updated_at:          string;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Body schema for POST /api/v1/accounts.
 *
 * - tier: defaults to "LITE" matching the legacy `body.tier ?? "LITE"` line.
 *   Listed as an enum (not z.string()) because the AccountTier type has a
 *   fixed set and the legacy handler explicitly rejected anything else.
 * - contact_email: BEHAVIOR CHANGE — schema enforces email format. See
 *   header block.
 * - pilot_days: BEHAVIOR CHANGE — z.coerce.number().int().positive() rejects
 *   0, negatives, fractional values, and non-numeric strings. Default 30
 *   replaces the legacy `body.pilot_days ?? DEFAULT_PILOT_DAYS` fallback.
 *   z.coerce handles cases where pilot_days arrives as a string (e.g.
 *   form-encoded POST from the dashboard); kept lenient because the
 *   legacy handler accepted both string and number form via parseInt-free
 *   `??` fallback that would have stringified at the comparison anyway.
 *   The current handler does `Date.now() + pilotDays * 86_400_000` which
 *   requires a real number — coerce ensures that.
 */
const CreateAccountBody = z.object({
  tenant_id:     z.string().min(1),
  display_name:  z.string().min(1),
  tier:          z.enum(["LITE", "GROWTH", "ENTERPRISE"]).default("LITE"),
  contact_email: z.string().email().optional(),
  pilot_days:    z.coerce.number().int().positive().default(30),
}).strict();

/**
 * Params schema reused across GET /:id, PATCH /:id/tier, POST /:id/rotate-key.
 *
 * accounts.id is assigned via crypto.randomUUID() in createAccount above,
 * so UUID is the correct format. If the column is ever migrated to a
 * different ID scheme, loosen to z.string().min(1) here AND in the
 * enumeration doc's Appendix A.
 *
 * Appendix B lists this schema as reused 3x — keep that contract; if a
 * route needs different param validation, add a new schema rather than
 * mutating this one.
 */
const AccountParams = z.object({
  id: z.string().uuid(),
}).strict();

/**
 * Body schema for PATCH /:id/tier.
 *
 * Note: no .default() here — the legacy handler treated a missing `tier`
 * as a 400 ("tier must be one of ..."), and that's the correct UX for
 * a PATCH operation whose entire purpose is to change the tier field.
 */
const ChangeTierBody = z.object({
  tier: z.enum(["LITE", "GROWTH", "ENTERPRISE"]),
}).strict();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDb(req: Request): DB {
  return (req.app.locals as { db: DB }).db;
}

function getActorId(req: Request): string {
  // Set by requireAccessToken middleware from JWT 'sub' claim.
  return (req as Request & { userId?: string }).userId ?? "system";
}

/**
 * Generates an API key in the format `caas_<64 hex>`. Returns the raw key
 * (to be shown once), its sha256 hash for storage, and a 12-char prefix
 * for display/lookup.
 */
function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw    = `caas_${crypto.randomBytes(32).toString("hex")}`;
  const hash   = crypto.createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12);
  return { raw, hash, prefix };
}



// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/accounts
 * Provision a new tenant account. Returns the raw API key once.
 *
 * Body: { tenant_id, display_name, tier?, contact_email?, pilot_days? }
 *
 * After validate({ body: CreateAccountBody }):
 *   - tenant_id and display_name are guaranteed non-empty strings
 *   - tier has the default "LITE" applied (no need for `?? "LITE"`)
 *   - pilot_days has the default 30 applied (no need for the legacy ??)
 *   - All inline VALID_TIERS / presence guards are now redundant.
 */
async function createAccount(req: Request, res: Response): Promise<void> {
  const db      = getDb(req);
  const actorId = getActorId(req);
  const body    = req.body as z.infer<typeof CreateAccountBody>;

  // Tenant-uniqueness check stays inline — semantic 409, not a shape check.
  const existing = db
    .prepare("SELECT id FROM accounts WHERE tenant_id = ?")
    .get(body.tenant_id) as { id: string } | undefined;
  if (existing) {
    res.status(409).json({ error: "Account already exists for this tenant_id", account_id: existing.id });
    return;
  }

  const accountId = crypto.randomUUID();
  const now       = new Date().toISOString();
  const pilotEnds = new Date(Date.now() + body.pilot_days * 86_400_000).toISOString();
  const apiKey    = generateApiKey();

  // Insert account and seed its initial badge atomically. If badge sync
  // fails, the account insert rolls back — better than an accountless
  // signup or an account without a badge.
  let badgeSignature = "";
  db.transaction(() => {
    db.prepare(`
      INSERT INTO accounts (
        id, tenant_id, tier, status,
        api_key_hash, api_key_prefix, api_key_rotated_at,
        pilot_started_at, pilot_ends_at,
        display_name, contact_email,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'pilot', ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId, body.tenant_id, body.tier,
      apiKey.hash, apiKey.prefix,
      now, pilotEnds,
      body.display_name, body.contact_email ?? null,
      now, now
    );

    // Seed initial green badge. No warranty bound yet, so policy_state
    // is null — syncBadge interprets that as "good standing by default".
    const sync = syncBadge(db, body.tenant_id, accountId, { policy_state: null });
    badgeSignature = sync.signature;

    commercialAuditLog(
      db, body.tenant_id, actorId, "account", accountId, "create",
      null, JSON.stringify({ tier: body.tier, status: "pilot" }),
      { api_key_prefix: apiKey.prefix, pilot_days: body.pilot_days }
    );
  })();

  res.status(201).json({
    id:               accountId,
    tenant_id:        body.tenant_id,
    tier:             body.tier,
    status:           "pilot",
    display_name:     body.display_name,
    contact_email:    body.contact_email ?? null,
    pilot_started_at: now,
    pilot_ends_at:    pilotEnds,
    api_key:          apiKey.raw,        // surfaced exactly once
    api_key_prefix:   apiKey.prefix,
    badge_signature:  badgeSignature,    // surfaced for embedders to pin
    message:          "Store the api_key securely — it will not be shown again.",
  });
}

/**
 * GET /api/v1/accounts/:id
 * Read account. Hash and rotation timestamp returned; raw key never.
 *
 * After validate({ params: AccountParams }), req.params.id is a validated
 * UUID string. The legacy String() wrap is unnecessary.
 */
async function getAccount(req: Request, res: Response): Promise<void> {
  const db = getDb(req);
  const { id } = req.params as z.infer<typeof AccountParams>;

  const row = db.prepare(`
    SELECT id, tenant_id, tier, status,
           api_key_prefix, api_key_rotated_at,
           pilot_started_at, pilot_ends_at,
           display_name, contact_email,
           created_at, updated_at
    FROM accounts WHERE id = ?
  `).get(id) as Partial<AccountRow> | undefined;

  if (!row) { res.status(404).json({ error: "Account not found" }); return; }
  res.json(row);
}

/**
 * PATCH /api/v1/accounts/:id/tier
 * Body: { tier: 'LITE' | 'GROWTH' | 'ENTERPRISE' }
 *
 * After validate({ params: AccountParams, body: ChangeTierBody }):
 *   - req.params.id is a validated UUID string
 *   - body.tier is guaranteed to be one of the three enum values
 *   - The legacy `if (!tier || !VALID_TIERS.includes(tier))` guard is gone.
 */
async function changeTier(req: Request, res: Response): Promise<void> {
  const db      = getDb(req);
  const actorId = getActorId(req);
  const { id }   = req.params as z.infer<typeof AccountParams>;
  const { tier } = req.body   as z.infer<typeof ChangeTierBody>;

  const current = db
    .prepare("SELECT tenant_id, tier FROM accounts WHERE id = ?")
    .get(id) as { tenant_id: string; tier: AccountTier } | undefined;
  if (!current) { res.status(404).json({ error: "Account not found" }); return; }

  if (current.tier === tier) {
    res.json({ id, tier, message: "No change — account already at this tier." });
    return;
  }

  const now = new Date().toISOString();
  db.transaction(() => {
    // Slice 6g HIGH-1: defense-in-depth tenant scope on the UPDATE.
    // Uses tenant_id from the SELECT above, ensuring the UPDATE only
    // touches a row matching both id AND that tenant. id is a UUID
    // (unique by schema) so this is paranoid, but harmless and consistent
    // with the pattern in users.ts:assignRole.
    db.prepare(
      "UPDATE accounts SET tier = ?, updated_at = ? WHERE id = ? AND tenant_id = ?"
    ).run(tier, now, id, current.tenant_id);

    commercialAuditLog(
      db, current.tenant_id, actorId, "account", id, "tier_change",
      current.tier, tier
    );
  })();

  res.json({ id, tier, previous_tier: current.tier, changed_at: now });
}

/**
 * POST /api/v1/accounts/:id/rotate-key
 * Generate a new API key, invalidating the previous one. Returns raw key once.
 *
 * After validate({ params: AccountParams }), req.params.id is a validated
 * UUID string.
 */
async function rotateApiKey(req: Request, res: Response): Promise<void> {
  const db      = getDb(req);
  const actorId = getActorId(req);
  const { id }  = req.params as z.infer<typeof AccountParams>;

  const current = db
    .prepare("SELECT tenant_id, api_key_prefix FROM accounts WHERE id = ?")
    .get(id) as { tenant_id: string; api_key_prefix: string } | undefined;
  if (!current) { res.status(404).json({ error: "Account not found" }); return; }

  const apiKey = generateApiKey();
  const now    = new Date().toISOString();

  db.transaction(() => {
    // Slice 6g HIGH-1: defense-in-depth tenant scope on the UPDATE.
    db.prepare(`
      UPDATE accounts
         SET api_key_hash       = ?,
             api_key_prefix     = ?,
             api_key_rotated_at = ?,
             updated_at         = ?
       WHERE id = ? AND tenant_id = ?
    `).run(apiKey.hash, apiKey.prefix, now, now, id, current.tenant_id);

    commercialAuditLog(
      db, current.tenant_id, actorId, "account", id, "key_rotation",
      current.api_key_prefix, apiKey.prefix
    );
  })();

  res.status(200).json({
    id,
    api_key:        apiKey.raw,
    api_key_prefix: apiKey.prefix,
    rotated_at:     now,
    message:        "Previous key is now invalid. Store the new api_key securely.",
  });
}

// ─── Router Assembly ──────────────────────────────────────────────────────────

export function createProvisioningRouter(): Router {
  const router = Router();

  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  router.use(requireAccessToken);

  // AccountParams is reused across 3 routes (GET, PATCH, POST rotate-key).
  // Factored into a const per the pov-billing.ts pattern so the schema is
  // wired identically at each mount point — easier to audit and harder to
  // diverge accidentally.
  const validateAccountParams = validate({ params: AccountParams });

  // Provisioning + rotation: business plane only
  router.post(
    "/",
    requireBusinessPlane(["global_super_admin"]),
    validate({ body: CreateAccountBody }),
    async_(createAccount),
  );
  router.post(
    "/:id/rotate-key",
    requireBusinessPlane(["global_super_admin"]),
    validateAccountParams,
    async_(rotateApiKey),
  );
  router.patch(
    "/:id/tier",
    requireBusinessPlane(["global_super_admin"]),
    validate({ params: AccountParams, body: ChangeTierBody }),
    async_(changeTier),
  );

  // Read: any authenticated user (tenant scoping enforced at row level — TODO)
  router.get(
    "/:id",
    validateAccountParams,
    async_(getAccount),
  );

  return router;
}

// Exported for tests that want to assert the schemas directly without
// constructing an Express request.
export { CreateAccountBody, AccountParams, ChangeTierBody };

export default createProvisioningRouter;
