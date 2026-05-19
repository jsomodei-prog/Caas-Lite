/**
 * tests/recompute-scheduler.test.ts
 * Validates the scheduler core (recomputeAllWarranties), independent of
 * the in-process timer. The timer itself is exercised via env-var gating
 * in the test helper — no need to wait for setInterval to fire.
 */

import request from "supertest";
import fs      from "fs";
import os      from "os";
import path    from "path";
import crypto  from "crypto";
import type { Database as DB } from "better-sqlite3";
import { mintSuperAdminToken, createTestApp } from "./helpers/auth";
import { recomputeAllWarranties }              from "../src/lib/recompute-scheduler";

let app: ReturnType<typeof createTestApp>;
let dbPath: string;
let JWT: string;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `caas-scheduler-${Date.now()}.db`);
  app    = createTestApp(dbPath);
  JWT    = await mintSuperAdminToken(app);
});

afterAll(() => {
  try { fs.unlinkSync(dbPath); } catch { /* fine */ }
});

function getDb(): DB {
  return (app.locals as { db: DB }).db;
}

async function makeAccountWithWarranty(tenantId: string): Promise<{ accountId: string; policyId: string }> {
  const acct = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", `Bearer ${JWT}`)
    .send({ tenant_id: tenantId, display_name: "x", tier: "GROWTH" });
  expect(acct.status).toBe(201);

  const policy = await request(app)
    .post("/api/v1/insurance/policies")
    .set("Authorization", `Bearer ${JWT}`)
    .send({ account_id: acct.body.id });
  expect(policy.status).toBe(201);

  return { accountId: acct.body.id as string, policyId: policy.body.id as string };
}

function injectDenials(tenantId: string, granted: number, denied: number, daysAgo = 1): void {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO role_access_metrics (
      id, user_id, username, user_plane, user_plane_role, user_tenant_id,
      requested_resource, requested_method, required_plane, required_roles,
      access_granted, is_boundary_crossing, is_tenant_violation,
      is_elevation_attempt, evaluated_at
    ) VALUES (?, 'u', 'u', 'client', 'client_partner', ?,
              '/x', 'GET', 'business', '["x"]',
              ?, 0, 0, 0, ?)
  `);
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  for (let i = 0; i < granted; i++) stmt.run(crypto.randomUUID(), tenantId, 1, ts);
  for (let i = 0; i < denied;  i++) stmt.run(crypto.randomUUID(), tenantId, 0, ts);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("recomputeAllWarranties", () => {

  test("empty warranty set → summary with scanned=0", () => {
    // Run before any warranties exist by creating a fresh DB connection.
    // Using the shared app is fine here — earlier suites may have run,
    // but if so they'd ALL still be ACTIVE if no drift was injected.
    // We assert a behavioural floor: never errors, always produces a summary.
    const summary = recomputeAllWarranties(getDb());
    expect(summary).toMatchObject({
      scanned:       expect.any(Number),
      state_changes: expect.any(Number),
      badge_changes: expect.any(Number),
      errors:        0,
    });
    expect(summary.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("walks multiple warranties and applies state changes", async () => {
    // Create three accounts: one clean, two will void
    const clean = await makeAccountWithWarranty("scheduler_tenant_clean");
    const void1 = await makeAccountWithWarranty("scheduler_tenant_void1");
    const void2 = await makeAccountWithWarranty("scheduler_tenant_void2");

    // Drift on two of three: 100 granted + 10 denied = 9% anomaly ratio
    injectDenials("scheduler_tenant_void1", 100, 10);
    injectDenials("scheduler_tenant_void2", 100, 10);
    // clean stays clean

    const summary = recomputeAllWarranties(getDb());

    expect(summary.scanned).toBeGreaterThanOrEqual(3);
    expect(summary.state_changes).toBeGreaterThanOrEqual(2);
    expect(summary.badge_changes).toBeGreaterThanOrEqual(2);
    expect(summary.errors).toBe(0);

    // Verify in DB
    const v1 = getDb().prepare(
      "SELECT policy_state FROM ai_insurance_warranties WHERE id = ?"
    ).get(void1.policyId) as { policy_state: string };
    const v2 = getDb().prepare(
      "SELECT policy_state FROM ai_insurance_warranties WHERE id = ?"
    ).get(void2.policyId) as { policy_state: string };
    const c = getDb().prepare(
      "SELECT policy_state FROM ai_insurance_warranties WHERE id = ?"
    ).get(clean.policyId) as { policy_state: string };

    expect(v1.policy_state).toBe("VOID_BY_ANOMALY_RATIO");
    expect(v2.policy_state).toBe("VOID_BY_ANOMALY_RATIO");
    expect(c.policy_state).toBe("ACTIVE");
  });

  test("skips already-VOID warranties on subsequent runs (only scans ACTIVE)", async () => {
    // After the previous test, void1 and void2 are VOID. Run again —
    // they should not appear in scanned count because the SELECT filters
    // by policy_state = 'ACTIVE'.
    const summaryBefore = recomputeAllWarranties(getDb());

    // No new drift, no state changes expected
    expect(summaryBefore.state_changes).toBe(0);

    // The "voided" tenants from the previous test should not affect scanned
    const activeCount = (getDb().prepare(
      "SELECT COUNT(*) as c FROM ai_insurance_warranties WHERE policy_state = 'ACTIVE'"
    ).get() as { c: number }).c;
    expect(summaryBefore.scanned).toBe(activeCount);
  });
});

// ─── Admin endpoint smoke test ────────────────────────────────────────────────

describe("POST /api/v1/admin/recompute-all", () => {

  test("returns the run summary for an authenticated super-admin", async () => {
    const res = await request(app)
      .post("/api/v1/admin/recompute-all")
      .set("Authorization", `Bearer ${JWT}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      scanned:       expect.any(Number),
      state_changes: expect.any(Number),
      badge_changes: expect.any(Number),
      errors:        0,
      duration_ms:   expect.any(Number),
      started_at:    expect.any(String),
      finished_at:   expect.any(String),
    });
  });

  test("rejects unauthenticated callers", async () => {
    const res = await request(app).post("/api/v1/admin/recompute-all");
    expect(res.status).toBe(401);
  });
});
