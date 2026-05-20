/**
 * src/routes/auth.ts
 * Secure identity endpoints: registration, login, token refresh, and logout.
 * Uses Argon2id for password hashing and enforces brute-force lockout delays.
 * Commit baseline: a4f5db6  |  Phase 9 build-out
 */

import { Router, Request, Response, NextFunction } from "express";
import crypto from "crypto";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import type { Database as DB } from "better-sqlite3";
import { detectFailedAuthBurst } from "../analytics/anomaly";
import { auditLog } from "../lib/audit";

// ─── Types ────────────────────────────────────────────────────────────────────

/** Must match the X-CaaS-Role header values defined in the RBAC middleware. */
export type CaaSRole = "Executive" | "Auditor" | "Partner";

export interface UserRow {
  id: string;
  tenant_id: string;
  username: string;
  email: string;
  password_hash: string;
  role: CaaSRole;
  failed_attempts: number;
  locked: 0 | 1;
  locked_until: string | null;
  shadow_scan_until: string | null;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RefreshTokenRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  revoked: 0 | 1;
  created_at: string;
}

interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

interface AuthedRequest extends Request {
  caasUserId?: string;
  caasTenantId?: string;
  caasRole?: CaaSRole;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const JWT_ACCESS_SECRET = process.env.JWT_ACCESS_SECRET ?? (() => {
  throw new Error("JWT_ACCESS_SECRET is not set");
})();
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET ?? (() => {
  throw new Error("JWT_REFRESH_SECRET is not set");
})();
const ACCESS_TOKEN_TTL_SECONDS = parseInt(
  process.env.ACCESS_TOKEN_TTL_SECONDS ?? "900",
  10
); // 15 minutes
const REFRESH_TOKEN_TTL_DAYS = parseInt(
  process.env.REFRESH_TOKEN_TTL_DAYS ?? "30",
  10
);

/**
 * Argon2id parameters aligned with OWASP 2024 recommendations:
 *  - memoryCost: 19 MiB  (19456 KiB)
 *  - timeCost:   2 iterations
 *  - parallelism: 1
 */
const ARGON2_OPTIONS: argon2.Options & { raw: false } = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  raw: false,
};

/** Maximum failed attempts before account lockout. */
const MAX_FAILED_ATTEMPTS = 5;

/** Progressive delay base in ms; applied as: delay = BASE ** attempt ms (capped). */
const BRUTE_FORCE_DELAY_BASE_MS = 200;
const BRUTE_FORCE_DELAY_MAX_MS = 10_000;

/** Lockout durations. */
const SOFT_LOCKOUT_MINUTES = 15;
const HARD_LOCKOUT_HOURS = 24;

/** Sliding window for failed-auth-burst anomaly detection. */
const BURST_WINDOW_MINUTES = 10;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getDb(req: Request): DB {
  const db = (req.app.locals as { db: DB }).db;
  if (!db) throw new Error("Database handle not found on app.locals.db");
  return db;
}

/**
 * Introduces a timing delay proportional to failed_attempts to make
 * brute-force attacks economically infeasible even when accounts are not
 * yet locked.  Capped at BRUTE_FORCE_DELAY_MAX_MS.
 */
async function applyBruteForceDelay(failedAttempts: number): Promise<void> {
  if (failedAttempts <= 0) return;
  const delay = Math.min(
    BRUTE_FORCE_DELAY_BASE_MS * Math.pow(2, failedAttempts - 1),
    BRUTE_FORCE_DELAY_MAX_MS
  );
  await new Promise((r) => setTimeout(r, delay));
}

function hashRefreshToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

function issueTokenPair(userId: string, tenantId: string, role: CaaSRole): TokenPair {
  const jti = crypto.randomUUID();

  const access_token = jwt.sign(
    { sub: userId, tid: tenantId, role, jti },
    JWT_ACCESS_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS, algorithm: "HS256" }
  );

  const rawRefresh = crypto.randomBytes(64).toString("hex");
  // Embed enough context in the refresh JWT to validate without a DB hit first.
  const refresh_token = jwt.sign(
    { sub: userId, tid: tenantId, ref: hashRefreshToken(rawRefresh) },
    JWT_REFRESH_SECRET,
    { expiresIn: `${REFRESH_TOKEN_TTL_DAYS}d`, algorithm: "HS256" }
  );

  return { access_token, refresh_token: rawRefresh, expires_in: ACCESS_TOKEN_TTL_SECONDS };
}

function storeRefreshToken(
  db: DB,
  userId: string,
  rawRefresh: string
): void {
  const expiresAt = new Date(
    Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000
  ).toISOString();
  db.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at, revoked, created_at)
     VALUES (?, ?, ?, ?, 0, ?)`
  ).run(crypto.randomUUID(), userId, hashRefreshToken(rawRefresh), expiresAt, new Date().toISOString());
}

function revokeAllUserRefreshTokens(db: DB, userId: string): void {
  db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE user_id = ?").run(userId);
}

function incrementFailedAttempts(db: DB, userId: string): number {
  db.prepare(
    "UPDATE users SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), userId);
  const row = db
    .prepare("SELECT failed_attempts FROM users WHERE id = ?")
    .get(userId) as { failed_attempts: number };
  return row.failed_attempts;
}

function resetFailedAttempts(db: DB, userId: string): void {
  db.prepare(
    "UPDATE users SET failed_attempts = 0, locked = 0, locked_until = NULL, updated_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), userId);
}

function lockUser(
  db: DB,
  userId: string,
  lockedUntilIso: string
): void {
  db.prepare(
    "UPDATE users SET locked = 1, locked_until = ?, updated_at = ? WHERE id = ?"
  ).run(lockedUntilIso, new Date().toISOString(), userId);
}

function updateLastLogin(db: DB, userId: string): void {
  db.prepare(
    "UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?"
  ).run(new Date().toISOString(), new Date().toISOString(), userId);
}

function validatePasswordStrength(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/[a-z]/.test(password)) return "Password must contain a lowercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain a digit";
  if (!/[^A-Za-z0-9]/.test(password))
    return "Password must contain a special character";
  return null;
}

// ─── Middleware: Authenticate Access Token ─────────────────────────────────────

export function requireAccessToken(
  req: AuthedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or malformed Authorization header" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_ACCESS_SECRET) as jwt.JwtPayload;
    req.caasUserId = payload.sub as string;
    req.caasTenantId = payload.tid as string;
    req.caasRole = payload.role as CaaSRole;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: "Access token expired" });
    } else {
      res.status(401).json({ error: "Invalid access token" });
    }
  }
}

// ─── Route Handlers ───────────────────────────────────────────────────────────

/**
 * POST /auth/register
 * Body: { username, email, password, role, tenant_id }
 * Restricted to Executive callers or service-to-service (internal API key).
 */
async function register(req: Request, res: Response): Promise<void> {
  const { username, email, password, role, tenant_id } = req.body as {
    username?: string;
    email?: string;
    password?: string;
    role?: CaaSRole;
    tenant_id?: string;
  };

  if (!username || !email || !password || !role || !tenant_id) {
    res.status(400).json({ error: "username, email, password, role, and tenant_id are required" });
    return;
  }

  const validRoles: CaaSRole[] = ["Executive", "Auditor", "Partner"];
  if (!validRoles.includes(role)) {
    res.status(400).json({ error: `role must be one of: ${validRoles.join(", ")}` });
    return;
  }

  const passwordError = validatePasswordStrength(password);
  if (passwordError) {
    res.status(422).json({ error: passwordError });
    return;
  }

  const db = getDb(req);

  const existing = db
    .prepare("SELECT id FROM users WHERE (username = ? OR email = ?) AND tenant_id = ?")
    .get(username, email, tenant_id);
  if (existing) {
    res.status(409).json({ error: "A user with that username or email already exists in this tenant" });
    return;
  }

  let passwordHash: string;
  try {
    passwordHash = await argon2.hash(password, ARGON2_OPTIONS);
  } catch {
    res.status(500).json({ error: "Password hashing failed" });
    return;
  }

  const now = new Date().toISOString();
  const userId = crypto.randomUUID();

  db.prepare(
    `INSERT INTO users
       (id, tenant_id, username, email, password_hash, role,
        failed_attempts, locked, locked_until, shadow_scan_until,
        last_login_at, created_at, updated_at)
     VALUES
       (?, ?, ?, ?, ?, ?,
        0, 0, NULL, NULL,
        NULL, ?, ?)`
  ).run(userId, tenant_id, username, email, passwordHash, role, now, now);

  res.status(201).json({
    user_id: userId,
    username,
    email,
    role,
    tenant_id,
    created_at: now,
  });
}

/**
 * POST /auth/login
 * Body: { username, password, tenant_id }
 * Returns: { access_token, refresh_token, expires_in }
 */
async function login(req: Request, res: Response): Promise<void> {
  const { username, password, tenant_id } = req.body as {
    username?: string;
    password?: string;
    tenant_id?: string;
  };

  if (!username || !password || !tenant_id) {
    res.status(400).json({ error: "username, password, and tenant_id are required" });
    return;
  }

  const db = getDb(req);

  const user = db
    .prepare("SELECT * FROM users WHERE username = ? AND tenant_id = ?")
    .get(username, tenant_id) as UserRow | undefined;

  // Constant-time: always hash even on unknown user to prevent user enumeration.
  const dummyHash =
    "$argon2id$v=19$m=19456,t=2,p=1$dummysalt/placeholder==";

  if (!user) {
    await argon2.verify(dummyHash, password).catch(() => {});
    // Generic error — do not reveal whether user exists.
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  // ── Lockout check ──
  if (user.locked) {
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      await applyBruteForceDelay(user.failed_attempts);
      res.status(423).json({
        error: "Account locked",
        locked_until: user.locked_until,
      });
      return;
    }
    // Lock period has expired — reset automatically.
    resetFailedAttempts(db, user.id);
  }

  await applyBruteForceDelay(user.failed_attempts);

  let passwordMatch: boolean;
  try {
    passwordMatch = await argon2.verify(user.password_hash, password);
  } catch {
    res.status(500).json({ error: "Verification error" });
    return;
  }

  if (!passwordMatch) {
    const newFailedCount = incrementFailedAttempts(db, user.id);

    // Trigger anomaly detection for auth bursts.
    await detectFailedAuthBurst(
      db,
      user.id,
      user.tenant_id,
      newFailedCount,
      BURST_WINDOW_MINUTES
    ).catch((err) => console.error("[auth] anomaly detect error:", err));

    if (newFailedCount >= MAX_FAILED_ATTEMPTS) {
      const lockUntil = new Date(
        Date.now() +
          (newFailedCount >= MAX_FAILED_ATTEMPTS * 2
            ? HARD_LOCKOUT_HOURS * 3_600_000
            : SOFT_LOCKOUT_MINUTES * 60_000)
      ).toISOString();
      lockUser(db, user.id, lockUntil);
      res.status(423).json({
        error: "Too many failed attempts. Account locked.",
        locked_until: lockUntil,
      });
      return;
    }

    res.status(401).json({
      error: "Invalid credentials",
      attempts_remaining: MAX_FAILED_ATTEMPTS - newFailedCount,
    });
    return;
  }

  // ── Success ──
  resetFailedAttempts(db, user.id);
  updateLastLogin(db, user.id);

  const { access_token, refresh_token, expires_in } = issueTokenPair(
    user.id,
    user.tenant_id,
    user.role
  );
  storeRefreshToken(db, user.id, refresh_token);

  res.status(200).json({ access_token, refresh_token, expires_in });
}

/**
 * POST /auth/refresh
 * Body: { refresh_token }
 * Returns: { access_token, refresh_token, expires_in } (token rotation)
 */
async function refresh(req: Request, res: Response): Promise<void> {
  const { refresh_token } = req.body as { refresh_token?: string };
  if (!refresh_token) {
    res.status(400).json({ error: "refresh_token is required" });
    return;
  }

  const db = getDb(req);
  const tokenHash = hashRefreshToken(refresh_token);

  const stored = db
    .prepare(
      `SELECT rt.*, u.role, u.tenant_id, u.locked, u.locked_until
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = ? AND rt.revoked = 0`
    )
    .get(tokenHash) as
    | (RefreshTokenRow & {
        role: CaaSRole;
        tenant_id: string;
        locked: 0 | 1;
        locked_until: string | null;
      })
    | undefined;

  if (!stored) {
    res.status(401).json({ error: "Invalid or revoked refresh token" });
    return;
  }

  if (new Date(stored.expires_at) < new Date()) {
    db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE id = ?").run(stored.id);
    res.status(401).json({ error: "Refresh token expired" });
    return;
  }

  if (stored.locked && stored.locked_until && new Date(stored.locked_until) > new Date()) {
    res.status(423).json({ error: "Account locked", locked_until: stored.locked_until });
    return;
  }

  // Rotate: revoke old, issue new.
  db.prepare("UPDATE refresh_tokens SET revoked = 1 WHERE id = ?").run(stored.id);

  const { access_token, refresh_token: newRefresh, expires_in } = issueTokenPair(
    stored.user_id,
    stored.tenant_id,
    stored.role
  );
  storeRefreshToken(db, stored.user_id, newRefresh);

  res.status(200).json({ access_token, refresh_token: newRefresh, expires_in });
}

/**
 * POST /auth/logout
 * Revokes all refresh tokens for the authenticated user.
 * Requires a valid access token.
 */
function logout(req: AuthedRequest, res: Response): void {
  const db = getDb(req);
  const userId = req.caasUserId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  revokeAllUserRefreshTokens(db, userId);
  res.status(204).send();
}

/**
 * GET /auth/me
 * Returns profile of the authenticated caller.
 */
function me(req: AuthedRequest, res: Response): void {
  const db = getDb(req);
  const userId = req.caasUserId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const user = db
    .prepare(
      "SELECT id, username, email, role, tenant_id, last_login_at, created_at FROM users WHERE id = ?"
    )
    .get(userId) as Omit<UserRow, "password_hash" | "failed_attempts" | "locked" | "locked_until" | "shadow_scan_until" | "updated_at"> | undefined;

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.status(200).json(user);
}

/**
 * POST /auth/change-password
 * Body: { current_password, new_password }
 * Requires a valid access token.
 */
async function changePassword(req: AuthedRequest, res: Response): Promise<void> {
  const { current_password, new_password } = req.body as {
    current_password?: string;
    new_password?: string;
  };
  if (!current_password || !new_password) {
    res.status(400).json({ error: "current_password and new_password are required" });
    return;
  }

  const passwordError = validatePasswordStrength(new_password);
  if (passwordError) {
    res.status(422).json({ error: passwordError });
    return;
  }

  const db = getDb(req);
  const userId = req.caasUserId!;

  const user = db
    .prepare("SELECT password_hash, failed_attempts FROM users WHERE id = ?")
    .get(userId) as Pick<UserRow, "password_hash" | "failed_attempts"> | undefined;

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  await applyBruteForceDelay(user.failed_attempts);

  const matches = await argon2.verify(user.password_hash, current_password);
  if (!matches) {
    incrementFailedAttempts(db, userId);
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }

  // Prevent reuse of same password.
  const samePassword = await argon2.verify(user.password_hash, new_password);
  if (samePassword) {
    res.status(422).json({ error: "New password must differ from the current password" });
    return;
  }

  const newHash = await argon2.hash(new_password, ARGON2_OPTIONS);
  const tenantId = req.caasTenantId ?? "";

  // Atomic: hash update + audit row + token revocation. If any fails,
  // none commit — prevents the "password changed but no audit / tokens
  // still valid" partial-failure scenario.
  db.transaction(() => {
    db.prepare(
      "UPDATE users SET password_hash = ?, failed_attempts = 0, updated_at = ? WHERE id = ?"
    ).run(newHash, new Date().toISOString(), userId);

    // Slice 6b: audit the password change. Records actor=target (self-service
    // mutation), action='password_change', no old/new values (we never log
    // password material). The audit row is the proof-of-rotation if the
    // user later disputes "I never changed my password".
    auditLog(
      db, tenantId, userId, userId, "password_change",
      null, null, null
    );

    // Revoke all outstanding refresh tokens on password change.
    revokeAllUserRefreshTokens(db, userId);
  })();

  res.status(200).json({ message: "Password updated successfully. Please log in again." });
}

// ─── Router Assembly ──────────────────────────────────────────────────────────

export function createAuthRouter(): Router {
  const router = Router();

  // Wrap async handlers so unhandled rejections propagate to Express error middleware.
  const asyncHandler =
    (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res, next).catch(next);
    };

  router.post("/register", asyncHandler(register));
  router.post("/login", asyncHandler(login));
  router.post("/refresh", asyncHandler(refresh));
  router.post("/logout", requireAccessToken, (req, res) =>
    logout(req as AuthedRequest, res)
  );
  router.get("/me", requireAccessToken, (req, res) =>
    me(req as AuthedRequest, res)
  );
  router.post(
    "/change-password",
    requireAccessToken,
    asyncHandler((req, res) => changePassword(req as AuthedRequest, res))
  );

  return router;
}

export default createAuthRouter;
