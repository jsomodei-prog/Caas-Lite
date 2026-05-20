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
 * TODO(phase15): pilot_started_at / pilot_ends_at lifecycle hooks are
 * stubbed — currently set on creation but no scheduler updates them.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { requireAccessToken } from "./auth";
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

interface CreateAccountBody {
  tenant_id:     string;
  display_name:  string;
  tier?:         AccountTier;
  contact_email?: string;
  pilot_days?:   number;  // defaults to 30
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_PILOT_DAYS = 30;
const VALID_TIERS: AccountTier[] = ["LITE", "GROWTH", "ENTERPRISE"];

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
 */
async function createAccount(req: Request, res: Response): Promise<void> {
  const db      = getDb(req);
  const actorId = getActorId(req);
  const body    = req.body as CreateAccountBody;

  if (!body.tenant_id || !body.display_name) {
    res.status(400).json({ error: "tenant_id and display_name are required" });
    return;
  }
  const tier = body.tier ?? "LITE";
  if (!VALID_TIERS.includes(tier)) {
    res.status(400).json({ error: `tier must be one of ${VALID_TIERS.join(", ")}` });
    return;
  }

  const existing = db
    .prepare("SELECT id FROM accounts WHERE tenant_id = ?")
    .get(body.tenant_id) as { id: string } | undefined;
  if (existing) {
    res.status(409).json({ error: "Account already exists for this tenant_id", account_id: existing.id });
    return;
  }

  const accountId = crypto.randomUUID();
  const now       = new Date().toISOString();
  const pilotDays = body.pilot_days ?? DEFAULT_PILOT_DAYS;
  const pilotEnds = new Date(Date.now() + pilotDays * 86_400_000).toISOString();
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
      accountId, body.tenant_id, tier,
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
      null, JSON.stringify({ tier, status: "pilot" }),
      { api_key_prefix: apiKey.prefix, pilot_days: pilotDays }
    );
  })();

  res.status(201).json({
    id:               accountId,
    tenant_id:        body.tenant_id,
    tier,
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
 */
async function getAccount(req: Request, res: Response): Promise<void> {
  const db = getDb(req);
  const id = String(req.params.id);

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
 */
async function changeTier(req: Request, res: Response): Promise<void> {
  const db      = getDb(req);
  const actorId = getActorId(req);
  const id      = String(req.params.id);
  const { tier } = req.body as { tier?: AccountTier };

  if (!tier || !VALID_TIERS.includes(tier)) {
    res.status(400).json({ error: `tier must be one of ${VALID_TIERS.join(", ")}` });
    return;
  }

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
 */
async function rotateApiKey(req: Request, res: Response): Promise<void> {
  const db      = getDb(req);
  const actorId = getActorId(req);
  const id      = String(req.params.id);

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

  // Provisioning + rotation: business plane only
  router.post("/",                       requireBusinessPlane(["global_super_admin"]), async_(createAccount));
  router.post("/:id/rotate-key",         requireBusinessPlane(["global_super_admin"]), async_(rotateApiKey));
  router.patch("/:id/tier",              requireBusinessPlane(["global_super_admin"]), async_(changeTier));

  // Read: any authenticated user (tenant scoping enforced at row level — TODO)
  router.get("/:id",                                                                  async_(getAccount));

  return router;
}

export default createProvisioningRouter;
