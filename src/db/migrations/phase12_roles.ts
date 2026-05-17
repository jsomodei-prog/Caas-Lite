/**
 * src/db/migrations/phase12_roles.ts
 * Dual-Plane Role Classification Schema.
 *
 * Migrations applied:
 *   v31 — Add control_plane and plane_role columns to users table
 *   v32 — Create role_access_metrics table (boundary crossing audit log)
 *   v33 — Create plane_session_log table (session-level plane tracking)
 *   v34 — Seed default plane assignments for existing users
 *   v35 — Covering indexes for access metrics queries
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
 * Run:
 *   $env:DB_PATH="data\caas_evidence.db"
 *   npx ts-node --project tsconfig.json src/db/migrations/phase12_roles.ts
 *
 * Phase 12 Roles build-out | Commit baseline: 9f99b40
 */

import { openDatabase, runMigrations } from "../migrate";
import type { Database as DB } from "better-sqlite3";

// ─── Types (exported for use in middleware) ───────────────────────────────────

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

/** Maps legacy CaaSRole → default plane and plane_role */
export const LEGACY_ROLE_PLANE_MAP: Record<string, { plane: ControlPlane; plane_role: PlaneRole }> = {
  Executive: { plane: "client",   plane_role: "client_super_admin" },
  Auditor:   { plane: "client",   plane_role: "client_auditor"     },
  Partner:   { plane: "client",   plane_role: "client_partner"     },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function existingColumns(db: DB, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function addColumnIfMissing(db: DB, table: string, col: string, def: string): void {
  if (!existingColumns(db, table).has(col)) {
    db.prepare(`ALTER TABLE "${table}" ADD COLUMN "${col}" ${def}`).run();
  }
}

function existingIndexes(db: DB): Set<string> {
  return new Set(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[])
      .map((r) => r.name)
  );
}

function createIndexIfMissing(db: DB, name: string, ddl: string): void {
  if (!existingIndexes(db).has(name)) db.prepare(ddl).run();
}

// ─── Migration Definitions ────────────────────────────────────────────────────

const PHASE12_ROLE_MIGRATIONS = [

  // ── v31: Extend users table with plane columns ────────────────────────────
  {
    version: 31,
    description: "Add control_plane and plane_role columns to users table",
    up(db: DB): void {
      // control_plane: 'business' or 'client'
      addColumnIfMissing(db, "users", "control_plane",
        "TEXT NOT NULL DEFAULT 'client' CHECK (control_plane IN ('business','client'))");

      // plane_role: granular role within the plane
      addColumnIfMissing(db, "users", "plane_role",
        "TEXT NOT NULL DEFAULT 'client_partner'");

      // plane_tenant_scope: NULL for business plane (cross-tenant); tenant_id for client plane
      addColumnIfMissing(db, "users", "plane_tenant_scope",
        "TEXT");

      // plane_assigned_at: timestamp of most recent plane assignment
      addColumnIfMissing(db, "users", "plane_assigned_at",
        "TEXT");

      // plane_assigned_by: user_id of admin who assigned the plane role
      addColumnIfMissing(db, "users", "plane_assigned_by",
        "TEXT");

      createIndexIfMissing(db, "idx_users_control_plane",
        "CREATE INDEX IF NOT EXISTS idx_users_control_plane ON users(control_plane, plane_role)");

      createIndexIfMissing(db, "idx_users_plane_tenant",
        "CREATE INDEX IF NOT EXISTS idx_users_plane_tenant ON users(plane_tenant_scope, control_plane)");
    },
  },

  // ── v32: role_access_metrics table ────────────────────────────────────────
  {
    version: 32,
    description: "Create role_access_metrics boundary crossing audit table",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS role_access_metrics (
          id                    TEXT     PRIMARY KEY,

          -- Who attempted access
          user_id               TEXT     NOT NULL,
          username              TEXT     NOT NULL,
          user_plane            TEXT     NOT NULL,
          user_plane_role       TEXT     NOT NULL,
          user_tenant_id        TEXT,

          -- What they tried to access
          requested_resource    TEXT     NOT NULL,
          requested_method      TEXT     NOT NULL,
          required_plane        TEXT,
          required_roles        TEXT     NOT NULL,

          -- Outcome
          access_granted        INTEGER  NOT NULL DEFAULT 0
                                         CHECK (access_granted IN (0, 1)),

          -- Denial reason (NULL when access_granted = 1)
          denial_reason         TEXT,

          -- Boundary crossing flag:
          -- 1 when a CLIENT plane user attempts a BUSINESS plane resource, or vice versa
          is_boundary_crossing  INTEGER  NOT NULL DEFAULT 0
                                         CHECK (is_boundary_crossing IN (0, 1)),

          -- Tenant scope violation flag:
          -- 1 when a client user attempts to access another tenant's resource
          is_tenant_violation   INTEGER  NOT NULL DEFAULT 0
                                         CHECK (is_tenant_violation IN (0, 1)),

          -- Elevation attempt flag:
          -- 1 when user attempts to access a higher-privilege role endpoint
          is_elevation_attempt  INTEGER  NOT NULL DEFAULT 0
                                         CHECK (is_elevation_attempt IN (0, 1)),

          -- Network context
          ip_address            TEXT,
          user_agent            TEXT,
          request_id            TEXT,

          -- Timing
          evaluated_at          TEXT     NOT NULL,

          -- Risk signal: cumulative denial count in the last hour for this user
          -- Populated asynchronously after insert; used for anomaly detection integration.
          denial_count_1h       INTEGER  NOT NULL DEFAULT 0
        )
      `).run();

      createIndexIfMissing(db, "idx_ram_user_id",
        "CREATE INDEX IF NOT EXISTS idx_ram_user_id ON role_access_metrics(user_id, evaluated_at DESC)");

      createIndexIfMissing(db, "idx_ram_access_granted",
        "CREATE INDEX IF NOT EXISTS idx_ram_access_granted ON role_access_metrics(access_granted, evaluated_at DESC)");

      createIndexIfMissing(db, "idx_ram_boundary_crossing",
        "CREATE INDEX IF NOT EXISTS idx_ram_boundary_crossing ON role_access_metrics(is_boundary_crossing, evaluated_at DESC)");

      createIndexIfMissing(db, "idx_ram_tenant_violation",
        "CREATE INDEX IF NOT EXISTS idx_ram_tenant_violation ON role_access_metrics(is_tenant_violation, evaluated_at DESC)");

      createIndexIfMissing(db, "idx_ram_resource_method",
        "CREATE INDEX IF NOT EXISTS idx_ram_resource_method ON role_access_metrics(requested_resource, requested_method, evaluated_at DESC)");

      createIndexIfMissing(db, "idx_ram_evaluated_at",
        "CREATE INDEX IF NOT EXISTS idx_ram_evaluated_at ON role_access_metrics(evaluated_at DESC)");
    },
  },

  // ── v33: plane_session_log table ──────────────────────────────────────────
  {
    version: 33,
    description: "Create plane_session_log for session-level plane tracking",
    up(db: DB): void {
      db.prepare(`
        CREATE TABLE IF NOT EXISTS plane_session_log (
          id                TEXT    PRIMARY KEY,
          user_id           TEXT    NOT NULL,
          username          TEXT    NOT NULL,
          control_plane     TEXT    NOT NULL,
          plane_role        TEXT    NOT NULL,
          tenant_id         TEXT,

          -- Session JWT jti (claim) for cross-referencing with auth logs
          jwt_jti           TEXT,

          -- Aggregate session metrics
          total_requests    INTEGER NOT NULL DEFAULT 0,
          granted_requests  INTEGER NOT NULL DEFAULT 0,
          denied_requests   INTEGER NOT NULL DEFAULT 0,
          boundary_crossings INTEGER NOT NULL DEFAULT 0,

          session_start     TEXT    NOT NULL,
          session_end       TEXT,
          last_seen_at      TEXT    NOT NULL
        )
      `).run();

      createIndexIfMissing(db, "idx_psl_user_id",
        "CREATE INDEX IF NOT EXISTS idx_psl_user_id ON plane_session_log(user_id, session_start DESC)");

      createIndexIfMissing(db, "idx_psl_plane",
        "CREATE INDEX IF NOT EXISTS idx_psl_plane ON plane_session_log(control_plane, session_start DESC)");
    },
  },

  // ── v34: Seed plane assignments for existing users ────────────────────────
  {
    version: 34,
    description: "Seed default plane assignments for existing users based on legacy role",
    up(db: DB): void {
      const users = db.prepare(
        "SELECT id, role, tenant_id FROM users WHERE plane_assigned_at IS NULL"
      ).all() as { id: string; role: string; tenant_id: string }[];

      const now = new Date().toISOString();
      const updateStmt = db.prepare(`
        UPDATE users SET
          control_plane      = ?,
          plane_role         = ?,
          plane_tenant_scope = ?,
          plane_assigned_at  = ?
        WHERE id = ?
      `);

      for (const user of users) {
        const mapping = LEGACY_ROLE_PLANE_MAP[user.role] ?? {
          plane: "client" as ControlPlane,
          plane_role: "client_partner" as PlaneRole,
        };
        updateStmt.run(
          mapping.plane,
          mapping.plane_role,
          mapping.plane === "client" ? user.tenant_id : null,
          now,
          user.id
        );
      }

      console.log(`[v34] Seeded plane assignments for ${users.length} existing users.`);
    },
  },

  // ── v35: Covering indexes for access metrics dashboard queries ────────────
  {
    version: 35,
    description: "Add covering indexes for role_access_metrics dashboard aggregation queries",
    up(db: DB): void {
      createIndexIfMissing(db, "idx_ram_intrusion_covering",
        `CREATE INDEX IF NOT EXISTS idx_ram_intrusion_covering
         ON role_access_metrics(access_granted, is_boundary_crossing, is_tenant_violation, evaluated_at DESC, user_id)`);

      createIndexIfMissing(db, "idx_ram_user_denial_covering",
        `CREATE INDEX IF NOT EXISTS idx_ram_user_denial_covering
         ON role_access_metrics(user_id, access_granted, evaluated_at DESC)
         WHERE access_granted = 0`);

      db.prepare("ANALYZE").run();
    },
  },
];

// ─── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const db = openDatabase();
  runMigrations(db);

  const appliedVersions = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[])
      .map((r) => r.version)
  );

  for (const migration of PHASE12_ROLE_MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      console.log(`[migrate-p12-roles] ↷ ${String(migration.version).padStart(3, "0")} ${migration.description} (skipped)`);
      continue;
    }
    const start = Date.now();
    db.transaction(() => {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)"
      ).run(migration.version, migration.description, new Date().toISOString());
    })();
    console.log(
      `[migrate-p12-roles] ✓ ${String(migration.version).padStart(3, "0")} ${migration.description} (${Date.now() - start}ms)`
    );
  }

  const version = (
    db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as { v: number }
  ).v;
  console.log(`\nSchema now at version ${version}.`);

  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all() as { name: string }[];
  console.log(`\nAll tables (${tables.length}):`);
  tables.forEach((t) => console.log(`  ${t.name}`));

  db.close();
}

main().catch((err) => {
  console.error("[migrate-p12-roles] Fatal:", err);
  process.exit(1);
});
