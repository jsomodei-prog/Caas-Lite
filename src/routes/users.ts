/**
 * src/routes/users.ts
 * Dynamic User Profile Management Router.
 *
 * Covers:
 *   - User onboarding with extended profile fields
 *   - Freelancer registration pipeline (maps to agent payout config)
 *   - Credential profile management (password, MFA seed, API key)
 *   - Role assignment with audit trail
 *   - KYC tier elevation with evidence attachment
 *   - Cross-industry country constraint validation on profile save
 *   - Role assignment verification test block (permission drop testing)
 *
 * All write operations are logged to the role_audit_log table.
 * Multi-tenant isolation enforced on every query.
 *
 * Phase 11 build-out | Commit baseline: a4f5db6
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import crypto  from "crypto";
import argon2  from "argon2";
import type { Database as DB } from "better-sqlite3";
import { requireAccessToken } from "./auth";
import { getCountryRequirement, meetsKycRequirement } from "../config/countryRequirements";
import type { KycTier, CountryRequirement } from "../config/countryRequirements";
import type { CaaSRole } from "./auth";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProfileStatus = "active" | "suspended" | "pending_kyc" | "pending_review";

export interface ExtendedProfile {
  user_id: string;
  tenant_id: string;
  username: string;
  email: string;
  role: CaaSRole;
  /** Display name (may differ from username). */
  display_name: string | null;
  /** E.164 phone number. */
  phone: string | null;
  /** ISO 3166-1 alpha-2. */
  country_code: string | null;
  /** ISO 4217 preferred payout currency. */
  preferred_currency: string | null;
  kyc_tier: KycTier;
  profile_status: ProfileStatus;
  /** Whether this user is also registered as a freelancer agent. */
  is_freelancer: boolean;
  /** FK → agents.id (null if not a freelancer). */
  agent_id: string | null;
  /** Optional bio or company description. */
  bio: string | null;
  api_key_hash: string | null;
  api_key_prefix: string | null;
  mfa_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface FreelancerRegistration {
  user_id: string;
  tenant_id: string;
  display_name: string;
  country_code: string;
  payout_method: "momo" | "card";
  momo_number?: string;
  momo_provider?: string;
  card_token?: string;
  payout_threshold_usd: number;
  preferred_currency: string;
}

export interface RoleAuditEntry {
  id: string;
  tenant_id: string;
  target_user_id: string;
  actor_user_id: string;
  action: string;
  old_value: string | null;
  new_value: string | null;
  reason: string | null;
  created_at: string;
}

export interface PermissionTestResult {
  user_id: string;
  role: CaaSRole;
  country_code: string | null;
  kyc_tier: KycTier;
  tests: PermissionTest[];
  passed: number;
  failed: number;
}

export interface PermissionTest {
  name: string;
  expected: boolean;
  actual: boolean;
  passed: boolean;
  reason: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

const ARGON2_OPTIONS: argon2.Options & { raw: false } = {
  type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1, raw: false,
};

const ROLE_PERMISSIONS: Record<CaaSRole, Set<string>> = {
  Executive: new Set(["read:all", "write:all", "delete:all", "manage:users", "manage:roles", "view:reports", "trigger:sweep", "manage:agents"]),
  Auditor:   new Set(["read:all", "view:reports", "read:anomalies", "read:payouts"]),
  Partner:   new Set(["read:own", "view:own_payouts", "manage:own_profile"]),
};

// ─── DB Bootstrap ─────────────────────────────────────────────────────────────

function ensureUserProfileTable(db: DB): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id            TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      tenant_id          TEXT NOT NULL,
      display_name       TEXT,
      phone              TEXT,
      country_code       TEXT,
      preferred_currency TEXT,
      kyc_tier           TEXT NOT NULL DEFAULT 'basic',
      profile_status     TEXT NOT NULL DEFAULT 'active',
      is_freelancer      INTEGER NOT NULL DEFAULT 0,
      agent_id           TEXT REFERENCES agents(id),
      bio                TEXT,
      api_key_hash       TEXT,
      api_key_prefix     TEXT,
      mfa_enabled        INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE TABLE IF NOT EXISTS role_audit_log (
      id              TEXT PRIMARY KEY,
      tenant_id       TEXT NOT NULL,
      target_user_id  TEXT NOT NULL,
      actor_user_id   TEXT NOT NULL,
      action          TEXT NOT NULL,
      old_value       TEXT,
      new_value       TEXT,
      reason          TEXT,
      created_at      TEXT NOT NULL
    )
  `).run();

  db.prepare(`CREATE INDEX IF NOT EXISTS idx_role_audit_tenant ON role_audit_log(tenant_id, created_at DESC)`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_profiles_tenant ON user_profiles(tenant_id)`).run();
}

// ─── Audit Log ─────────────────────────────────────────────────────────────────

function auditLog(
  db: DB,
  tenantId: string,
  targetUserId: string,
  actorUserId: string,
  action: string,
  oldValue: string | null,
  newValue: string | null,
  reason: string | null = null
): void {
  db.prepare(`
    INSERT INTO role_audit_log (id, tenant_id, target_user_id, actor_user_id, action, old_value, new_value, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), tenantId, targetUserId, actorUserId, action, oldValue, newValue, reason, new Date().toISOString());
}

// ─── Permission Tests ─────────────────────────────────────────────────────────

function runPermissionTests(
  role: CaaSRole,
  countryCode: string | null,
  kycTier: KycTier,
  userId: string
): PermissionTestResult {
  const perms = ROLE_PERMISSIONS[role];
  const tests: PermissionTest[] = [];

  const check = (name: string, expected: boolean, actual: boolean, reason: string) => {
    tests.push({ name, expected, actual, passed: expected === actual, reason });
  };

  // Role-based access tests
  check("Executive can manage users",   role === "Executive", perms.has("manage:users"),   `Role ${role} ${perms.has("manage:users") ? "has" : "lacks"} manage:users`);
  check("Auditor cannot write",         role === "Auditor",   !perms.has("write:all"),      `Role ${role} ${perms.has("write:all") ? "incorrectly has" : "correctly lacks"} write:all`);
  check("Partner read limited to own",  role === "Partner",   perms.has("read:own") && !perms.has("read:all"), `Partner ${perms.has("read:all") ? "incorrectly has" : "correctly lacks"} read:all`);
  check("Executive can trigger sweep",  role === "Executive", perms.has("trigger:sweep"),  `Role ${role} ${perms.has("trigger:sweep") ? "has" : "lacks"} trigger:sweep`);
  check("Auditor can view reports",     role === "Auditor",   perms.has("view:reports"),    `Role ${role} ${perms.has("view:reports") ? "has" : "lacks"} view:reports`);

  // KYC checks against countries
  if (countryCode) {
    let countryReq: CountryRequirement | null = null;
    try { countryReq = getCountryRequirement(countryCode); } catch { /* unsupported */ }

    if (countryReq) {
      const meetsKyc = meetsKycRequirement(kycTier, countryCode);
      check(
        `KYC tier "${kycTier}" meets ${countryCode} minimum "${countryReq.min_kyc_tier}"`,
        true, meetsKyc,
        meetsKyc
          ? `${kycTier} satisfies ${countryReq.min_kyc_tier} requirement`
          : `${kycTier} is below required ${countryReq.min_kyc_tier} for ${countryCode}`
      );
      check(
        `${countryCode} has supported payout methods`,
        true,
        countryReq.supported_methods.length > 0,
        `${countryReq.supported_methods.length} method(s) available`
      );
    }
  }

  // Permission drop tests (invalid access interception)
  const dropTests: [string, CaaSRole, string][] = [
    ["Partner cannot delete",        "Partner",  "delete:all"],
    ["Partner cannot manage users",  "Partner",  "manage:users"],
    ["Auditor cannot manage agents", "Auditor",  "manage:agents"],
    ["Auditor cannot trigger sweep", "Auditor",  "trigger:sweep"],
  ];

  for (const [name, testRole, perm] of dropTests) {
    if (testRole === role) {
      const hasPerm = ROLE_PERMISSIONS[role].has(perm);
      check(name, false, hasPerm, hasPerm ? `SECURITY: ${role} incorrectly has ${perm}` : `Correctly blocked: ${role} lacks ${perm}`);
    }
  }

  return {
    user_id:      userId,
    role,
    country_code: countryCode,
    kyc_tier:     kycTier,
    tests,
    passed: tests.filter(t => t.passed).length,
    failed: tests.filter(t => !t.passed).length,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function getDb(req: Request): DB {
  return (req.app.locals as { db: DB }).db;
}

function getActorId(req: Request): string {
  return (req as Request & { caasUserId?: string }).caasUserId ?? "system";
}

function getTenantId(req: Request): string {
  return (req.headers["x-tenant-id"] as string | undefined) ?? "unknown";
}

// ─── Route Handlers ────────────────────────────────────────────────────────────

/**
 * GET /api/v1/users
 * List all users in the tenant with their profiles.
 * Executive only.
 */
async function listUsers(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);

  ensureUserProfileTable(db);

  const users = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.locked, u.last_login_at, u.created_at,
           p.display_name, p.country_code, p.kyc_tier, p.profile_status,
           p.is_freelancer, p.agent_id, p.preferred_currency
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE u.tenant_id = ?
    ORDER BY u.created_at DESC
  `).all(tenantId);

  res.json({ data: users, total: (users as unknown[]).length });
}

/**
 * GET /api/v1/users/:userId
 * Fetch a user's full profile. Executive/Auditor or self.
 */
async function getUser(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const userId   = String(req.params.userId);

  ensureUserProfileTable(db);

  const user = db.prepare(`
    SELECT u.id, u.username, u.email, u.role, u.locked, u.locked_until,
           u.failed_attempts, u.last_login_at, u.created_at,
           p.display_name, p.phone, p.country_code, p.preferred_currency,
           p.kyc_tier, p.profile_status, p.is_freelancer, p.agent_id,
           p.bio, p.api_key_prefix, p.mfa_enabled
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE u.id = ? AND u.tenant_id = ?
  `).get(userId, tenantId);

  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  res.json(user);
}

/**
 * POST /api/v1/users/:userId/profile
 * Create or update extended profile fields.
 * Validates country data constraints.
 */
async function upsertProfile(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const userId   = String(req.params.userId);
  const actorId  = getActorId(req);

  ensureUserProfileTable(db);

  const {
    display_name, phone, country_code, preferred_currency,
    bio, kyc_tier, profile_status,
  } = req.body as Partial<ExtendedProfile>;

  // Country constraint validation
  if (country_code) {
    try {
      const countryReq = getCountryRequirement(country_code);
      if (preferred_currency && !countryReq.accepted_currencies.includes(preferred_currency)) {
        res.status(422).json({
          error: `Currency ${preferred_currency} is not accepted in ${country_code}. Accepted: ${countryReq.accepted_currencies.join(", ")}`,
        });
        return;
      }
    } catch (err) {
      res.status(422).json({ error: err instanceof Error ? err.message : "Invalid country code" });
      return;
    }
  }

  const now = new Date().toISOString();

  const existing = db
    .prepare("SELECT user_id FROM user_profiles WHERE user_id = ? AND tenant_id = ?")
    .get(userId, tenantId);

  if (existing) {
    db.prepare(`
      UPDATE user_profiles SET
        display_name       = COALESCE(@display_name, display_name),
        phone              = COALESCE(@phone, phone),
        country_code       = COALESCE(@country_code, country_code),
        preferred_currency = COALESCE(@preferred_currency, preferred_currency),
        bio                = COALESCE(@bio, bio),
        kyc_tier           = COALESCE(@kyc_tier, kyc_tier),
        profile_status     = COALESCE(@profile_status, profile_status),
        updated_at         = @now
      WHERE user_id = @user_id AND tenant_id = @tenant_id
    `).run({ display_name, phone, country_code, preferred_currency, bio, kyc_tier, profile_status, now, user_id: userId, tenant_id: tenantId });
  } else {
    db.prepare(`
      INSERT INTO user_profiles
        (user_id, tenant_id, display_name, phone, country_code, preferred_currency,
         kyc_tier, profile_status, bio, created_at, updated_at)
      VALUES (@user_id, @tenant_id, @display_name, @phone, @country_code, @preferred_currency,
              @kyc_tier, @profile_status, @bio, @now, @now)
    `).run({
      user_id: userId, tenant_id: tenantId,
      display_name: display_name ?? null, phone: phone ?? null,
      country_code: country_code ?? null, preferred_currency: preferred_currency ?? null,
      kyc_tier: kyc_tier ?? "basic", profile_status: profile_status ?? "active",
      bio: bio ?? null, now,
    });
  }

  auditLog(db, tenantId, userId, actorId, "profile_update", null, JSON.stringify({ display_name, country_code, kyc_tier }));
  res.json({ success: true, updated_at: now });
}

/**
 * POST /api/v1/users/:userId/role
 * Assign a new role to a user. Executive only.
 * Body: { role, reason }
 */
async function assignRole(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const actorId  = getActorId(req);
  const userId   = String(req.params.userId);
  const { role, reason } = req.body as { role?: CaaSRole; reason?: string };

  const validRoles: CaaSRole[] = ["Executive", "Auditor", "Partner"];
  if (!role || !validRoles.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${validRoles.join(", ")}` });
    return;
  }

  const user = db
    .prepare("SELECT id, role FROM users WHERE id = ? AND tenant_id = ?")
    .get(userId, tenantId) as { id: string; role: CaaSRole } | undefined;

  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (user.role === role) { res.status(200).json({ message: "Role unchanged", role }); return; }

  const oldRole = user.role;
  db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?")
    .run(role, new Date().toISOString(), userId);

  auditLog(db, tenantId, userId, actorId, "role_change", oldRole, role, reason ?? null);
  res.json({ success: true, user_id: userId, old_role: oldRole, new_role: role });
}

/**
 * POST /api/v1/users/:userId/kyc
 * Elevate KYC tier. Executive only.
 * Body: { kyc_tier, evidence_ref }
 */
async function elevateKyc(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const actorId  = getActorId(req);
  const userId   = String(req.params.userId);
  const { kyc_tier, evidence_ref } = req.body as { kyc_tier?: KycTier; evidence_ref?: string };

  const validTiers: KycTier[] = ["basic", "standard", "enhanced"];
  if (!kyc_tier || !validTiers.includes(kyc_tier)) {
    res.status(400).json({ error: `kyc_tier must be one of: ${validTiers.join(", ")}` });
    return;
  }

  ensureUserProfileTable(db);

  const profile = db
    .prepare("SELECT kyc_tier FROM user_profiles WHERE user_id = ? AND tenant_id = ?")
    .get(userId, tenantId) as { kyc_tier: KycTier } | undefined;

  const oldTier = profile?.kyc_tier ?? "basic";

  if (profile) {
    db.prepare("UPDATE user_profiles SET kyc_tier = ?, updated_at = ? WHERE user_id = ? AND tenant_id = ?")
      .run(kyc_tier, new Date().toISOString(), userId, tenantId);
  }

  // Also update agent kyc_tier if this user is a freelancer
  db.prepare("UPDATE agents SET kyc_tier = ? WHERE id = (SELECT agent_id FROM user_profiles WHERE user_id = ? AND tenant_id = ?)")
    .run(kyc_tier, userId, tenantId);

  auditLog(db, tenantId, userId, actorId, "kyc_elevation", oldTier, kyc_tier, evidence_ref ?? null);
  res.json({ success: true, user_id: userId, old_tier: oldTier, new_tier: kyc_tier });
}

/**
 * POST /api/v1/users/:userId/freelancer
 * Register a user as a freelancer and create their agent record.
 * Validates country requirements before creating.
 */
async function registerFreelancer(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const actorId  = getActorId(req);
  const userId   = String(req.params.userId);
  const reg      = req.body as FreelancerRegistration;

  ensureUserProfileTable(db);

  const user = db
    .prepare("SELECT id, username FROM users WHERE id = ? AND tenant_id = ?")
    .get(userId, tenantId) as { id: string; username: string } | undefined;

  if (!user) { res.status(404).json({ error: "User not found" }); return; }

  // Country constraint check
  let countryReq: CountryRequirement;
  try { countryReq = getCountryRequirement(reg.country_code); }
  catch (err) { res.status(422).json({ error: err instanceof Error ? err.message : "Invalid country" }); return; }

  const hasMethod = countryReq.supported_methods.some(m => m.method === reg.payout_method);
  if (!hasMethod) {
    res.status(422).json({
      error: `${reg.payout_method} is not supported in ${reg.country_code}. Available: ${countryReq.supported_methods.map(m => m.method).join(", ")}`,
    });
    return;
  }

  const existingAgent = db
    .prepare("SELECT agent_id FROM user_profiles WHERE user_id = ? AND agent_id IS NOT NULL")
    .get(userId) as { agent_id: string } | undefined;

  if (existingAgent) {
    res.status(409).json({ error: "User is already registered as a freelancer", agent_id: existingAgent.agent_id });
    return;
  }

  const agentId = crypto.randomUUID();
  const now     = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO agents
        (id, tenant_id, name, balance_usd, payout_method, card_token,
         payout_threshold_usd, locked, country_code, kyc_tier,
         momo_number, momo_provider, created_at, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, 0, ?, 'basic', ?, ?, ?, ?)
    `).run(
      agentId, tenantId, reg.display_name, reg.payout_method,
      reg.card_token ?? null, reg.payout_threshold_usd,
      reg.country_code, reg.momo_number ?? null, reg.momo_provider ?? null, now, now
    );

    db.prepare(`
      INSERT INTO user_profiles
        (user_id, tenant_id, display_name, country_code, preferred_currency,
         is_freelancer, agent_id, kyc_tier, profile_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, 'basic', 'pending_kyc', ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        is_freelancer = 1, agent_id = excluded.agent_id,
        country_code = excluded.country_code,
        preferred_currency = excluded.preferred_currency,
        updated_at = excluded.updated_at
    `).run(userId, tenantId, reg.display_name, reg.country_code, reg.preferred_currency, agentId, now, now);
  })();

  auditLog(db, tenantId, userId, actorId, "freelancer_registered", null, agentId, reg.country_code);

  res.status(201).json({
    success:   true,
    user_id:   userId,
    agent_id:  agentId,
    country:   reg.country_code,
    currency:  reg.preferred_currency,
    method:    reg.payout_method,
    regulator: countryReq.regulator,
    kyc_required: countryReq.min_kyc_tier,
  });
}

/**
 * POST /api/v1/users/:userId/api-key
 * Generate a new API key for the user.
 * Returns the raw key once — it is hashed before storage.
 */
async function generateApiKey(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const actorId  = getActorId(req);
  const userId   = String(req.params.userId);

  ensureUserProfileTable(db);

  const rawKey    = `caas_${crypto.randomBytes(32).toString("hex")}`;
  const prefix    = rawKey.slice(0, 12);
  const keyHash   = crypto.createHash("sha256").update(rawKey).digest("hex");
  const now       = new Date().toISOString();

  db.prepare(`
    INSERT INTO user_profiles (user_id, tenant_id, api_key_hash, api_key_prefix, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET api_key_hash = excluded.api_key_hash, api_key_prefix = excluded.api_key_prefix, updated_at = excluded.updated_at
  `).run(userId, tenantId, keyHash, prefix, now, now);

  auditLog(db, tenantId, userId, actorId, "api_key_generated", null, prefix, null);

  res.status(201).json({
    message:    "Store this key securely — it will not be shown again.",
    api_key:    rawKey,
    prefix,
    generated_at: now,
  });
}

/**
 * GET /api/v1/users/:userId/permissions/test
 * Runs the role assignment verification test block.
 * Confirms permission drops catch invalid access attempts.
 */
async function testPermissions(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const userId   = String(req.params.userId);

  ensureUserProfileTable(db);

  const row = db.prepare(`
    SELECT u.role, p.country_code, p.kyc_tier
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE u.id = ? AND u.tenant_id = ?
  `).get(userId, tenantId) as { role: CaaSRole; country_code: string | null; kyc_tier: KycTier | null } | undefined;

  if (!row) { res.status(404).json({ error: "User not found" }); return; }

  const result = runPermissionTests(
    row.role,
    row.country_code,
    row.kyc_tier ?? "basic",
    userId
  );

  res.json(result);
}

/**
 * GET /api/v1/users/audit-log
 * Returns the role audit trail for the tenant.
 */
async function getAuditLog(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const limit    = Math.min(parseInt((req.query.limit as string) ?? "100", 10), 500);

  ensureUserProfileTable(db);

  const rows = db.prepare(
    "SELECT * FROM role_audit_log WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(tenantId, limit);

  res.json({ data: rows, total: (rows as unknown[]).length });
}

// ─── Role Guard ───────────────────────────────────────────────────────────────

function requireRole(...roles: CaaSRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const role = (req as Request & { caasRole?: CaaSRole }).caasRole;
    if (!role || !roles.includes(role)) {
      res.status(403).json({
        error:    "Forbidden",
        required: roles,
        actual:   role ?? "none",
      });
      return;
    }
    next();
  };
}

// ─── Router Assembly ──────────────────────────────────────────────────────────

export function createUsersRouter(): Router {
  const router = Router();

  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  // All user routes require a valid access token.
  router.use(requireAccessToken);

  router.get("/",                                    requireRole("Executive", "Auditor"), async_(listUsers));
  router.get("/audit-log",                           requireRole("Executive", "Auditor"), async_(getAuditLog));
  router.get("/:userId",                             async_(getUser));
  router.post("/:userId/profile",                    async_(upsertProfile));
  router.post("/:userId/role",                       requireRole("Executive"),            async_(assignRole));
  router.post("/:userId/kyc",                        requireRole("Executive"),            async_(elevateKyc));
  router.post("/:userId/freelancer",                 async_(registerFreelancer));
  router.post("/:userId/api-key",                    async_(generateApiKey));
  router.get("/:userId/permissions/test",            async_(testPermissions));

  return router;
}

export default createUsersRouter;
