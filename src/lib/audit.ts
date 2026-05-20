/**
 * src/lib/audit.ts
 *
 * Single source of truth for audit-log row inserts. Before slice 6c, three
 * route files (users.ts, provisioning.ts, insurance.ts) each defined their
 * own copy of these helpers with subtle signature differences:
 *
 *   - users.ts:auditLog                 → role_audit_log (Phase 12)
 *   - provisioning.ts:commercialAuditLog → commercial_audit_log, takes entityType
 *   - insurance.ts:commercialAuditLog    → commercial_audit_log, hardcoded 'warranty'
 *
 * The hardcoded entity_type in insurance.ts was the most acute drift risk —
 * if a new entity ever needed auditing from insurance.ts, copying the helper
 * would silently mis-tag the row. This module fixes that by exporting one
 * `commercialAuditLog` with entityType as a parameter; callers in
 * insurance.ts now pass "warranty" explicitly.
 *
 * Both helpers are designed to be called INSIDE the same db.transaction()
 * wrapper as the mutation they're logging — see slice 6a atomicity work.
 * They do not start their own transaction; that's the caller's job.
 */

import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";

/**
 * Records a row in role_audit_log. Used by user-management mutations:
 * profile updates, role assignments, KYC elevations, freelancer
 * registration, API key generation.
 *
 * `actorUserId` is the authenticated user performing the action.
 * `targetUserId` is the user whose data is being changed (typically
 * the same as actor for self-service flows, different for admin flows).
 * `reason` is a free-text justification, optional.
 */
export function auditLog(
  db: DB,
  tenantId: string,
  targetUserId: string,
  actorUserId: string,
  action: string,
  oldValue: string | null,
  newValue: string | null,
  reason: string | null = null,
): void {
  db.prepare(`
    INSERT INTO role_audit_log
      (id, tenant_id, target_user_id, actor_user_id,
       action, old_value, new_value, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    tenantId,
    targetUserId,
    actorUserId,
    action,
    oldValue,
    newValue,
    reason,
    new Date().toISOString(),
  );
}

/**
 * Records a row in commercial_audit_log. Used by Phase 15 commercial
 * mutations: account provisioning, tier changes, key rotations, warranty
 * binding, policy state transitions, external carrier attachments.
 *
 * `actorUserId` is nullable — system-triggered events (recompute jobs,
 * background processes) pass null. Verified slice 6e: the column is
 * declared `actor_user_id TEXT` (nullable), comment in
 * phase15_commercial_activation.ts explicitly calls out the recompute case.
 *
 * `entityType` discriminates the row type. Known values used in the
 * codebase: "account", "warranty", "badge", "pilot_decision". Pass the
 * string that matches your mutation's domain.
 *
 * `metadata` is a free-form object JSON-encoded into the metadata column.
 * Use it for context that isn't a simple old→new value transition
 * (e.g. API key prefix, pilot day count, evidence snapshot).
 */
export function commercialAuditLog(
  db: DB,
  tenantId: string,
  actorUserId: string | null,
  entityType: string,
  entityId: string,
  action: string,
  oldValue: string | null,
  newValue: string | null,
  metadata: Record<string, unknown> = {},
): void {
  db.prepare(`
    INSERT INTO commercial_audit_log
      (id, tenant_id, actor_user_id, entity_type, entity_id,
       action, old_value, new_value, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    crypto.randomUUID(),
    tenantId,
    actorUserId,
    entityType,
    entityId,
    action,
    oldValue,
    newValue,
    JSON.stringify(metadata),
    new Date().toISOString(),
  );
}
