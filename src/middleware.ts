import * as http from "http";
import { EvidenceDb } from "./evidenceDb";
import { logger } from "./lib/logger";

export type CaaSRole = "Executive" | "Auditor" | "Partner";

export const ROLE_PERMISSIONS: Record<CaaSRole, { allowed: string[]; blocked: string[] }> = {
  Executive: { allowed: ["/dashboard", "/api/v1/badge", "/api/meters"], blocked: ["/api/evidence", "/api/reports/build", "/api/agents/payouts"] },
  Auditor:   { allowed: ["/api/reports/build", "/api/evidence", "/api/vault/export-ledger", "/api/audit/mini"], blocked: ["/api/meters", "/api/agents/payouts"] },
  Partner:   { allowed: ["/api/agents/payouts", "/api/v1/badge"], blocked: ["/dashboard", "/api/evidence", "/api/reports/build", "/api/meters"] },
};

export interface CaaSRequest extends http.IncomingMessage {
  tenantId?: string;
  caasRole?: CaaSRole;
}

export function tenantIsolation(req: CaaSRequest, res: http.ServerResponse): boolean {
  const raw = req.headers["x-tenant-id"];
  const tenantId = Array.isArray(raw) ? raw[0] : raw;
  if (!tenantId || typeof tenantId !== "string" || tenantId.trim().length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing X-Tenant-ID header", code: "TENANT_REQUIRED", message: "All requests must include a valid X-Tenant-ID header for tenant isolation." }));
    return false;
  }
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tenantId.trim())) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Invalid X-Tenant-ID format", code: "TENANT_INVALID", message: "Tenant ID must be 1-64 alphanumeric characters, underscores, or hyphens." }));
    return false;
  }
  req.tenantId = tenantId.trim();
  return true;
}

export function extractRole(req: CaaSRequest, res: http.ServerResponse): CaaSRole | null {
  const raw  = req.headers["x-caas-role"];
  const role = (Array.isArray(raw) ? raw[0] : raw)?.trim() as CaaSRole | undefined;
  if (!role) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized", code: "ROLE_MISSING", message: "X-CaaS-Role header is required." }));
    return null;
  }
  if (!["Executive", "Auditor", "Partner"].includes(role)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden", code: "ROLE_INVALID", message: "Unknown role: " + role }));
    return null;
  }
  req.caasRole = role;
  return role;
}

export function requireRole(req: CaaSRequest, res: http.ServerResponse, required: CaaSRole): boolean {
  const role = extractRole(req, res);
  if (!role) return false;
  if (role !== required) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden", code: "ROLE_MISMATCH", message: "This endpoint requires the " + required + " role. Your role " + role + " is not permitted.", yourRole: role, required }));
    return false;
  }
  return true;
}

export function checkShadowScanExpiry(req: CaaSRequest, res: http.ServerResponse, db: EvidenceDb, nowMs: number = Date.now()): "active" | "locked_silent" | "locked_paywall" {
  const tenantId = req.tenantId ?? "default_tenant";
  const status   = db.evaluateTrialStatus(tenantId, nowMs);
  if (status !== "EXPIRED_LOCKED") return "active";

  const isWebhookIngestion   = req.method === "POST" && req.url === "/webhook";
  const isExecutiveDashboard = req.method === "GET" && (req.url === "/dashboard" || req.url?.startsWith("/api/meters")) && req.headers["x-caas-role"] === "Executive";

  if (isWebhookIngestion) {
    logger.info("caas-lite: trial expired — webhook silently dropped", { tenantId });
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "accepted", note: "Trial period has ended. Upgrade to continue processing." }));
    return "locked_silent";
  }

  if (isExecutiveDashboard) {
    logger.info("caas-lite: trial expired — paywall served to Executive", { tenantId });
    res.writeHead(402, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Payment Required", code: "TRIAL_EXPIRED", message: "Your 7-day shadow scan trial has ended. Upgrade your plan to restore full access.", tenantId, upgrade: { plans: [{ tier: "PAY_AS_YOU_GO", price: "$0.05 per verification run", description: "Pay only for what you use." }, { tier: "GROWTH", price: "$299/month", description: "Up to 10,000 runs/month, priority support." }, { tier: "ENTERPRISE", price: "Contact us", description: "Unlimited runs, dedicated CSM, SLA guarantee." }], contact: "sales@caas-lite.io" } }));
    return "locked_paywall";
  }

  res.writeHead(402, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Payment Required", code: "TRIAL_EXPIRED", message: "Your 7-day shadow scan trial has ended. Please upgrade to continue.", tenantId }));
  return "locked_paywall";
}