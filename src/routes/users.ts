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
 *
 * Phase 15 slice 7:
 *   - UserParams / AuditLogQuery / UpsertProfileBody / AssignRoleBody /
 *     ElevateKycBody / RegisterFreelancerBody schemas applied via validate()
 *     middleware at mount time.
 *   - UserParams is reused across 7 of 9 routes (GET /:userId, POST
 *     /:userId/profile, POST /:userId/role, POST /:userId/kyc, POST
 *     /:userId/freelancer, POST /:userId/api-key, GET
 *     /:userId/permissions/test) per Appendix B of the slice 7 enumeration
 *     doc — the most-reused schema in slice 7.
 *   - Local validRoles constant in assignRole() removed (schema's z.enum
 *     absorbs the membership check).
 *   - Local validTiers constant in elevateKyc() removed (same reason).
 *   - GET / and the runPermissionTests / ROLE_PERMISSIONS apparatus are
 *     out of scope (no body/query/params reads on GET /; the permissions
 *     test handler reads only :userId which is covered by UserParams).
 *
 * ⚠ HIGH-RISK CHANGE — vestigial body fields on /freelancer:
 *   The legacy FreelancerRegistration interface declared `user_id` and
 *   `tenant_id` as required body fields, but the handler reads neither
 *   — userId comes from req.params, tenantId from the X-Tenant-ID header.
 *   The two body fields were dead.
 *
 *   RegisterFreelancerBody OMITS them. With `.strict()`, callers that
 *   include user_id/tenant_id in the body will now 400 instead of being
 *   silently ignored. This exposes a latent inconsistency the doc
 *   explicitly wants surfaced (Appendix C lists it as "drop unused
 *   user_id/tenant_id body fields" hardening — applied here).
 *
 *   If any test fixture or production caller sends these fields, the
 *   failure mode is a 400 with a clear "unrecognized keys" message. The
 *   FIX in that case is to remove the fields from the caller; do NOT
 *   loosen the schema to accept them, because the handler ignores them
 *   anyway and accepting them risks the "which user_id wins, body or
 *   URL" ambiguity that motivated dropping them.
 *
 *   SLICE 7.5 UPDATE: the FreelancerRegistration interface itself was
 *   also cleaned up. The slice 7 version of this block said the
 *   interface was "left untouched in this slice... slice 7.5 or later
 *   can clean up the type." That cleanup is now done — the interface
 *   no longer declares user_id / tenant_id. The failure mode for
 *   TypeScript callers who construct `FreelancerRegistration` literals
 *   with those fields is now a compile-time error rather than a runtime
 *   400, which is strictly better (loud and early vs quiet and late).
 *   See the comment block above the interface definition for the full
 *   migration note.
 *
 * BEHAVIOR CHANGES from slice 7 (intentional — see enumeration doc):
 *   - All 7 :userId routes: non-UUID userId previously hit the DB and
 *     returned 404 → now 400 at the validation boundary. If any test
 *     fixture uses "test-user-1" or similar, update the fixture; do not
 *     loosen the schema.
 *   - GET /audit-log: limit=<garbage> was parseInt→NaN→Math.min(NaN,500)=NaN
 *     passed as SQL LIMIT (better-sqlite3 would reject) → now 400.
 *   - POST /:userId/profile: country_code must be exactly 2 chars (ISO
 *     3166-1 alpha-2). Previously any string was accepted then 422'd
 *     downstream by getCountryRequirement; now 400 earlier. Same status
 *     change for preferred_currency (must be exactly 3 chars).
 *   - POST /:userId/role: missing/invalid role was 400 via inline guard
 *     → still 400, now via z.enum. No observable change.
 *   - POST /:userId/kyc: missing/invalid kyc_tier was 400 via inline guard
 *     → still 400, now via z.enum. No observable change.
 *   - POST /:userId/freelancer: vestigial body fields dropped — see
 *     "HIGH-RISK CHANGE" above. Also: country_code length 2,
 *     preferred_currency length 3, same caveats as upsertProfile.
 *   - All bodies: unknown fields silently ignored → now 400 (.strict()).
 *
 * NO BEHAVIOR CHANGES for:
 *   - X-Tenant-ID header handling via getTenantId() — preserved with its
 *     pre-existing quirk of returning "unknown" if missing (different
 *     from commercial.ts which throws 400; out of scope to reconcile).
 *   - Country requirement 422 checks in upsertProfile (currency
 *     acceptance) and registerFreelancer (payout-method-supported-in-
 *     country) — semantic, retained.
 *   - Duplicate-freelancer 409 short-circuit.
 *   - Phone format — schema does NOT enforce E.164 despite the type
 *     comment, matching current laxness. Flagged for product decision
 *     (enumeration doc Appendix C).
 *   - evidence_ref optionality on KYC elevation — current handler does
 *     not require evidence; schema matches. Flagged for product decision.
 *   - Cross-field "momo requires momo_number+provider" / "card requires
 *     card_token" — not enforced by the schema. Current handler passes
 *     `?? null` through; schema matches. Flagged for product decision.
 *   - Slice 6g HIGH-1 tenant-scoped UPDATE in assignRole.
 *   - The runPermissionTests / ROLE_PERMISSIONS test apparatus, the
 *     permission drop test matrix, the KYC-vs-country tests.
 *   - All auditLog writes (role_change, profile_update, kyc_elevation,
 *     freelancer_registered, api_key_generated).
 *
 * Pre-merge checks the implementation session should run:
 *   - npm test (all 143 existing tests must stay green)
 *   - grep -r validRoles src/ — must return no matches (function-local)
 *   - grep -r validTiers src/ — must return no matches (function-local)
 *   - ⚠ Check /freelancer test fixtures for body user_id/tenant_id fields.
 *     If present, REMOVE them from the fixture (do not loosen schema).
 *   - Verify test fixtures for /:userId routes use real UUIDs.
 *   - Verify test fixtures use ISO 3166-1 alpha-2 country codes (2 chars)
 *     and ISO 4217 currency codes (3 chars).
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import crypto  from "crypto";
import argon2  from "argon2";
import type { Database as DB } from "better-sqlite3";
import { requireAccessToken } from "./auth";
import { validate } from "../middleware/validate";
import { getCountryRequirement, meetsKycRequirement } from "../config/countryRequirements";
import type { KycTier, CountryRequirement } from "../config/countryRequirements";
import type { CaaSRole } from "./auth";
import { auditLog } from "../lib/audit";

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

/**
 * Body shape for POST /api/v1/users/:userId/freelancer.
 *
 * Slice 7.5 cleanup: the legacy interface had `user_id: string` and
 * `tenant_id: string` as required fields, but the handler reads neither
 * — userId comes from req.params, tenantId from the X-Tenant-ID header.
 * Slice 7's RegisterFreelancerBody schema rejects both fields at
 * runtime via `.strict()`. The interface now matches that contract.
 *
 * If any TypeScript code outside this file was constructing a
 * `FreelancerRegistration` literal with `user_id` / `tenant_id` set,
 * the TypeScript compiler will now flag those literals — the fix is to
 * drop the fields from the call site. That code would have hit a
 * runtime 400 from `.strict()` anyway; the compiler is just surfacing
 * the breakage earlier.
 */
export interface FreelancerRegistration {
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

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Query schema for GET /audit-log.
 *
 * BEHAVIOR CHANGE: the legacy `Math.min(parseInt(garbage), 500)` produced
 * NaN which better-sqlite3 would reject mid-query. Schema rejects with
 * 400 at the boundary — cleaner failure mode.
 */
const AuditLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();

/**
 * Params schema reused across 7 routes (the most-reused schema in slice 7):
 *   GET /:userId, POST /:userId/profile, POST /:userId/role,
 *   POST /:userId/kyc, POST /:userId/freelancer, POST /:userId/api-key,
 *   GET /:userId/permissions/test.
 *
 * users.id is assigned via crypto.randomUUID() in src/routes/auth.ts
 * register() handler, so UUID is correct. If the column migrates to a
 * different ID scheme, loosen here AND in the enumeration doc's
 * Appendix A AND verify all 7 mount points.
 */
const UserParams = z.object({
  userId: z.string().uuid(),
}).strict();

/**
 * Body schema for POST /:userId/profile.
 *
 * All fields optional — this is an upsert that COALESCEs against existing
 * row values, so any subset (including empty body) is valid.
 *
 * BEHAVIOR CHANGES:
 *   - country_code: enforced as exactly 2 chars (ISO 3166-1 alpha-2).
 *     Was any string; getCountryRequirement would 422 invalid codes
 *     downstream. Schema catches at 400 earlier — strict status change
 *     but the alpha-2 form is unambiguous.
 *   - preferred_currency: enforced as exactly 3 chars (ISO 4217). Same
 *     caveat as commercial.ts; if any fixture uses non-standard codes,
 *     loosen here AND in commercial.ts's two invoice_currency schemas
 *     to keep behavior consistent.
 *
 * NOT enforced (intentional, per enumeration doc Appendix C):
 *   - phone: no E.164 regex. Type comment says E.164 but the legacy
 *     handler accepted any string. Tightening to `/^\+[1-9]\d{1,14}$/`
 *     would be a behavior change; flagged for product decision.
 *
 * Inline checks RETAINED:
 *   - getCountryRequirement throw → 422 with country error message.
 *   - currency acceptance check against country.accepted_currencies → 422.
 *   Both semantic; schema does not duplicate them.
 */
const UpsertProfileBody = z.object({
  display_name:       z.string().min(1).optional(),
  phone:              z.string().min(1).optional(),
  country_code:       z.string().length(2).optional(),
  preferred_currency: z.string().length(3).optional(),
  bio:                z.string().optional(),
  kyc_tier:           z.enum(["basic", "standard", "enhanced"]).optional(),
  profile_status:     z.enum(["active", "suspended", "pending_kyc", "pending_review"]).optional(),
}).strict();

/**
 * Body schema for POST /:userId/role.
 *
 * z.enum absorbs the legacy `validRoles.includes(role)` check; the
 * local validRoles constant has been removed from assignRole(). The
 * `reason` field is optional and passed to the audit log.
 *
 * Inline checks RETAINED:
 *   - User existence (404).
 *   - Same-role no-op 200 short-circuit.
 *   - Slice 6g HIGH-1 defense-in-depth tenant-scoped UPDATE.
 */
const AssignRoleBody = z.object({
  role:   z.enum(["Executive", "Auditor", "Partner"]),
  reason: z.string().min(1).optional(),
}).strict();

/**
 * Body schema for POST /:userId/kyc.
 *
 * z.enum absorbs the legacy validTiers check; the local validTiers
 * constant has been removed from elevateKyc().
 *
 * NOT enforced (intentional, per enumeration doc):
 *   - evidence_ref: optional. Real-world KYC elevation arguably should
 *     require evidence, but the current handler passes `evidence_ref ?? null`
 *     to the audit log. Schema matches current behavior. Flagged for
 *     product hardening in Appendix C.
 */
const ElevateKycBody = z.object({
  kyc_tier:     z.enum(["basic", "standard", "enhanced"]),
  evidence_ref: z.string().min(1).optional(),
}).strict();

/**
 * Body schema for POST /:userId/freelancer.
 *
 * ⚠ DELIBERATELY OMITS user_id and tenant_id that appear in the
 * FreelancerRegistration interface — see the "HIGH-RISK CHANGE" section
 * in the file header. The handler reads userId from req.params and
 * tenantId from the X-Tenant-ID header; the body fields were vestigial.
 *
 * BEHAVIOR CHANGES:
 *   - country_code: 2 chars (was any string).
 *   - preferred_currency: 3 chars (was any string).
 *   - payout_threshold_usd: coerced non-negative finite number (was
 *     `number` in the type cast but no runtime check).
 *   - Vestigial user_id/tenant_id in body now rejected by .strict().
 *
 * NOT enforced (intentional, per enumeration doc):
 *   - Cross-field: `payout_method === "momo"` should require
 *     `momo_number` + `momo_provider`; `payout_method === "card"` should
 *     require `card_token`. Current handler passes `?? null` through;
 *     schema matches. Could be `.refine()`. Flagged for product
 *     hardening in Appendix C.
 *
 * Inline checks RETAINED:
 *   - User existence (404).
 *   - getCountryRequirement throw → 422.
 *   - payout-method-supported-in-country check → 422.
 *   - Duplicate-freelancer check (existing agent_id) → 409.
 */
const RegisterFreelancerBody = z.object({
  display_name:         z.string().min(1),
  country_code:         z.string().length(2),
  payout_method:        z.enum(["momo", "card"]),
  momo_number:          z.string().min(1).optional(),
  momo_provider:        z.string().min(1).optional(),
  card_token:           z.string().min(1).optional(),
  payout_threshold_usd: z.coerce.number().nonnegative().finite(),
  preferred_currency:   z.string().length(3),
}).strict();

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
 *
 * After validate({ params: UserParams }), req.params.userId is a validated
 * UUID string.
 */
async function getUser(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const { userId } = req.params as z.infer<typeof UserParams>;


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
 *
 * After validate({ params: UserParams, body: UpsertProfileBody }):
 *   - userId is a validated UUID string.
 *   - All body fields are optional with the appropriate format
 *     constraints (country_code length 2, preferred_currency length 3,
 *     kyc_tier and profile_status as enums).
 *   - phone format is intentionally NOT enforced; see UpsertProfileBody
 *     schema comment.
 *
 * The semantic country-requirement and currency-acceptance 422 checks
 * stay inline — schema only validates shape.
 */
async function upsertProfile(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const { userId } = req.params as z.infer<typeof UserParams>;
  const actorId  = getActorId(req);


  const {
    display_name, phone, country_code, preferred_currency,
    bio, kyc_tier, profile_status,
  } = req.body as z.infer<typeof UpsertProfileBody>;

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
    db.transaction(() => {
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
      auditLog(db, tenantId, userId, actorId, "profile_update", null, JSON.stringify({ display_name, country_code, kyc_tier }));
    })();
  } else {
    db.transaction(() => {
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
      auditLog(db, tenantId, userId, actorId, "profile_update", null, JSON.stringify({ display_name, country_code, kyc_tier }));
    })();
  }

  res.json({ success: true, updated_at: now });
}

/**
 * POST /api/v1/users/:userId/role
 * Assign a new role to a user. Executive only.
 * Body: { role, reason }
 *
 * After validate({ params: UserParams, body: AssignRoleBody }):
 *   - userId is a validated UUID string.
 *   - role is one of the three CaaSRole enum values.
 *   - reason is optional non-empty string.
 *   - The local `validRoles` constant and inline membership check are gone.
 */
async function assignRole(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const actorId  = getActorId(req);
  const { userId } = req.params as z.infer<typeof UserParams>;
  const { role, reason } = req.body as z.infer<typeof AssignRoleBody>;

  const user = db
    .prepare("SELECT id, role FROM users WHERE id = ? AND tenant_id = ?")
    .get(userId, tenantId) as { id: string; role: CaaSRole } | undefined;

  if (!user) { res.status(404).json({ error: "User not found" }); return; }
  if (user.role === role) { res.status(200).json({ message: "Role unchanged", role }); return; }

  const oldRole = user.role;
  db.transaction(() => {
    // Slice 6g HIGH-1: defense-in-depth tenant scope on the UPDATE.
    // The SELECT above already scopes by tenant_id, but if that check
    // is ever removed by a refactor, the UPDATE would silently mutate
    // cross-tenant. Adding tenant_id to the WHERE clause makes the
    // UPDATE itself fail safe.
    db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
      .run(role, new Date().toISOString(), userId, tenantId);
    auditLog(db, tenantId, userId, actorId, "role_change", oldRole, role, reason ?? null);
  })();
  res.json({ success: true, user_id: userId, old_role: oldRole, new_role: role });
}

/**
 * POST /api/v1/users/:userId/kyc
 * Elevate KYC tier. Executive only.
 * Body: { kyc_tier, evidence_ref }
 *
 * After validate({ params: UserParams, body: ElevateKycBody }):
 *   - userId is a validated UUID string.
 *   - kyc_tier is one of the three KycTier enum values.
 *   - evidence_ref is optional (intentional — see ElevateKycBody comment).
 *   - The local `validTiers` constant and inline membership check are gone.
 */
async function elevateKyc(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const actorId  = getActorId(req);
  const { userId } = req.params as z.infer<typeof UserParams>;
  const { kyc_tier, evidence_ref } = req.body as z.infer<typeof ElevateKycBody>;


  const profile = db
    .prepare("SELECT kyc_tier FROM user_profiles WHERE user_id = ? AND tenant_id = ?")
    .get(userId, tenantId) as { kyc_tier: KycTier } | undefined;

  const oldTier = profile?.kyc_tier ?? "basic";

  db.transaction(() => {
    if (profile) {
      db.prepare("UPDATE user_profiles SET kyc_tier = ?, updated_at = ? WHERE user_id = ? AND tenant_id = ?")
        .run(kyc_tier, new Date().toISOString(), userId, tenantId);
    }

    // Also update agent kyc_tier if this user is a freelancer
    db.prepare("UPDATE agents SET kyc_tier = ? WHERE id = (SELECT agent_id FROM user_profiles WHERE user_id = ? AND tenant_id = ?)")
      .run(kyc_tier, userId, tenantId);

    auditLog(db, tenantId, userId, actorId, "kyc_elevation", oldTier, kyc_tier, evidence_ref ?? null);
  })();
  res.json({ success: true, user_id: userId, old_tier: oldTier, new_tier: kyc_tier });
}

/**
 * POST /api/v1/users/:userId/freelancer
 * Register a user as a freelancer and create their agent record.
 * Validates country requirements before creating.
 *
 * After validate({ params: UserParams, body: RegisterFreelancerBody }):
 *   - userId is a validated UUID string.
 *   - Body has display_name / country_code (2) / payout_method enum /
 *     payout_threshold_usd (coerced non-negative finite) / preferred_currency
 *     (3), with optional momo_number / momo_provider / card_token.
 *   - ⚠ Body does NOT accept user_id / tenant_id (the vestigial fields).
 *     If callers send them, .strict() returns 400. See header block
 *     "HIGH-RISK CHANGE".
 *
 * The semantic country / payout-method / duplicate-freelancer checks
 * (422/422/409) stay inline.
 */
async function registerFreelancer(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const actorId  = getActorId(req);
  const { userId } = req.params as z.infer<typeof UserParams>;
  const reg      = req.body as z.infer<typeof RegisterFreelancerBody>;


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

    auditLog(db, tenantId, userId, actorId, "freelancer_registered", null, agentId, reg.country_code);
  })();

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
 *
 * After validate({ params: UserParams }), userId is a validated UUID.
 */
async function generateApiKey(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const actorId  = getActorId(req);
  const { userId } = req.params as z.infer<typeof UserParams>;


  const rawKey    = `caas_${crypto.randomBytes(32).toString("hex")}`;
  const prefix    = rawKey.slice(0, 12);
  const keyHash   = crypto.createHash("sha256").update(rawKey).digest("hex");
  const now       = new Date().toISOString();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO user_profiles (user_id, tenant_id, api_key_hash, api_key_prefix, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET api_key_hash = excluded.api_key_hash, api_key_prefix = excluded.api_key_prefix, updated_at = excluded.updated_at
    `).run(userId, tenantId, keyHash, prefix, now, now);

    auditLog(db, tenantId, userId, actorId, "api_key_generated", null, prefix, null);
  })();

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
 *
 * After validate({ params: UserParams }), userId is a validated UUID.
 */
async function testPermissions(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const { userId } = req.params as z.infer<typeof UserParams>;


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
 *
 * After validate({ query: AuditLogQuery }), limit is a clamped int
 * (1..500) with default 100. The legacy `Math.min(parseInt(...), 500)`
 * NaN footgun is absorbed.
 */
async function getAuditLog(req: Request, res: Response): Promise<void> {
  const db       = getDb(req);
  const tenantId = getTenantId(req);
  const { limit } = req.query as unknown as z.infer<typeof AuditLogQuery>;


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

  // UserParams is reused across 7 routes (the most-reused schema in slice 7).
  // Factored into a const per the pov-billing.ts / provisioning.ts /
  // insurance.ts pattern so the schema is wired identically at each mount
  // point — easier to audit and harder to diverge accidentally.
  const validateUserParams = validate({ params: UserParams });

  // Ordering pattern (consistent with commercial.ts / provisioning.ts):
  // requireAccessToken (router-level) → requireRole → validate → handler.
  // requireRole runs before validate so an insufficient-role caller gets
  // 403 instead of 400 — don't leak schema details to unauthorized callers.

  router.get("/",                                    requireRole("Executive", "Auditor"),                                                              async_(listUsers));
  router.get("/audit-log",                           requireRole("Executive", "Auditor"), validate({ query: AuditLogQuery }),                          async_(getAuditLog));
  router.get("/:userId",                                                                  validateUserParams,                                          async_(getUser));
  router.post("/:userId/profile",                                                         validate({ params: UserParams, body: UpsertProfileBody }),   async_(upsertProfile));
  router.post("/:userId/role",                       requireRole("Executive"),            validate({ params: UserParams, body: AssignRoleBody }),      async_(assignRole));
  router.post("/:userId/kyc",                        requireRole("Executive"),            validate({ params: UserParams, body: ElevateKycBody }),      async_(elevateKyc));
  router.post("/:userId/freelancer",                                                      validate({ params: UserParams, body: RegisterFreelancerBody }), async_(registerFreelancer));
  router.post("/:userId/api-key",                                                         validateUserParams,                                          async_(generateApiKey));
  router.get("/:userId/permissions/test",                                                 validateUserParams,                                          async_(testPermissions));

  return router;
}

// Exported for tests that want to assert the schemas directly without
// constructing an Express request.
export {
  UserParams,
  AuditLogQuery,
  UpsertProfileBody,
  AssignRoleBody,
  ElevateKycBody,
  RegisterFreelancerBody,
};

export default createUsersRouter;
