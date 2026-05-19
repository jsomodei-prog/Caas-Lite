/**
 * src/db/migrations/phase12_roles.ts
 * Dual-Plane Role Classification: types and constants.
 *
 * The migrations that introduced this schema (formerly v31–v35 in this file,
 * now v17–v21 in src/db/migrate.ts) have been folded into the canonical
 * migration runner. This file is now a pure types/constants module imported
 * by middleware and routes.
 *
 * Control Plane Definitions:
 *   BUSINESS — Cross-tenant operational visibility. Roles:
 *     global_super_admin     Full platform control. No tenant scope restriction.
 *     platform_auditor       Read-only across all tenants. Compliance oversight.
 *     platform_finance       Billing and commercial data across all tenants.
 *     platform_ops           Infrastructure, backup, and replication management.
 *     platform_support       Scoped read access for customer support escalations.
 *
 *   CLIENT — Scoped to a single tenant_id. Roles:
 *     client_super_admin     Full control within their tenant.
 *     client_executive       Invoice, compliance, and underwriting within tenant.
 *     client_auditor         Read-only within tenant. Anomaly and report access.
 *     client_finance         Billing and payout visibility within tenant.
 *     client_partner         Own profile and payout history only.
 *
 * Phase 12 Roles build-out | Unified into migrate.ts on Phase 14 follow-up.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ControlPlane = "business" | "client";

export type BusinessPlaneRole =
  | "global_super_admin"
  | "platform_auditor"
  | "platform_finance"
  | "platform_ops"
  | "platform_support";

export type ClientPlaneRole =
  | "client_super_admin"
  | "client_executive"
  | "client_auditor"
  | "client_finance"
  | "client_partner";

export type PlaneRole = BusinessPlaneRole | ClientPlaneRole;

// ─── Constants ────────────────────────────────────────────────────────────────

export const BUSINESS_PLANE_ROLES: BusinessPlaneRole[] = [
  "global_super_admin",
  "platform_auditor",
  "platform_finance",
  "platform_ops",
  "platform_support",
];

export const CLIENT_PLANE_ROLES: ClientPlaneRole[] = [
  "client_super_admin",
  "client_executive",
  "client_auditor",
  "client_finance",
  "client_partner",
];

export const ALL_PLANE_ROLES: PlaneRole[] = [
  ...BUSINESS_PLANE_ROLES,
  ...CLIENT_PLANE_ROLES,
];

/**
 * Maps legacy CaaSRole → default plane and plane_role for users who predate
 * the dual-plane schema. The historical version of this map is also inlined
 * inside migration v20 (the backfill); changing this constant does NOT
 * retroactively change v20's behaviour, which is intentional — migrations
 * are immutable history.
 */
export const LEGACY_ROLE_PLANE_MAP: Record<
  string,
  { plane: ControlPlane; plane_role: PlaneRole }
> = {
  Executive: { plane: "client", plane_role: "client_super_admin" },
  Auditor:   { plane: "client", plane_role: "client_auditor"     },
  Partner:   { plane: "client", plane_role: "client_partner"     },
};
