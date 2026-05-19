/**
 * tests/badge-sync.test.ts
 * Tests for cross-router badge coupling.
 *
 * Validates that the badge follows warranty state:
 *   - account creation seeds 'green'
 *   - warranty bind keeps 'green'
 *   - drift approaching threshold flips to 'amber'
 *   - threshold breach flips to 'red'
 *   - badge signature changes on every state transition (and only then)
 */

import request from "supertest";
import fs      from "fs";
import os      from "os";
import path    from "path";
import type { Database as DB } from "better-sqlite3";
import { createApp }            from "../src/server";
import { mintSuperAdminToken }  from "./helpers/auth";
import { computeBadgeState }    from "../src/lib/badge-sync";
import crypto from "crypto";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let app: ReturnType<typeof createApp>;
let dbPath: string;
let JWT: string;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `caas-badge-sync-${Date.now()}.db`);
  app    = createApp(dbPath);
  JWT    = await mintSuperAdminToken(app);
});

afterAll(() => {
  try { fs.unlinkSync(dbPath); } catch { /* fine */ }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDb(): DB {
  return (app.locals as { db: DB }).db;
}

async function makeAccount(tenantId: string) {
  const res = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", `Bearer ${JWT}`)
    .send({ tenant_id: tenantId, display_name: "Test", tier: "GROWTH" });
  expect(res.status).toBe(201);
  return res.body as {
    id: string;
    tenant_id: string;
    api_key: string;
    badge_signature: string;
  };
}

async function bindWarranty(accountId: string): Promise<string> {
  const res = await request(app)
    .post("/api/v1/insurance/policies")
    .set("Authorization", `Bearer ${JWT}`)
    .send({ account_id: accountId });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function recompute(policyId: string) {
  const res = await request(app)
    .post(`/api/v1/insurance/policies/${policyId}/recompute`)
    .set("Authorization", `Bearer ${JWT}`);
  return res.body as {
    current_state: string;
    badge: { state: string; changed: boolean; signature: string };
  };
}

function writeAccessMetric(
  tenantId: string,
  daysAgo: number,
  granted: boolean,
  boundary = false
): void {
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  getDb().prepare(`
    INSERT INTO role_access_metrics (
      id, user_id, username, user_plane, user_plane_role, user_tenant_id,
      requested_resource, requested_method, required_plane, required_roles,
      access_granted, is_boundary_crossing, is_tenant_violation,
      is_elevation_attempt, evaluated_at
    ) VALUES (?, 'u', 'u', 'client', 'client_partner', ?,
              '/x', 'GET', 'business', '["x"]',
              ?, ?, 0, 0, ?)
  `).run(crypto.randomUUID(), tenantId, granted ? 1 : 0, boundary ? 1 : 0, ts);
}

function readBadge(tenantId: string) {
  return getDb().prepare(`
    SELECT badge_state, state_signature, state_reason
    FROM trust_badge_registry WHERE tenant_id = ?
  `).get(tenantId) as
    | { badge_state: string; state_signature: string; state_reason: string | null }
    | undefined;
}

function readHistory(tenantId: string) {
  return getDb().prepare(`
    SELECT from_state, to_state, reason FROM trust_badge_history
    WHERE tenant_id = ? ORDER BY changed_at ASC
  `).all(tenantId) as { from_state: string | null; to_state: string; reason: string | null }[];
}

// ─── Pure mapping tests (no DB) ───────────────────────────────────────────────

describe("computeBadgeState — mapping warranty → badge", () => {
  test("ACTIVE with no evidence → green", () => {
    expect(computeBadgeState({ policy_state: "ACTIVE" }).state).toBe("green");
  });
  test("null policy → green", () => {
    expect(computeBadgeState({ policy_state: null }).state).toBe("green");
  });
  test("ACTIVE with anomaly_ratio at 80% of threshold → amber", () => {
    const r = computeBadgeState({
      policy_state: "ACTIVE",
      evidence:     { anomaly_ratio: 0.016, threshold: 0.02 },
    });
    expect(r.state).toBe("amber");
    expect(r.reason).toMatch(/approaching/);
  });
  test("VOID_BY_ANOMALY_RATIO → red", () => {
    expect(computeBadgeState({ policy_state: "VOID_BY_ANOMALY_RATIO" }).state).toBe("red");
  });
  test("VOID_BY_COMPLIANCE_DRIFT → red", () => {
    expect(computeBadgeState({ policy_state: "VOID_BY_COMPLIANCE_DRIFT" }).state).toBe("red");
  });
});

// ─── End-to-end coupling tests ────────────────────────────────────────────────

describe("Badge coupling — full lifecycle", () => {
  test("account creation seeds a green badge with a signature", async () => {
    const acct = await makeAccount("tenant_lifecycle_1");
    expect(acct.badge_signature).toMatch(/^[a-f0-9]{64}$/);

    const badge = readBadge(acct.tenant_id);
    expect(badge?.badge_state).toBe("green");
    expect(badge?.state_signature).toBe(acct.badge_signature);

    const history = readHistory(acct.tenant_id);
    expect(history).toHaveLength(1);
    expect(history[0].from_state).toBeNull();
    expect(history[0].to_state).toBe("green");
  });

  test("binding a warranty keeps badge green and is idempotent", async () => {
    const acct  = await makeAccount("tenant_lifecycle_2");
    const sigBefore = readBadge(acct.tenant_id)?.state_signature;

    await bindWarranty(acct.id);

    const sigAfter  = readBadge(acct.tenant_id)?.state_signature;
    expect(readBadge(acct.tenant_id)?.badge_state).toBe("green");
    // Idempotent → signature should not have churned.
    expect(sigAfter).toBe(sigBefore);
    expect(readHistory(acct.tenant_id)).toHaveLength(1);
  });

  test("drift approaching threshold flips badge to amber", async () => {
    const acct   = await makeAccount("tenant_lifecycle_amber");
    const policy = await bindWarranty(acct.id);

    // Anomaly threshold is 2% in insurance.ts. Inject 1000 granted +
    // 17 denied = 1.67% → above 75% of threshold (1.5%), below 2%.
    for (let i = 0; i < 1000; i++) writeAccessMetric(acct.tenant_id, 1, true);
    for (let i = 0; i < 17;   i++) writeAccessMetric(acct.tenant_id, 1, false);

    const result = await recompute(policy);
    expect(result.current_state).toBe("ACTIVE");
    expect(result.badge.state).toBe("amber");
    expect(result.badge.changed).toBe(true);
    expect(readBadge(acct.tenant_id)?.state_reason).toMatch(/approaching/);
  });

  test("threshold breach flips badge to red and records history", async () => {
    const acct   = await makeAccount("tenant_lifecycle_red");
    const policy = await bindWarranty(acct.id);

    // 100 granted + 10 denied = ~9% → well above 2%.
    for (let i = 0; i < 100; i++) writeAccessMetric(acct.tenant_id, 1, true);
    for (let i = 0; i < 10;  i++) writeAccessMetric(acct.tenant_id, 1, false);

    const result = await recompute(policy);
    expect(result.current_state).toBe("VOID_BY_ANOMALY_RATIO");
    expect(result.badge.state).toBe("red");

    const history = readHistory(acct.tenant_id);
    // Initial green → red (no warranty bind transition because that
    // call was a no-op).
    expect(history[history.length - 1].to_state).toBe("red");
    expect(history[history.length - 1].from_state).toBe("green");
  });

  test("repeat recompute with same state is a no-op (no history churn)", async () => {
    const acct   = await makeAccount("tenant_lifecycle_idem");
    const policy = await bindWarranty(acct.id);

    // Drive to red
    for (let i = 0; i < 100; i++) writeAccessMetric(acct.tenant_id, 1, true);
    for (let i = 0; i < 10;  i++) writeAccessMetric(acct.tenant_id, 1, false);
    await recompute(policy);
    const histAfterRed = readHistory(acct.tenant_id).length;
    const sigAfterRed  = readBadge(acct.tenant_id)?.state_signature;

    // Recompute again with identical evidence
    const r = await recompute(policy);
    expect(r.badge.changed).toBe(false);

    expect(readHistory(acct.tenant_id)).toHaveLength(histAfterRed);
    expect(readBadge(acct.tenant_id)?.state_signature).toBe(sigAfterRed);
  });
});
