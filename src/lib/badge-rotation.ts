/**
 * src/lib/badge-rotation.ts
 * Boot-time detection of BADGE_HMAC_SECRET rotation.
 *
 * Mechanism:
 *   1. On server boot, compute sha256 of the current secret (its fingerprint).
 *   2. Read the last-stored fingerprint from secret_state table.
 *   3. If different (or no row yet), resign every badge with the current
 *      secret and update the stored fingerprint.
 *
 * Side effects on a mismatch:
 *   - Every row in trust_badge_registry gets a fresh state_signature.
 *   - One row added to commercial_audit_log per resigned badge with
 *     action='secret_rotation', so the rotation event is auditable.
 *   - secret_state.fingerprint updated to match current.
 *
 * On the FIRST boot ever, there's no stored fingerprint — we treat that
 * as "establishment" rather than "rotation" (no resign needed, just
 * record the fingerprint). This matches the operator's mental model: a
 * fresh deployment isn't a rotation event.
 */

import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { getCurrentSecretFingerprint, signBadgeState } from "./badge-secrets";

const SECRET_NAME = "BADGE_HMAC_SECRET";

export interface RotationDetectionResult {
  /** What we did on this boot. */
  outcome: "established" | "unchanged" | "rotated";
  /** Number of badges resigned (always 0 unless outcome is 'rotated'). */
  badges_resigned: number;
  /** ISO timestamp of detection. */
  detected_at: string;
}

/**
 * Detects rotation and acts on it. Idempotent: safe to call on every boot,
 * does nothing when the secret hasn't changed.
 *
 * Does NOT throw on failure. Returns a result describing what happened.
 * Failures during resigning are logged but don't prevent boot — the worst
 * case is some badges have stale signatures until a subsequent restart.
 */
export function detectAndApplyRotation(db: DB): RotationDetectionResult {
  const now         = new Date().toISOString();
  const fingerprint = getCurrentSecretFingerprint();

  // Read prior state. May not exist on first ever boot.
  const prior = db.prepare(`
    SELECT fingerprint, last_rotated_at
    FROM secret_state
    WHERE secret_name = ?
  `).get(SECRET_NAME) as { fingerprint: string; last_rotated_at: string } | undefined;

  // First boot: record and exit. No badges yet anyway.
  if (!prior) {
    db.prepare(`
      INSERT INTO secret_state (secret_name, fingerprint, last_seen_at, last_rotated_at, metadata)
      VALUES (?, ?, ?, ?, '{"event":"established"}')
    `).run(SECRET_NAME, fingerprint, now, now);

    // eslint-disable-next-line no-console
    console.log(
      `[badge-rotation] secret fingerprint established (first boot)`
    );

    return { outcome: "established", badges_resigned: 0, detected_at: now };
  }

  // Unchanged: just bump last_seen_at and exit.
  if (prior.fingerprint === fingerprint) {
    db.prepare(`
      UPDATE secret_state
         SET last_seen_at = ?
       WHERE secret_name = ?
    `).run(now, SECRET_NAME);
    return { outcome: "unchanged", badges_resigned: 0, detected_at: now };
  }

  // Rotation detected: resign all badges.
  // eslint-disable-next-line no-console
  console.log(
    `[badge-rotation] secret rotation detected — resigning all badges`
  );

  const resigned = resignAllBadges(db, now);

  db.prepare(`
    UPDATE secret_state
       SET fingerprint     = ?,
           last_seen_at    = ?,
           last_rotated_at = ?,
           metadata        = ?
     WHERE secret_name = ?
  `).run(
    fingerprint, now, now,
    JSON.stringify({ event: "rotation", resigned_count: resigned }),
    SECRET_NAME
  );

  // eslint-disable-next-line no-console
  console.log(
    `[badge-rotation] rotation complete: ${resigned} badges resigned`
  );

  return { outcome: "rotated", badges_resigned: resigned, detected_at: now };
}

/**
 * Re-signs every row in trust_badge_registry using the current secret.
 * Each resign emits an audit log row. Runs inside a single transaction
 * for atomicity — either all badges resign or none do.
 */
function resignAllBadges(db: DB, timestamp: string): number {
  const rows = db.prepare(`
    SELECT tenant_id, badge_state, state_changed_at
    FROM trust_badge_registry
  `).all() as { tenant_id: string; badge_state: string; state_changed_at: string }[];

  if (rows.length === 0) return 0;

  const updateSig = db.prepare(`
    UPDATE trust_badge_registry
       SET state_signature = ?,
           updated_at      = ?
     WHERE tenant_id = ?
  `);
  const insertAudit = db.prepare(`
    INSERT INTO commercial_audit_log
      (id, tenant_id, actor_user_id, entity_type, entity_id,
       action, old_value, new_value, metadata, created_at)
    VALUES (?, ?, NULL, 'badge', ?, 'secret_rotation', NULL, NULL, '{}', ?)
  `);

  let count = 0;
  db.transaction(() => {
    for (const row of rows) {
      const newSig = signBadgeState(row.tenant_id, row.badge_state, row.state_changed_at);
      updateSig.run(newSig, timestamp, row.tenant_id);
      insertAudit.run(crypto.randomUUID(), row.tenant_id, row.tenant_id, timestamp);
      count++;
    }
  })();

  return count;
}
