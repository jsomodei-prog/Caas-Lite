/**
 * src/middleware/dualPlaneAuth.ts
 * Dual-Plane Role Classification & Boundary Enforcement Middleware.
 *
 * Architecture:
 *   BUSINESS PLANE — Cross-tenant operational visibility.
 *     global_super_admin   Full platform control. No tenant restriction.
 *     platform_auditor     Read-only across all tenants.
 *     platform_finance     Commercial and billing data across all tenants.
 *     platform_ops         Infrastructure, backup, replication management.
 *     platform_support     Scoped read access for support escalation.
 *
 *   CLIENT PLANE — Scoped to a single tenant_id.
 *     client_super_admin   Full control within their tenant.
 *     client_executive     Invoice, compliance, underwriting within tenant.
 *     client_auditor       Read-only anomaly and report access within tenant.
 *     client_finance       Billing and payout visibility within tenant.
 *     client_partner       Own profile and payout history only.
 *
 * Boundary Rules:
 *   1. CLIENT plane users cannot access BUSINESS plane resources.
 *   2. BUSINESS plane users cannot mutate CLIENT tenant data unless global_super_admin.
 *   3. CLIENT users cannot access another tenant's resources (tenant isolation).
 *   4. Elevation attempts (accessing higher-privilege endpoints) are logged and blocked.
 *   5. All access attempts (granted AND denied) write to role_access_metrics.
 *   6. Denied attempts increment the denial_count_1h field for anomaly detection.
 *
 * Usage:
 *   // Protect a business-plane-only route
 *   router.get("/admin/all-tenants",
 *     requireDualPlane({ plane: "business", roles: ["global_super_admin","platform_auditor"] }),
 *     handler
 *   );
 *
 *   // Protect a client-plane route with tenant isolation
 *   router.get("/payouts",
 *     requireDualPlane({ plane: "client", roles: ["client_executive","client_auditor","client_finance"] }),
 *     handler
 *   );
 *
 *   // Allow both planes with different role constraints
 *   router.get("/commercial/invoice-summary",
 *     requireDualPlane({
 *       businessRoles: ["global_super_admin","platform_finance"],
 *       clientRoles:   ["client_executive","client_super_admin"],
 *     }),
 *     handler
 *   );
 *
 * Phase 12 Roles build-out | Commit baseline: 9f99b40
 * Phase 14 cleanup        : removed dead code in evaluateBoundary (unused
 *                           isMutatingRequest, httpMethod, businessWriteBlocked
 *                           locals) and collapsed redundant 403-or-403 ternary
 *                           in requireDualPlane. No behavioural change.
 */

import crypto from "crypto";
import { type Request, type Response, type NextFunction } from "express";
import type { Database as DB } from "better-sqlite3";
import {
  BUSINESS_PLANE_ROLES,
  CLIENT_PLANE_ROLES,
  type ControlPlane,
  type PlaneRole,
  type BusinessPlaneRole,
  type ClientPlaneRole,
} from "../db/migrations/phase12_roles";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DualPlanePrincipal {
  user_id:            string;
  username:           string;
  control_plane:      ControlPlane;
  plane_role:         PlaneRole;
  plane_tenant_scope: string | null;
  legacy_role:        string;
  tenant_id:          string | null;
}

declare global {
  namespace Express {
    interface Request {
      dualPlanePrincipal?: DualPlanePrincipal;
    }
  }
}

export interface DualPlaneRequirement {
  /** Require a specific plane — CLIENT or BUSINESS. Mutually exclusive with businessRoles/clientRoles. */
  plane?: ControlPlane;
  /** Allowed roles when plane is set. */
  roles?: PlaneRole[];
  /** Allowed BUSINESS plane roles (used when both planes can access the resource). */
  businessRoles?: BusinessPlaneRole[];
  /** Allowed CLIENT plane roles (used when both planes can access the resource). */
  clientRoles?: ClientPlaneRole[];
  /** If true, CLIENT plane users must have plane_tenant_scope matching the request X-Tenant-ID. */
  enforceTenantIsolation?: boolean;
  /** Resource label written to role_access_metrics for this endpoint. */
  resourceLabel?: string;
}

export interface AccessMetricRow {
  id:                   string;
  user_id:              string;
  username:             string;
  user_plane:           string;
  user_plane_role:      string;
  user_tenant_id:       string | null;
  requested_resource:   string;
  requested_method:     string;
  required_plane:       string | null;
  required_roles:       string;
  access_granted:       number;
  denial_reason:        string | null;
  is_boundary_crossing: number;
  is_tenant_violation:  number;
  is_elevation_attempt: number;
  ip_address:           string | null;
  user_agent:           string | null;
  request_id:           string | null;
  evaluated_at:         string;
  denial_count_1h:      number;
}

// ─── Plane Permission Matrix ──────────────────────────────────────────────────

/**
 * Defines what each plane role can do at a capability level.
 * Used for elevation detection and audit enrichment.
 */
export const PLANE_ROLE_CAPABILITIES: Record<PlaneRole, {
  can_read_all_tenants:   boolean;
  can_write_all_tenants:  boolean;
  can_manage_users:       boolean;
  can_manage_billing:     boolean;
  can_trigger_backup:     boolean;
  can_view_metrics:       boolean;
  can_manage_platform:    boolean;
  can_read_own_tenant:    boolean;
  can_write_own_tenant:   boolean;
  can_read_own_profile:   boolean;
}> = {
  global_super_admin: {
    can_read_all_tenants:  true,
    can_write_all_tenants: true,
    can_manage_users:      true,
    can_manage_billing:    true,
    can_trigger_backup:    true,
    can_view_metrics:      true,
    can_manage_platform:   true,
    can_read_own_tenant:   true,
    can_write_own_tenant:  true,
    can_read_own_profile:  true,
  },
  platform_auditor: {
    can_read_all_tenants:  true,
    can_write_all_tenants: false,
    can_manage_users:      false,
    can_manage_billing:    false,
    can_trigger_backup:    false,
    can_view_metrics:      true,
    can_manage_platform:   false,
    can_read_own_tenant:   true,
    can_write_own_tenant:  false,
    can_read_own_profile:  true,
  },
  platform_finance: {
    can_read_all_tenants:  true,
    can_write_all_tenants: false,
    can_manage_users:      false,
    can_manage_billing:    true,
    can_trigger_backup:    false,
    can_view_metrics:      true,
    can_manage_platform:   false,
    can_read_own_tenant:   true,
    can_write_own_tenant:  false,
    can_read_own_profile:  true,
  },
  platform_ops: {
    can_read_all_tenants:  true,
    can_write_all_tenants: false,
    can_manage_users:      false,
    can_manage_billing:    false,
    can_trigger_backup:    true,
    can_view_metrics:      true,
    can_manage_platform:   true,
    can_read_own_tenant:   true,
    can_write_own_tenant:  false,
    can_read_own_profile:  true,
  },
  platform_support: {
    can_read_all_tenants:  true,
    can_write_all_tenants: false,
    can_manage_users:      false,
    can_manage_billing:    false,
    can_trigger_backup:    false,
    can_view_metrics:      false,
    can_manage_platform:   false,
    can_read_own_tenant:   true,
    can_write_own_tenant:  false,
    can_read_own_profile:  true,
  },
  client_super_admin: {
    can_read_all_tenants:  false,
    can_write_all_tenants: false,
    can_manage_users:      true,
    can_manage_billing:    true,
    can_trigger_backup:    false,
    can_view_metrics:      true,
    can_manage_platform:   false,
    can_read_own_tenant:   true,
    can_write_own_tenant:  true,
    can_read_own_profile:  true,
  },
  client_executive: {
    can_read_all_tenants:  false,
    can_write_all_tenants: false,
    can_manage_users:      false,
    can_manage_billing:    true,
    can_trigger_backup:    false,
    can_view_metrics:      true,
    can_manage_platform:   false,
    can_read_own_tenant:   true,
    can_write_own_tenant:  true,
    can_read_own_profile:  true,
  },
  client_auditor: {
    can_read_all_tenants:  false,
    can_write_all_tenants: false,
    can_manage_users:      false,
    can_manage_billing:    false,
    can_trigger_backup:    false,
    can_view_metrics:      true,
    can_manage_platform:   false,
    can_read_own_tenant:   true,
    can_write_own_tenant:  false,
    can_read_own_profile:  true,
  },
  client_finance: {
    can_read_all_tenants:  false,
    can_write_all_tenants: false,
    can_manage_users:      false,
    can_manage_billing:    true,
    can_trigger_backup:    false,
    can_view_metrics:      false,
    can_manage_platform:   false,
    can_read_own_tenant:   true,
    can_write_own_tenant:  false,
    can_read_own_profile:  true,
  },
  client_partner: {
    can_read_all_tenants:  false,
    can_write_all_tenants: false,
    can_manage_users:      false,
    can_manage_billing:    false,
    can_trigger_backup:    false,
    can_view_metrics:      false,
    can_manage_platform:   false,
    can_read_own_tenant:   false,
    can_write_own_tenant:  false,
    can_read_own_profile:  true,
  },
};

// ─── Metric Writer ────────────────────────────────────────────────────────────

function getDb(req: Request): DB | null {
  return (req.app?.locals as { db?: DB })?.db ?? null;
}

function writeAccessMetric(
  req:     Request,
  params: {
    principal:           DualPlanePrincipal | null;
    requestedResource:   string;
    requiredPlane:       string | null;
    requiredRoles:       string[];
    accessGranted:       boolean;
    denialReason:        string | null;
    isBoundaryCrossing:  boolean;
    isTenantViolation:   boolean;
    isElevationAttempt:  boolean;
  }
): void {
  const db = getDb(req);
  if (!db) return;

  try {
    const now       = new Date().toISOString();
    const requestId = req.headers["x-request-id"] as string | undefined ?? null;
    const ipAddress = (
      req.headers["x-forwarded-for"] as string | undefined ??
      req.socket?.remoteAddress ??
      null
    );
    const userAgent = req.headers["user-agent"] ?? null;

    // Count denials in the last hour for this user (for intrusion detection)
    let denialCount1h = 0;
    if (!params.accessGranted && params.principal) {
      const since = new Date(Date.now() - 3_600_000).toISOString();
      const row   = db.prepare(
        "SELECT COUNT(*) as cnt FROM role_access_metrics WHERE user_id = ? AND access_granted = 0 AND evaluated_at >= ?"
      ).get(params.principal.user_id, since) as { cnt: number } | undefined;
      denialCount1h = (row?.cnt ?? 0) + 1;
    }

    db.prepare(`
      INSERT INTO role_access_metrics (
        id, user_id, username, user_plane, user_plane_role, user_tenant_id,
        requested_resource, requested_method, required_plane, required_roles,
        access_granted, denial_reason,
        is_boundary_crossing, is_tenant_violation, is_elevation_attempt,
        ip_address, user_agent, request_id, evaluated_at, denial_count_1h
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?,
        ?, ?, ?,
        ?, ?, ?, ?, ?
      )
    `).run(
      crypto.randomUUID(),
      params.principal?.user_id              ?? "anonymous",
      params.principal?.username             ?? "anonymous",
      params.principal?.control_plane        ?? "unknown",
      params.principal?.plane_role           ?? "unknown",
      params.principal?.tenant_id            ?? null,
      params.requestedResource,
      req.method,
      params.requiredPlane,
      params.requiredRoles.join(","),
      params.accessGranted ? 1 : 0,
      params.denialReason,
      params.isBoundaryCrossing  ? 1 : 0,
      params.isTenantViolation   ? 1 : 0,
      params.isElevationAttempt  ? 1 : 0,
      ipAddress,
      userAgent,
      requestId,
      now,
      denialCount1h
    );

    // If high denial count, write to anomaly_logs as a security signal
    if (denialCount1h >= 5 && params.principal) {
      db.prepare(`
        INSERT OR IGNORE INTO anomaly_logs (
          id, tenant_id, entity_id, entity_type, event_type,
          risk_level, score, metadata_json, lockout_applied, lockout_until, created_at
        ) VALUES (?, ?, ?, 'user', 'boundary_crossing_burst', 'high', ?, ?, NULL, NULL, ?)
      `).run(
        crypto.randomUUID(),
        params.principal.tenant_id ?? "platform",
        params.principal.user_id,
        Math.min(40 + denialCount1h * 5, 95),
        JSON.stringify({
          denial_count_1h:     denialCount1h,
          last_resource:       params.requestedResource,
          is_boundary_crossing: params.isBoundaryCrossing,
          is_tenant_violation:  params.isTenantViolation,
        }),
        new Date().toISOString()
      );
    }
  } catch (err) {
    // Metric writes must never crash the application
    console.error("[dualPlaneAuth] metric write failed:", err);
  }
}

// ─── Principal Resolver ───────────────────────────────────────────────────────

function resolvePrincipal(req: Request): DualPlanePrincipal | null {
  const db = getDb(req);
  if (!db) return null;

  // Prefer the pre-resolved principal attached by JWT middleware
  const userId: string | undefined =
    (req as Request & { caasUserId?: string }).caasUserId;

  if (!userId) return null;

  const row = db.prepare(`
    SELECT id, username, control_plane, plane_role, plane_tenant_scope,
           role AS legacy_role, tenant_id
    FROM users
    WHERE id = ?
  `).get(userId) as {
    id:                 string;
    username:           string;
    control_plane:      ControlPlane;
    plane_role:         PlaneRole;
    plane_tenant_scope: string | null;
    legacy_role:        string;
    tenant_id:          string;
  } | undefined;

  if (!row) return null;

  return {
    user_id:            row.id,
    username:           row.username,
    control_plane:      row.control_plane ?? "client",
    plane_role:         row.plane_role    ?? "client_partner",
    plane_tenant_scope: row.plane_tenant_scope ?? null,
    legacy_role:        row.legacy_role,
    tenant_id:          row.tenant_id ?? null,
  };
}

// ─── Boundary Evaluation ──────────────────────────────────────────────────────

interface BoundaryEvaluationResult {
  granted:             boolean;
  denialReason:        string | null;
  isBoundaryCrossing:  boolean;
  isTenantViolation:   boolean;
  isElevationAttempt:  boolean;
}

function evaluateBoundary(
  principal: DualPlanePrincipal,
  requirement: DualPlaneRequirement,
  requestTenantId: string | null
): BoundaryEvaluationResult {

  const userPlane    = principal.control_plane;
  const userRole     = principal.plane_role;
  const userTenantScope = principal.plane_tenant_scope;

  // Build the effective allowed roles from the requirement
  let allowedRoles: PlaneRole[] = [];
  let requiredPlane: ControlPlane | null = null;

  if (requirement.plane) {
    requiredPlane = requirement.plane;
    allowedRoles  = requirement.roles ?? [];
  } else {
    if (requirement.businessRoles && requirement.businessRoles.length > 0) {
      allowedRoles.push(...requirement.businessRoles);
    }
    if (requirement.clientRoles && requirement.clientRoles.length > 0) {
      allowedRoles.push(...requirement.clientRoles);
    }
  }

  // ── Check 1: Plane boundary crossing ─────────────────────────────────────
  // If a specific plane is required, the user must be on that plane.
  if (requiredPlane && userPlane !== requiredPlane) {
    return {
      granted:             false,
      denialReason:        `Control plane mismatch: resource requires ${requiredPlane.toUpperCase()} plane; user is on ${userPlane.toUpperCase()} plane.`,
      isBoundaryCrossing:  true,
      isTenantViolation:   false,
      isElevationAttempt:  false,
    };
  }

  // ── Check 2: Role authorization ───────────────────────────────────────────
  if (allowedRoles.length > 0 && !allowedRoles.includes(userRole)) {
    // Determine if this is an elevation attempt:
    // The user's role does not have the capability implied by the required roles.
    const userCapabilities  = PLANE_ROLE_CAPABILITIES[userRole];
    const requiredCapabilities = allowedRoles
      .map((r) => PLANE_ROLE_CAPABILITIES[r])
      .filter(Boolean);

    const isElevation = requiredCapabilities.some((cap) => {
      return (
        (cap.can_write_all_tenants && !userCapabilities.can_write_all_tenants) ||
        (cap.can_manage_platform   && !userCapabilities.can_manage_platform)   ||
        (cap.can_trigger_backup    && !userCapabilities.can_trigger_backup)    ||
        (cap.can_manage_users      && !userCapabilities.can_manage_users)
      );
    });

    return {
      granted:             false,
      denialReason:        `Insufficient role: required one of [${allowedRoles.join(", ")}]; user has ${userRole}.`,
      isBoundaryCrossing:  false,
      isTenantViolation:   false,
      isElevationAttempt:  isElevation,
    };
  }

  // ── Check 3: Tenant isolation for CLIENT plane ────────────────────────────
  const enforceTenantIsolation = requirement.enforceTenantIsolation ?? true;

  if (
    enforceTenantIsolation &&
    userPlane === "client" &&
    requestTenantId !== null &&
    userTenantScope !== null &&
    userTenantScope !== requestTenantId
  ) {
    return {
      granted:             false,
      denialReason:        `Tenant isolation violation: user is scoped to ${userTenantScope}; request targets ${requestTenantId}.`,
      isBoundaryCrossing:  false,
      isTenantViolation:   true,
      isElevationAttempt:  false,
    };
  }

  // ── Check 4: BUSINESS plane write protection is enforced in the
  //            middleware itself (requireDualPlane) once req.method is
  //            available, not here. This function returns granted=true at
  //            this point; the caller performs the method-based check.

  return {
    granted:             true,
    denialReason:        null,
    isBoundaryCrossing:  false,
    isTenantViolation:   false,
    isElevationAttempt:  false,
  };
}

// ─── Main Middleware Factory ───────────────────────────────────────────────────

/**
 * Creates an Express middleware that enforces dual-plane boundary rules.
 * Writes an access metric record for every evaluation (granted or denied).
 *
 * @param requirement — Plane and role constraints for the protected resource.
 */
export function requireDualPlane(requirement: DualPlaneRequirement) {
  return function dualPlaneAuthMiddleware(
    req:  Request,
    res:  Response,
    next: NextFunction
  ): void {
    const principal = resolvePrincipal(req);
    const resourceLabel = requirement.resourceLabel ?? `${req.method} ${req.path}`;
    const requestTenantId = req.headers["x-tenant-id"] as string | undefined ?? null;

    const requiredRoles: PlaneRole[] = [
      ...(requirement.roles          ?? []),
      ...(requirement.businessRoles  ?? []),
      ...(requirement.clientRoles    ?? []),
    ];

    // ── No principal resolved ─────────────────────────────────────────────
    if (!principal) {
      writeAccessMetric(req, {
        principal:           null,
        requestedResource:   resourceLabel,
        requiredPlane:       requirement.plane ?? null,
        requiredRoles,
        accessGranted:       false,
        denialReason:        "No authenticated principal found. JWT may be missing or invalid.",
        isBoundaryCrossing:  false,
        isTenantViolation:   false,
        isElevationAttempt:  false,
      });
      res.status(401).json({
        error:  "Unauthenticated",
        detail: "A valid access token with dual-plane classification is required.",
      });
      return;
    }

    // Attach principal to request for downstream handlers
    req.dualPlanePrincipal = principal;

    // ── Evaluate boundary ─────────────────────────────────────────────────
    const evaluation = evaluateBoundary(principal, requirement, requestTenantId);

    // ── Business plane write protection (runtime method check) ────────────
    if (
      evaluation.granted &&
      principal.control_plane === "business" &&
      principal.plane_role !== "global_super_admin" &&
      !PLANE_ROLE_CAPABILITIES[principal.plane_role].can_write_all_tenants &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method)
    ) {
      writeAccessMetric(req, {
        principal,
        requestedResource:   resourceLabel,
        requiredPlane:       requirement.plane ?? null,
        requiredRoles,
        accessGranted:       false,
        denialReason:        `Business plane role ${principal.plane_role} is read-only and cannot perform ${req.method} operations on client data.`,
        isBoundaryCrossing:  false,
        isTenantViolation:   false,
        isElevationAttempt:  true,
      });
      res.status(403).json({
        error:       "Write access denied",
        detail:      `Business plane role ${principal.plane_role} is read-only for client data mutations.`,
        plane:       principal.control_plane,
        plane_role:  principal.plane_role,
      });
      return;
    }

    // ── Access denied ─────────────────────────────────────────────────────
    if (!evaluation.granted) {
      writeAccessMetric(req, {
        principal,
        requestedResource:   resourceLabel,
        requiredPlane:       requirement.plane ?? null,
        requiredRoles,
        accessGranted:       false,
        denialReason:        evaluation.denialReason,
        isBoundaryCrossing:  evaluation.isBoundaryCrossing,
        isTenantViolation:   evaluation.isTenantViolation,
        isElevationAttempt:  evaluation.isElevationAttempt,
      });

      // All denial paths return 403; the body flags the specific reason.
      res.status(403).json({
        error:                "Access denied",
        detail:               evaluation.denialReason,
        plane:                principal.control_plane,
        plane_role:           principal.plane_role,
        is_boundary_crossing: evaluation.isBoundaryCrossing,
        is_tenant_violation:  evaluation.isTenantViolation,
        is_elevation_attempt: evaluation.isElevationAttempt,
      });
      return;
    }

    // ── Access granted ────────────────────────────────────────────────────
    writeAccessMetric(req, {
      principal,
      requestedResource:   resourceLabel,
      requiredPlane:       requirement.plane ?? null,
      requiredRoles,
      accessGranted:       true,
      denialReason:        null,
      isBoundaryCrossing:  false,
      isTenantViolation:   false,
      isElevationAttempt:  false,
    });

    next();
  };
}

// ─── Convenience Guards ───────────────────────────────────────────────────────

/** Allows any authenticated user on either plane. Writes metric. */
export function requireAnyPlane() {
  return requireDualPlane({
    businessRoles: [...BUSINESS_PLANE_ROLES],
    clientRoles:   [...CLIENT_PLANE_ROLES],
    resourceLabel: "any-plane-resource",
  });
}

/** Restricts to BUSINESS plane only. */
export function requireBusinessPlane(roles?: BusinessPlaneRole[]) {
  return requireDualPlane({
    plane: "business",
    roles: roles ?? [...BUSINESS_PLANE_ROLES],
  });
}

/** Restricts to CLIENT plane only, with tenant isolation enforced. */
export function requireClientPlane(roles?: ClientPlaneRole[]) {
  return requireDualPlane({
    plane:                  "client",
    roles:                  roles ?? [...CLIENT_PLANE_ROLES],
    enforceTenantIsolation: true,
  });
}

/** Global super admin only — full platform control. */
export function requireGlobalSuperAdmin() {
  return requireDualPlane({
    plane:         "business",
    roles:         ["global_super_admin"],
    resourceLabel: "global-super-admin-resource",
  });
}

/** Platform ops — infrastructure and backup operations. */
export function requirePlatformOps() {
  return requireDualPlane({
    plane:         "business",
    roles:         ["global_super_admin", "platform_ops"],
    resourceLabel: "platform-ops-resource",
  });
}

// ─── Plane Context Injector ───────────────────────────────────────────────────

/**
 * Lightweight middleware that resolves and attaches the dual-plane principal
 * to every authenticated request, without enforcing any role constraints.
 * Mount this after the JWT middleware on all routes that need plane context.
 *
 *   app.use(injectPlaneContext());
 */
export function injectPlaneContext() {
  return function planeContextMiddleware(
    req:  Request,
    _res: Response,
    next: NextFunction
  ): void {
    const principal = resolvePrincipal(req);
    if (principal) req.dualPlanePrincipal = principal;
    next();
  };
}

// ─── Admin Route: Access Metrics Summary ─────────────────────────────────────

import { type Request as Req, type Response as Res } from "express";

/**
 * GET /api/v1/admin/access-metrics
 * Returns the access metrics summary for the platform.
 * Authorization: global_super_admin, platform_auditor
 */
export async function getAccessMetricsHandler(req: Req, res: Res): Promise<void> {
  const db = getDb(req);
  if (!db) { res.status(500).json({ error: "Database unavailable" }); return; }

  const since  = (req.query.since as string | undefined)
    ?? new Date(Date.now() - 24 * 3_600_000).toISOString();
  const limit  = Math.min(parseInt((req.query.limit as string) ?? "100", 10), 500);

  const summary = db.prepare(`
    SELECT
      COUNT(*)                                                           AS total_evaluations,
      SUM(CASE WHEN access_granted = 1 THEN 1 ELSE 0 END)               AS total_granted,
      SUM(CASE WHEN access_granted = 0 THEN 1 ELSE 0 END)               AS total_denied,
      SUM(CASE WHEN is_boundary_crossing = 1 THEN 1 ELSE 0 END)         AS boundary_crossings,
      SUM(CASE WHEN is_tenant_violation = 1 THEN 1 ELSE 0 END)          AS tenant_violations,
      SUM(CASE WHEN is_elevation_attempt = 1 THEN 1 ELSE 0 END)         AS elevation_attempts,
      COUNT(DISTINCT user_id)                                            AS distinct_users
    FROM role_access_metrics
    WHERE evaluated_at >= ?
  `).get(since) as {
    total_evaluations:  number;
    total_granted:      number;
    total_denied:       number;
    boundary_crossings: number;
    tenant_violations:  number;
    elevation_attempts: number;
    distinct_users:     number;
  };

  const topDeniedUsers = db.prepare(`
    SELECT user_id, username, user_plane, user_plane_role,
           COUNT(*) AS denial_count,
           MAX(evaluated_at) AS last_attempt
    FROM role_access_metrics
    WHERE access_granted = 0 AND evaluated_at >= ?
    GROUP BY user_id
    ORDER BY denial_count DESC
    LIMIT 10
  `).all(since) as {
    user_id:         string;
    username:        string;
    user_plane:      string;
    user_plane_role: string;
    denial_count:    number;
    last_attempt:    string;
  }[];

  const recentDenials = db.prepare(`
    SELECT * FROM role_access_metrics
    WHERE access_granted = 0 AND evaluated_at >= ?
    ORDER BY evaluated_at DESC
    LIMIT ?
  `).all(since, limit) as AccessMetricRow[];

  const planeSummary = db.prepare(`
    SELECT user_plane,
           COUNT(*) AS total,
           SUM(CASE WHEN access_granted = 1 THEN 1 ELSE 0 END) AS granted,
           SUM(CASE WHEN access_granted = 0 THEN 1 ELSE 0 END) AS denied
    FROM role_access_metrics
    WHERE evaluated_at >= ?
    GROUP BY user_plane
  `).all(since) as { user_plane: string; total: number; granted: number; denied: number }[];

  res.json({
    generated_at:    new Date().toISOString(),
    since,
    summary,
    plane_breakdown: planeSummary,
    top_denied_users: topDeniedUsers,
    recent_denials:   recentDenials,
  });
}

// ─── Replication Guard ────────────────────────────────────────────────────────

/**
 * Middleware guard for backup/replication operations.
 * Only platform_ops and global_super_admin may trigger or configure backups.
 * Writes a metric on every access attempt.
 */
export const replicationGuard = requireDualPlane({
  businessRoles: ["global_super_admin", "platform_ops"],
  clientRoles:   [],
  resourceLabel: "db-replication-backup",
});
