/**
 * tests/phase15.test.ts
 * Phase 15 — End-to-end Shadow Governance pilot simulation.
 *
 * Validates:
 *   1. Account provisioning (LITE, GROWTH, ENTERPRISE tiers)
 *   2. SDK ingest via API key
 *   3. Warranty state machine transitions under simulated drift
 *   4. Trust badge signature gating
 *   5. PoV statement math + fixed-width rendering
 *
 * Compressed clock: simulated "days" are written into role_access_metrics
 * with backdated evaluated_at timestamps so the recompute logic sees
 * realistic windows. Real wall-clock time per test is sub-second.
 *
 * Run:
 *   npx jest tests/phase15.test.ts
 *
 * Requires: supertest, jest, ts-jest. If your existing test suite uses
 * different tooling, the test bodies translate cleanly — only the imports
 * and the lifecycle hooks need adapting.
 */

import request from "supertest";
import crypto  from "crypto";
import fs      from "fs";
import os      from "os";
import path    from "path";
import { createApp }       from "../src/server";
import { signBadgeState }  from "../src/routes/badge";
import { mintSuperAdminToken, createTestApp } from "./helpers/auth";

// ─── Test Fixtures ────────────────────────────────────────────────────────────

let app: ReturnType<typeof createApp>;
let dbPath: string;
let SUPER_ADMIN_JWT: string;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `caas-phase15-${Date.now()}.db`);
  app    = createTestApp(dbPath);
  SUPER_ADMIN_JWT = await mintSuperAdminToken(app);
});

afterAll(() => {
  // Close DB by removing reference; better-sqlite3 has no explicit close
  // needed for ephemeral files in tests.
  try { fs.unlinkSync(dbPath); } catch { /* fine */ }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Backdates evidence into role_access_metrics so recompute/PoV queries
 * see realistic windows. Daysago is "how long ago": 0 = now, 7 = 7d ago.
 */
function writeAccessMetric(
  tenantId: string,
  daysAgo: number,
  opts: {
    granted?: boolean;
    boundary?: boolean;
    resource?: string;
  } = {}
): void {
  const db = (app.locals as { db: import("better-sqlite3").Database }).db;
  const ts = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  db.prepare(`
    INSERT INTO role_access_metrics (
      id, user_id, username, user_plane, user_plane_role, user_tenant_id,
      requested_resource, requested_method, required_plane, required_roles,
      access_granted, is_boundary_crossing, is_tenant_violation,
      is_elevation_attempt, evaluated_at
    ) VALUES (?, 'u_test', 'test_user', 'client', 'client_partner', ?,
              ?, 'GET', 'business', '["global_super_admin"]',
              ?, ?, 0, 0, ?)
  `).run(
    crypto.randomUUID(),
    tenantId,
    opts.resource ?? "/api/v1/test",
    opts.granted === false ? 0 : opts.granted ? 1 : 0,
    opts.boundary ? 1 : 0,
    ts
  );
}

async function provisionAccount(
  tenantId: string,
  tier: "LITE" | "GROWTH" | "ENTERPRISE"
): Promise<{ id: string; api_key: string; tenant_id: string }> {
  const res = await request(app)
    .post("/api/v1/accounts")
    .set("Authorization", `Bearer ${SUPER_ADMIN_JWT}`)
    .send({
      tenant_id:    tenantId,
      display_name: `Test ${tier} Account`,
      tier,
    });
  expect(res.status).toBe(201);
  return { id: res.body.id, api_key: res.body.api_key, tenant_id: tenantId };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Phase 15: Account provisioning across all tiers", () => {
  it("creates LITE / GROWTH / ENTERPRISE accounts with unique API keys", async () => {
    const lite       = await provisionAccount("tenant_lite",       "LITE");
    const growth     = await provisionAccount("tenant_growth",     "GROWTH");
    const enterprise = await provisionAccount("tenant_enterprise", "ENTERPRISE");

    expect(lite.api_key).toMatch(/^caas_[a-f0-9]{64}$/);
    expect(growth.api_key).toMatch(/^caas_[a-f0-9]{64}$/);
    expect(enterprise.api_key).toMatch(/^caas_[a-f0-9]{64}$/);

    expect(lite.api_key).not.toBe(growth.api_key);
    expect(growth.api_key).not.toBe(enterprise.api_key);
  });

  it("rejects duplicate tenant_id at the provisioning route", async () => {
    await provisionAccount("tenant_dup", "LITE");
    const res = await request(app)
      .post("/api/v1/accounts")
      .set("Authorization", `Bearer ${SUPER_ADMIN_JWT}`)
      .send({ tenant_id: "tenant_dup", display_name: "dup", tier: "LITE" });
    expect(res.status).toBe(409);
  });
});

describe("Phase 15: SDK ingest via API key", () => {
  it("accepts a decision with a valid API key and returns 202", async () => {
    const acct = await provisionAccount("tenant_ingest1", "GROWTH");

    const res = await request(app)
      .post("/api/v1/pilot/decisions")
      .set("Authorization", `Bearer ${acct.api_key}`)
      .send({
        decision_class: "fraud_score",
        risk_score:     0.83,
        payload:        { reason: "velocity" },
      });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(1);
    expect(Array.isArray(res.body.ids)).toBe(true);
  });

  it("accepts a batch of <= 50 decisions", async () => {
    const acct = await provisionAccount("tenant_ingest2", "GROWTH");
    const decisions = Array.from({ length: 25 }, (_, i) => ({
      client_decision_id: `txn_${i}`,
      decision_class:     "fraud_score",
      risk_score:         Math.random(),
      payload:            { i },
    }));

    const res = await request(app)
      .post("/api/v1/pilot/decisions")
      .set("Authorization", `Bearer ${acct.api_key}`)
      .send({ decisions });

    expect(res.status).toBe(202);
    expect(res.body.accepted).toBe(25);
  });

  it("rejects requests without an API key", async () => {
    const res = await request(app)
      .post("/api/v1/pilot/decisions")
      .send({ decision_class: "fraud_score" });
    expect(res.status).toBe(401);
  });

  it("rejects requests with a malformed API key", async () => {
    const res = await request(app)
      .post("/api/v1/pilot/decisions")
      .set("Authorization", "Bearer not-a-valid-key")
      .send({ decision_class: "fraud_score" });
    expect(res.status).toBe(401);
  });

  it("rejects batches that exceed the per-request limit", async () => {
    const acct = await provisionAccount("tenant_ingest3", "GROWTH");
    const decisions = Array.from({ length: 75 }, () => ({ decision_class: "x" }));
    const res = await request(app)
      .post("/api/v1/pilot/decisions")
      .set("Authorization", `Bearer ${acct.api_key}`)
      .send({ decisions });
    expect(res.status).toBe(413);
  });
});

describe("Phase 15: Warranty state machine under simulated drift", () => {
  it("starts ACTIVE and stays ACTIVE with no anomalies", async () => {
    const acct = await provisionAccount("tenant_warranty_clean", "GROWTH");

    const bind = await request(app)
      .post("/api/v1/insurance/policies")
      .set("Authorization", `Bearer ${SUPER_ADMIN_JWT}`)
      .send({ account_id: acct.id });
    expect(bind.status).toBe(201);

    // Inject some traffic, all granted
    for (let d = 0; d < 7; d++) {
      writeAccessMetric(acct.tenant_id, d, { granted: true });
    }

    const rc = await request(app)
      .post(`/api/v1/insurance/policies/${bind.body.id}/recompute`)
      .set("Authorization", `Bearer ${SUPER_ADMIN_JWT}`);

    expect(rc.status).toBe(200);
    expect(rc.body.current_state).toBe("ACTIVE");
    expect(rc.body.changed).toBe(false);
  });

  it("transitions to VOID_BY_ANOMALY_RATIO when denials exceed 2%", async () => {
    const acct = await provisionAccount("tenant_warranty_anomaly", "GROWTH");
    const bind = await request(app)
      .post("/api/v1/insurance/policies")
      .set("Authorization", `Bearer ${SUPER_ADMIN_JWT}`)
      .send({ account_id: acct.id });

    // 200 granted, 10 denied → ~4.7%, well above 2% threshold
    for (let i = 0; i < 200; i++) writeAccessMetric(acct.tenant_id, 1, { granted: true });
    for (let i = 0; i < 10;  i++) writeAccessMetric(acct.tenant_id, 1, { granted: false });

    const rc = await request(app)
      .post(`/api/v1/insurance/policies/${bind.body.id}/recompute`)
      .set("Authorization", `Bearer ${SUPER_ADMIN_JWT}`);

    expect(rc.body.current_state).toBe("VOID_BY_ANOMALY_RATIO");
    expect(rc.body.changed).toBe(true);
    expect(rc.body.evidence.anomaly_ratio).toBeGreaterThan(0.02);
  });

  it("transitions to VOID_BY_COMPLIANCE_DRIFT on 10+ boundary crossings", async () => {
    const acct = await provisionAccount("tenant_warranty_drift", "GROWTH");
    const bind = await request(app)
      .post("/api/v1/insurance/policies")
      .set("Authorization", `Bearer ${SUPER_ADMIN_JWT}`)
      .send({ account_id: acct.id });

    // Boundary crossings spread over the 30d drift window
    for (let i = 0; i < 12; i++) {
      writeAccessMetric(acct.tenant_id, i + 1, { granted: true, boundary: true });
    }

    const rc = await request(app)
      .post(`/api/v1/insurance/policies/${bind.body.id}/recompute`)
      .set("Authorization", `Bearer ${SUPER_ADMIN_JWT}`);

    expect(rc.body.current_state).toBe("VOID_BY_COMPLIANCE_DRIFT");
    expect(rc.body.evidence.boundary_crossings).toBeGreaterThanOrEqual(10);
  });
});

describe("Phase 15: Trust badge signature gating", () => {
  it("returns 404 for badge requests with a wrong signature", async () => {
    const acct = await provisionAccount("tenant_badge_wrong", "LITE");
    // createAccount already seeded a badge row via syncBadge. Override
    // it here so the signature matches what this test expects to verify.
    const db = (app.locals as { db: import("better-sqlite3").Database }).db;
    const now = new Date().toISOString();
    const sig = signBadgeState(acct.tenant_id, "green", now);
    db.prepare(`
      INSERT OR REPLACE INTO trust_badge_registry
        (tenant_id, account_id, badge_state, state_signature, state_changed_at, created_at, updated_at)
      VALUES (?, ?, 'green', ?, ?, ?, ?)
    `).run(acct.tenant_id, acct.id, sig, now, now, now);

    const res = await request(app)
      .get(`/api/v1/badge/${acct.tenant_id}?sig=wrong_signature`);
    expect(res.status).toBe(404);
  });

  it("returns badge state when the signature matches", async () => {
    const acct = await provisionAccount("tenant_badge_right", "LITE");
    const db = (app.locals as { db: import("better-sqlite3").Database }).db;
    const now = new Date().toISOString();
    const sig = signBadgeState(acct.tenant_id, "green", now);
    db.prepare(`
      INSERT OR REPLACE INTO trust_badge_registry
        (tenant_id, account_id, badge_state, state_signature, state_changed_at, created_at, updated_at)
      VALUES (?, ?, 'green', ?, ?, ?, ?)
    `).run(acct.tenant_id, acct.id, sig, now, now, now);

    const res = await request(app)
      .get(`/api/v1/badge/${acct.tenant_id}?sig=${sig}`);
    expect(res.status).toBe(200);
    expect(res.body.badge_state).toBe("green");
  });
});

describe("Phase 15: PoV statement math", () => {
  it("computes value delivered using tier-keyed baselines", async () => {
    const acct = await provisionAccount("tenant_pov", "ENTERPRISE");

    // 50 denials, 10 of which are boundary crossings
    for (let i = 0; i < 100; i++) writeAccessMetric(acct.tenant_id, 5, { granted: true });
    for (let i = 0; i < 40;  i++) writeAccessMetric(acct.tenant_id, 5, { granted: false });
    for (let i = 0; i < 10;  i++) writeAccessMetric(acct.tenant_id, 5, { granted: false, boundary: true });

    const res = await request(app)
      .get(`/api/v1/pov/${acct.id}/statement?window_days=30`)
      .set("Authorization", `Bearer ${SUPER_ADMIN_JWT}`);

    expect(res.status).toBe(200);
    expect(res.body.metrics.risks_blocked).toBe(50);
    expect(res.body.metrics.crossings_blocked).toBe(10);

    // Math: (40 ordinary × 100k) + (10 crossings × 100k × 3) = 4M + 3M = 7M
    expect(res.body.economics.value_delivered_usd).toBe(7_000_000);
    // 30 days at ENTERPRISE = 12k monthly cost pro-rated = 12k
    expect(res.body.economics.platform_cost_usd).toBe(12_000);
    expect(res.body.economics.roi_ratio).toBeGreaterThan(500);
  });

  it("returns a fixed-width text statement that includes the key figures", async () => {
    const acct = await provisionAccount("tenant_pov_text", "LITE");
    for (let i = 0; i < 10; i++) writeAccessMetric(acct.tenant_id, 1, { granted: false });

    const res = await request(app)
      .get(`/api/v1/pov/${acct.id}/statement.txt`)
      .set("Authorization", `Bearer ${SUPER_ADMIN_JWT}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/plain/);
    expect(res.text).toContain("CaaS PROOF-OF-VALUE STATEMENT");
    expect(res.text).toContain("Risks blocked");
    expect(res.text).toContain("ROI multiple");
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
 * NOTES:
 *
 *   1. JWT auth is wired via tests/helpers/auth.ts → mintSuperAdminToken().
 *      The helper seeds a super-admin row directly into the test DB and
 *      mints a token against the real /auth/login route. If you add a
 *      second test file that needs the same token shape, consider moving
 *      this into a global Jest setup file.
 *
 *   2. The `writeAccessMetric` helper writes directly into the DB rather
 *      than going through Phase 12's normal request-pipeline path. That's
 *      intentional — we're testing Phase 15's reaction to Phase 12 data,
 *      not Phase 12 itself.
 *
 *   3. ENTERPRISE PoV math is sensitive to PENALTY_BASELINE_USD constants
 *      in pov-billing.ts. When those get calibrated against real underwriting
 *      data, this expectation needs updating.
 * ───────────────────────────────────────────────────────────────────────── */
