import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import Database from "better-sqlite3";
import { EvidenceDb, BillingMeterRow } from "../../evidenceDb";
import { tenantIsolation, checkShadowScanExpiry, requireRole, CaaSRequest } from "../../middleware";

function makeTempDb(): { db: EvidenceDb; filePath: string } {
  const filePath = path.join(os.tmpdir(), "caas-phase8-test-" + Date.now() + ".db");
  const db = new EvidenceDb(filePath);
  return { db, filePath };
}

function mockReq(overrides: { method?: string; url?: string; headers?: Record<string, string> }): CaaSRequest {
  return { method: "GET", url: "/dashboard", headers: {}, ...overrides } as unknown as CaaSRequest;
}

function mockRes(): { res: http.ServerResponse; getStatus: () => number; getBody: () => string } {
  let status = 0; let body = "";
  const res = { writeHead: (s: number) => { status = s; }, end: (b: string) => { body = b; } } as unknown as http.ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}

const EIGHT_DAYS_MS = 8 * 24 * 60 * 60 * 1000;

describe("Phase 8 — Test 1: RBAC Lock", () => {
  test("Executive role receives 403 on POST /api/reports/build", () => {
    const req = mockReq({ method: "POST", url: "/api/reports/build", headers: { "x-caas-role": "Executive" } });
    const { res, getStatus, getBody } = mockRes();
    const allowed = requireRole(req, res, "Auditor");
    expect(allowed).toBe(false);
    expect(getStatus()).toBe(403);
    const parsed = JSON.parse(getBody());
    expect(parsed.error).toBe("Forbidden");
    expect(parsed.code).toBe("ROLE_MISMATCH");
    expect(parsed.yourRole).toBe("Executive");
    expect(parsed.required).toBe("Auditor");
  });

  test("Partner role receives 403 on POST /api/reports/build", () => {
    const req = mockReq({ method: "POST", url: "/api/reports/build", headers: { "x-caas-role": "Partner" } });
    const { res, getStatus, getBody } = mockRes();
    const allowed = requireRole(req, res, "Auditor");
    expect(allowed).toBe(false);
    expect(getStatus()).toBe(403);
    const parsed = JSON.parse(getBody());
    expect(parsed.yourRole).toBe("Partner");
  });

  test("Auditor role is allowed on POST /api/reports/build", () => {
    const req = mockReq({ method: "POST", url: "/api/reports/build", headers: { "x-caas-role": "Auditor" } });
    const { res, getStatus } = mockRes();
    const allowed = requireRole(req, res, "Auditor");
    expect(allowed).toBe(true);
    expect(getStatus()).toBe(0);
  });

  test("Missing role header returns 401", () => {
    const req = mockReq({ method: "POST", url: "/api/reports/build", headers: {} });
    const { res, getStatus, getBody } = mockRes();
    const allowed = requireRole(req, res, "Auditor");
    expect(allowed).toBe(false);
    expect(getStatus()).toBe(401);
    expect(JSON.parse(getBody()).code).toBe("ROLE_MISSING");
  });
});

describe("Phase 8 — Test 2: Tenant Isolation", () => {
  test("tenantIsolation rejects missing X-Tenant-ID", () => {
    const req = mockReq({ headers: {} });
    const { res, getStatus, getBody } = mockRes();
    expect(tenantIsolation(req, res)).toBe(false);
    expect(getStatus()).toBe(400);
    expect(JSON.parse(getBody()).code).toBe("TENANT_REQUIRED");
  });

  test("tenantIsolation rejects malicious tenant ID", () => {
    const req = mockReq({ headers: { "x-tenant-id": "tenant'; DROP TABLE billing_meters;--" } });
    const { res, getStatus, getBody } = mockRes();
    expect(tenantIsolation(req, res)).toBe(false);
    expect(getStatus()).toBe(400);
    expect(JSON.parse(getBody()).code).toBe("TENANT_INVALID");
  });

  test("tenantIsolation attaches valid tenant ID to request", () => {
    const req = mockReq({ headers: { "x-tenant-id": "tenant_acme" } });
    const { res, getStatus } = mockRes();
    expect(tenantIsolation(req, res)).toBe(true);
    expect(getStatus()).toBe(0);
    expect((req as CaaSRequest).tenantId).toBe("tenant_acme");
  });

  test("Tenant A data is isolated from Tenant B", () => {
    const { db, filePath } = makeTempDb();
    try {
      const rawDb = new Database(filePath);
      rawDb.prepare(`INSERT INTO billing_meters (client_id, verification_runs, active_monitors, tenant_id) VALUES (?, ?, ?, ?)`).run("client_tenant_a", 42, 1, "tenant_a");
      rawDb.prepare(`INSERT INTO billing_meters (client_id, verification_runs, active_monitors, tenant_id) VALUES (?, ?, ?, ?)`).run("client_tenant_b", 99, 2, "tenant_b");
      rawDb.close();
      const tenantAMeters = db.getMeterByTenant("tenant_a");
      const tenantBMeters = db.getMeterByTenant("tenant_b");
      expect(tenantAMeters.length).toBe(1);
      expect(tenantAMeters[0]!.client_id).toBe("client_tenant_a");
      expect(tenantBMeters.length).toBe(1);
      expect(tenantBMeters[0]!.client_id).toBe("client_tenant_b");
      expect(tenantAMeters.map((m: BillingMeterRow) => m.client_id)).not.toContain("client_tenant_b");
    } finally { db.close(); if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
  });
});

describe("Phase 8 — Test 3: Trial Sandbox Lockdown", () => {
  test("Trial transitions to EXPIRED_LOCKED after 7 days", () => {
    const { db, filePath } = makeTempDb();
    try {
      const eightDaysAgo = new Date(Date.now() - EIGHT_DAYS_MS).toISOString();
      const rawDb = new Database(filePath);
      rawDb.prepare(`INSERT INTO billing_meters (client_id, verification_runs, active_monitors, tenant_id, trial_start_timestamp, trial_status) VALUES (?, ?, ?, ?, ?, ?)`).run("client_expired", 5, 1, "tenant_expired", eightDaysAgo, "ACTIVE");
      rawDb.close();
      const status = db.evaluateTrialStatus("tenant_expired", Date.now());
      expect(status).toBe("EXPIRED_LOCKED");
      expect(db.getMeterByTenant("tenant_expired")[0]!.trial_status).toBe("EXPIRED_LOCKED");
    } finally { db.close(); if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
  });

  test("Expired webhook is silently dropped with 202", () => {
    const { db, filePath } = makeTempDb();
    try {
      const eightDaysAgo = new Date(Date.now() - EIGHT_DAYS_MS).toISOString();
      const rawDb = new Database(filePath);
      rawDb.prepare(`INSERT INTO billing_meters (client_id, verification_runs, active_monitors, tenant_id, trial_start_timestamp, trial_status) VALUES (?, ?, ?, ?, ?, ?)`).run("client_expired2", 3, 1, "tenant_expired2", eightDaysAgo, "ACTIVE");
      rawDb.close();
      const req = mockReq({ method: "POST", url: "/webhook", headers: { "x-tenant-id": "tenant_expired2" } });
      req.tenantId = "tenant_expired2";
      const { res, getStatus, getBody } = mockRes();
      const result = checkShadowScanExpiry(req, res, db, Date.now());
      expect(result).toBe("locked_silent");
      expect(getStatus()).toBe(202);
      expect(JSON.parse(getBody()).note).toContain("Trial period has ended");
    } finally { db.close(); if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
  });

  test("Expired Executive dashboard receives 402 paywall", () => {
    const { db, filePath } = makeTempDb();
    try {
      const eightDaysAgo = new Date(Date.now() - EIGHT_DAYS_MS).toISOString();
      const rawDb = new Database(filePath);
      rawDb.prepare(`INSERT INTO billing_meters (client_id, verification_runs, active_monitors, tenant_id, trial_start_timestamp, trial_status) VALUES (?, ?, ?, ?, ?, ?)`).run("client_expired3", 2, 1, "tenant_expired3", eightDaysAgo, "ACTIVE");
      rawDb.close();
      const req = mockReq({ method: "GET", url: "/dashboard", headers: { "x-tenant-id": "tenant_expired3", "x-caas-role": "Executive" } });
      req.tenantId = "tenant_expired3";
      const { res, getStatus, getBody } = mockRes();
      const result = checkShadowScanExpiry(req, res, db, Date.now());
      expect(result).toBe("locked_paywall");
      expect(getStatus()).toBe(402);
      const parsed = JSON.parse(getBody());
      expect(parsed.code).toBe("TRIAL_EXPIRED");
      expect(parsed.upgrade.plans).toHaveLength(3);
      expect(parsed.upgrade.plans[0].tier).toBe("PAY_AS_YOU_GO");
    } finally { db.close(); if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
  });

  test("Active trial within 7 days passes through", () => {
    const { db, filePath } = makeTempDb();
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const rawDb = new Database(filePath);
      rawDb.prepare(`INSERT INTO billing_meters (client_id, verification_runs, active_monitors, tenant_id, trial_start_timestamp, trial_status) VALUES (?, ?, ?, ?, ?, ?)`).run("client_active", 1, 1, "tenant_active", oneDayAgo, "ACTIVE");
      rawDb.close();
      const req = mockReq({ method: "POST", url: "/webhook", headers: { "x-tenant-id": "tenant_active" } });
      req.tenantId = "tenant_active";
      const { res, getStatus } = mockRes();
      const result = checkShadowScanExpiry(req, res, db, Date.now());
      expect(result).toBe("active");
      expect(getStatus()).toBe(0);
    } finally { db.close(); if (fs.existsSync(filePath)) fs.unlinkSync(filePath); }
  });
});