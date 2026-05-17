import "dotenv/config";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { PolicyEngine } from "./engine/policy";
import { VerificationEngine } from "./engine/verification";
import { WebhookReceiver } from "./webhook/receiver";
import { EvidenceDb } from "./evidenceDb";
import { logger } from "./lib/logger";

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const HEADER_API_KEY = process.env["HEADER_API_KEY"] ?? "";
const ALERT_FORWARD_URL = process.env["ALERT_FORWARD_URL"] ?? "";
const DEFAULT_CLIENT_ID = "default_client";
const AGENT_COMMISSION_RATE = 0.15;

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!HEADER_API_KEY) { logger.warn("caas-lite: HEADER_API_KEY not set"); return true; }
  return req.headers["x-api-key"] === HEADER_API_KEY;
}
function rejectUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}
function extractClientId(req: http.IncomingMessage): string {
  const raw = req.headers["x-client-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (typeof value === "string" && value.trim().length > 0) ? value.trim() : DEFAULT_CLIENT_ID;
}
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
async function forwardAlert(batch: unknown): Promise<void> {
  if (!ALERT_FORWARD_URL) return;
  try {
    const { default: https } = await import("https");
    const { default: http } = await import("http");
    const payload = Buffer.from(JSON.stringify({ source: "caas-lite", timestamp: new Date().toISOString(), batch }));
    const url = new URL(ALERT_FORWARD_URL);
    const client = url.protocol === "https:" ? https : http;
    await new Promise<void>((resolve, reject) => {
      const req = client.request({ hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80), path: url.pathname + url.search, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": payload.length, "X-Source": "caas-lite" } }, (res) => { res.resume(); logger.info("caas-lite: alert forwarded", { status: res.statusCode }); resolve(); });
      req.on("error", reject); req.write(payload); req.end();
    });
  } catch (e) { logger.error("caas-lite: alert forward failed", { error: (e as Error).message }); }
}

interface MiniAuditRequest { agent_id: string; prospect_id: string; profile: Record<string, unknown>; }
interface ComplianceGap { control: string; description: string; severity: "critical" | "high" | "medium"; }
interface MiniAuditReport { prospect_id: string; agent_id: string; readiness_score: number; gaps: ComplianceGap[]; summary: string; generated_at: string; }
function runMiniAudit(req: MiniAuditRequest): MiniAuditReport {
  const p = req.profile; const gaps: ComplianceGap[] = [];
  if (!p["mfa_enabled"]) gaps.push({ control: "CC6.1", description: "MFA is not enforced.", severity: "critical" });
  if (!p["access_reviews_quarterly"]) gaps.push({ control: "CC6.2", description: "Quarterly access reviews not in place.", severity: "high" });
  if (!p["least_privilege_policy"]) gaps.push({ control: "CC6.3", description: "No least-privilege policy found.", severity: "high" });
  if (!p["change_approval_process"]) gaps.push({ control: "CC7.2", description: "No change approval process.", severity: "medium" });
  if (!p["vendor_risk_assessments"]) gaps.push({ control: "CC9.1", description: "Vendor risk assessments not conducted.", severity: "medium" });
  if (!p["incident_response_plan"]) gaps.push({ control: "CC2.1", description: "No incident response plan.", severity: "critical" });
  const deductions = gaps.reduce((sum, g) => sum + (g.severity === "critical" ? 20 : g.severity === "high" ? 12 : 7), 0);
  return { prospect_id: req.prospect_id, agent_id: req.agent_id, readiness_score: Math.max(0, 100 - deductions), gaps, summary: gaps.length === 0 ? "No critical gaps detected." : gaps.length + " gap(s) identified. " + gaps.filter(g => g.severity === "critical").length + " critical control(s) require immediate remediation.", generated_at: new Date().toISOString() };
}

interface AssessmentRequest { business_sector: string; ai_usage_type: string; processes_personal_data: boolean; agent_id?: string; }
interface AssessmentReport { business_sector: string; ai_usage_type: string; processes_personal_data: boolean; risk_score: number; risk_tier: "Low" | "Medium" | "High"; gaps: ComplianceGap[]; prompt_templates: string[]; summary: string; generated_at: string; }
const SECTOR_WEIGHTS: Record<string, number> = { finance: 30, healthcare: 30, legal: 25, hr: 20, education: 15, retail: 10, technology: 10, other: 5 };
const AI_USAGE_WEIGHTS: Record<string, number> = { automated_decisions: 35, customer_facing: 25, internal_analytics: 15, content_generation: 10, basic_automation: 5 };
const ADVISORY_TEMPLATES: Record<string, string[]> = {
  "finance:automated_decisions": ["LEGAL NOTICE — Automated Credit Decision: You have the right to request human review within 30 days.", "POLICY — Model Risk Management: Establish model validation per SR 11-7 guidance."],
  "hr:automated_decisions": ["LEGAL NOTICE — AI Hiring Disclosure: Candidates may request human review.", "COMPLIANCE — Bias Audit: Conduct annual disparate impact analysis."],
  "healthcare:customer_facing": ["LEGAL NOTICE — AI Clinical Support: AI recommendations do not replace clinical judgment.", "POLICY — PHI Handling: Ensure AI vendor HIPAA BAA provisions."],
  "default": ["POLICY — AI Governance: Establish an internal AI use policy covering acceptable use and human oversight.", "COMPLIANCE — Vendor Due Diligence: Assess all third-party AI tools before deployment."]
};
function runSmbAssessment(req: AssessmentRequest): AssessmentReport {
  const gaps: ComplianceGap[] = [];
  const sw = SECTOR_WEIGHTS[req.business_sector.toLowerCase()] ?? 5;
  const uw = AI_USAGE_WEIGHTS[req.ai_usage_type.toLowerCase()] ?? 5;
  const risk_score = Math.min(100, sw + uw + (req.processes_personal_data ? 20 : 0));
  const risk_tier: "Low" | "Medium" | "High" = risk_score >= 60 ? "High" : risk_score >= 30 ? "Medium" : "Low";
  if (req.processes_personal_data) gaps.push({ control: "CC9.1", description: "Personal data processing requires a DPIA.", severity: "critical" });
  if (["automated_decisions", "customer_facing"].includes(req.ai_usage_type.toLowerCase())) gaps.push({ control: "CC6.1", description: "AI decision systems require human oversight mechanisms.", severity: "high" });
  if (["finance", "healthcare", "legal"].includes(req.business_sector.toLowerCase())) gaps.push({ control: "CC7.2", description: "Regulated sector AI requires documented change management.", severity: "high" });
  const templateKey = req.business_sector.toLowerCase() + ":" + req.ai_usage_type.toLowerCase();
  const prompt_templates = ADVISORY_TEMPLATES[templateKey] ?? ADVISORY_TEMPLATES["default"]!;
  return { business_sector: req.business_sector, ai_usage_type: req.ai_usage_type, processes_personal_data: req.processes_personal_data, risk_score, risk_tier, gaps, prompt_templates, summary: "Risk tier: " + risk_tier + " (score: " + risk_score + "/100). " + gaps.length + " gap(s) identified.", generated_at: new Date().toISOString() };
}

function generateBadgeSvg(verified: boolean): string {
  const label = "CaaS Status";
  const status = verified ? "Verified Compliant" : "In Shadow Scan";
  const bgColor = verified ? "#10b981" : "#f59e0b";
  const labelW = 82; const statusW = verified ? 118 : 108; const totalW = labelW + statusW;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${label}: ${status}">`,
    `<title>${label}: ${status}</title>`,
    `<defs><clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath></defs>`,
    `<g clip-path="url(#r)"><rect width="${labelW}" height="20" fill="#555"/><rect x="${labelW}" width="${statusW}" height="20" fill="${bgColor}"/></g>`,
    `<g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">`,
    `<text x="${labelW / 2}" y="14" fill="#010101" fill-opacity=".3">${label}</text>`,
    `<text x="${labelW / 2}" y="13">${label}</text>`,
    `<text x="${labelW + statusW / 2}" y="14" fill="#010101" fill-opacity=".3">${status}</text>`,
    `<text x="${labelW + statusW / 2}" y="13">${status}</text>`,
    `</g></svg>`,
  ].join("");
}

async function main(): Promise<void> {
  logger.info("caas-lite: starting up");
  const evidenceDb = new EvidenceDb();
  const policyEngine = await PolicyEngine.create();
  logger.info("caas-lite: policy engine ready", { policies: policyEngine.size });
  policyEngine.watch();
  const verificationEngine = new VerificationEngine(policyEngine);
  let currentClientId: string = DEFAULT_CLIENT_ID;

  const webhookReceiver = new WebhookReceiver({
    verificationEngine,
    onVerified: async (batch) => {
      const clientId = currentClientId;
      const batchAny = batch as unknown as Record<string, unknown>;
      const eventMeta = batchAny["event"] as Record<string, unknown> | undefined;
      const meta = eventMeta?.["metadata"] as Record<string, unknown> | undefined;
      const isShadowScan = meta?.["mode"] === "shadow_scan" || eventMeta?.["environment"] === "shadow_scan";
      await evidenceDb.incrementMeter(clientId, "runs");
      logger.info("caas-lite: meter incremented", { clientId, eventId: batch.event.id, shadowScan: isShadowScan });
      await evidenceDb.append(batch);
      if (!isShadowScan && batch.overallOutcome === "fail" && batch.alerts.length > 0) {
        for (const alert of batch.alerts) { logger.warn("[ALERT] Policy Violation for Batch " + batch.event.id, { policyId: alert.policyId, controlId: alert.controlId, severity: alert.severity, message: alert.message }); }
        void forwardAlert(batch);
      } else if (isShadowScan && batch.overallOutcome === "fail") {
        logger.info("caas-lite: shadow scan failure recorded (no alert)", { eventId: batch.event.id });
      }
      logger.info("caas-lite: batch appended to evidence vault", { eventId: batch.event.id, outcome: batch.overallOutcome, alerts: batch.alerts.length, shadowScan: isShadowScan });
    },
  });

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/evidence") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      try { const rows = evidenceDb.getHistory(50); res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(rows.map(r => ({ id: r.id, timestamp: r.timestamp, batch: JSON.parse(r.batchData) })))); } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
      return;
    }
    if (req.method === "GET" && req.url === "/api/meters") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      try { res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(evidenceDb.getAllMeters())); } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
      return;
    }
    if (req.method === "GET" && req.url === "/dashboard") {
      const dashPath = path.resolve(process.cwd(), "public", "index.html");
      if (!fs.existsSync(dashPath)) { res.writeHead(404); res.end("Dashboard not found."); return; }
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync(dashPath)); return;
    }
    if (req.method === "GET" && req.url !== undefined && req.url.startsWith("/api/vault/export-ledger")) {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      void (async () => {
        try {
          const parsedUrl = new URL(req.url!, "http://localhost");
          const clientId = parsedUrl.searchParams.get("client_id") ?? (req.headers["x-client-id"] as string | undefined) ?? "";
          if (!clientId.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "client_id is required" })); return; }
          const ledger = await evidenceDb.exportSignedLedger(clientId.trim());
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ ...ledger, meta: { algorithm: "SHA-256", note: "Checksum over canonical JSON payload." } }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
      })(); return;
    }
    if (req.method === "GET" && req.url !== undefined && req.url.startsWith("/api/v1/badge/")) {
      void (async () => {
        try {
          const clientId = decodeURIComponent(req.url!.replace("/api/v1/badge/", "").split("?")[0].trim());
          if (!clientId) { res.writeHead(400); res.end(JSON.stringify({ error: "clientId is required" })); return; }
          const meter = evidenceDb.getMeter(clientId);
          const history = evidenceDb.getHistory(10);
          const recentFails = history.filter(row => { try { return (JSON.parse(row.batchData) as Record<string, unknown>)["overallOutcome"] === "fail"; } catch { return false; } });
          const verified = meter !== null && recentFails.length === 0;
          logger.info("caas-lite: trust badge served", { clientId, verified, status: verified ? "Verified Compliant" : "In Shadow Scan" });
          res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-cache, max-age=0", "Access-Control-Allow-Origin": "*" });
          res.end(generateBadgeSvg(verified));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
      })(); return;
    }
    if (req.method === "POST" && req.url === "/api/audit/mini") {
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req)) as Partial<MiniAuditRequest>;
          if (typeof body.agent_id !== "string" || !body.agent_id.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "agent_id is required" })); return; }
          if (typeof body.prospect_id !== "string" || !body.prospect_id.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "prospect_id is required" })); return; }
          if (typeof body.profile !== "object" || body.profile === null) { res.writeHead(422); res.end(JSON.stringify({ error: "profile must be an object" })); return; }
          evidenceDb.upsertAgent(body.agent_id.trim());
          const report = runMiniAudit({ agent_id: body.agent_id.trim(), prospect_id: body.prospect_id.trim(), profile: body.profile });
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(report));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: (e as Error).message })); }
      })(); return;
    }
    if (req.method === "POST" && req.url === "/api/agents/payouts") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req)) as { client_id?: string; agent_id?: string; subscription_amount?: number; momo_number?: string };
          if (!body.client_id?.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "client_id is required" })); return; }
          if (typeof body.subscription_amount !== "number" || body.subscription_amount <= 0) { res.writeHead(422); res.end(JSON.stringify({ error: "subscription_amount must be positive" })); return; }
          const clientId = body.client_id.trim();
          let agentId = body.agent_id?.trim() || evidenceDb.getAttribution(clientId);
          if (!agentId) { res.writeHead(404); res.end(JSON.stringify({ error: "No agent attribution found" })); return; }
          evidenceDb.upsertAgent(agentId, body.momo_number);
          evidenceDb.attributeClient(clientId, agentId);
          const commission = parseFloat((body.subscription_amount * AGENT_COMMISSION_RATE).toFixed(2));
          if (!evidenceDb.addPayout(agentId, commission)) { res.writeHead(404); res.end(JSON.stringify({ error: "Agent not found" })); return; }
          const agent = evidenceDb.getAgent(agentId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "payout_recorded", agent_id: agentId, client_id: clientId, subscription_amount: body.subscription_amount, commission_rate: AGENT_COMMISSION_RATE, commission_earned: commission, total_payouts: agent?.total_payouts ?? commission, momo_number: agent?.momo_number ?? null, note: "Ready for Paystack/Stripe/MoMo disbursement" }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: (e as Error).message })); }
      })(); return;
    }
    if (req.method === "POST" && req.url === "/api/assessments/submit") {
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req)) as Partial<AssessmentRequest>;
          if (!body.business_sector?.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "business_sector is required" })); return; }
          if (!body.ai_usage_type?.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "ai_usage_type is required" })); return; }
          if (typeof body.processes_personal_data !== "boolean") { res.writeHead(422); res.end(JSON.stringify({ error: "processes_personal_data must be boolean" })); return; }
          if (body.agent_id?.trim()) evidenceDb.upsertAgent(body.agent_id.trim());
          const report = runSmbAssessment({ business_sector: body.business_sector.trim(), ai_usage_type: body.ai_usage_type.trim(), processes_personal_data: body.processes_personal_data, agent_id: body.agent_id?.trim() });
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(report));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: (e as Error).message })); }
      })(); return;
    }
    if (req.method === "POST" && req.url === "/api/webhook/ipaas") {
      void (async () => {
        try {
          const raw = JSON.parse(await readBody(req)) as Record<string, unknown>;
          const clientId = (raw["client_id"] as string | undefined)?.trim() || DEFAULT_CLIENT_ID;
          const source = (raw["source"] as string | undefined)?.trim() || "ipaas_connector";
          const normalized = { id: (raw["event_id"] as string | undefined) ?? "ipaas-" + Date.now(), type: (raw["event_type"] as string | undefined) ?? "ipaas.event", occurredAt: (raw["occurred_at"] as string | undefined) ?? new Date().toISOString(), receivedAt: new Date().toISOString(), source, actor: { id: (raw["actor_id"] as string | undefined) ?? clientId, name: (raw["actor_name"] as string | undefined) ?? "iPaaS Connector", kind: "service" as const }, metadata: { ...(raw["metadata"] as Record<string, unknown> | undefined ?? {}), ipaas_source: source, client_id: clientId }, environment: (raw["environment"] as string | undefined) ?? "production", overallOutcome: "inconclusive", alerts: [], verificationResults: [] };
          await evidenceDb.append(normalized);
          await evidenceDb.incrementMeter(clientId, "runs");
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "accepted", event_id: normalized.id, client_id: clientId, source }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: (e as Error).message })); }
      })(); return;
    }
    if (req.method === "POST" && req.url === "/api/aibom/register") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req)) as { client_id?: string; component_name?: string; vendor?: string; version?: string; risk_tier?: string };
          if (!body.client_id?.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "client_id is required" })); return; }
          if (!body.component_name?.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "component_name is required" })); return; }
          if (!body.vendor?.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "vendor is required" })); return; }
          if (!body.version?.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "version is required" })); return; }
          const riskTier = body.risk_tier?.trim() || "Medium";
          if (!["Low", "Medium", "High", "Critical"].includes(riskTier)) { res.writeHead(422); res.end(JSON.stringify({ error: "risk_tier must be Low, Medium, High, or Critical" })); return; }
          await evidenceDb.registerComponent({ clientId: body.client_id.trim(), name: body.component_name.trim(), vendor: body.vendor.trim(), version: body.version.trim(), riskTier });
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "registered", client_id: body.client_id.trim(), component_name: body.component_name.trim(), vendor: body.vendor.trim(), version: body.version.trim(), risk_tier: riskTier }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: (e as Error).message })); }
      })(); return;
    }
    if (req.method === "GET" && req.url !== undefined && req.url.startsWith("/api/aibom")) {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      void (async () => {
        try {
          const parsedUrl = new URL(req.url!, "http://localhost");
          const clientId = parsedUrl.searchParams.get("client_id") ?? (req.headers["x-client-id"] as string | undefined) ?? "";
          if (!clientId.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "client_id is required" })); return; }
          const components = await evidenceDb.getComponentsByClient(clientId.trim());
          res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify({ client_id: clientId.trim(), component_count: components.length, components }));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
      })(); return;
    }
    // ── POST /api/reports/build  (Auditor only) — Phase 8 ────────────────────
    if (req.method === "POST" && req.url === "/api/reports/build") {
      const { requireRole: rbac } = await import("./middleware");
      if (!rbac(req as import("./middleware").CaaSRequest, res, "Auditor")) return;
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req)) as {
            tenantId?: string; includeAibom?: boolean;
            includeBillingRuns?: boolean; dateRange?: { start: string; end: string };
          };
          if (!body.tenantId?.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "tenantId is required" })); return; }
          if (typeof body.includeAibom !== "boolean") { res.writeHead(422); res.end(JSON.stringify({ error: "includeAibom must be boolean" })); return; }
          if (typeof body.includeBillingRuns !== "boolean") { res.writeHead(422); res.end(JSON.stringify({ error: "includeBillingRuns must be boolean" })); return; }
          if (!body.dateRange?.start || !body.dateRange?.end) { res.writeHead(422); res.end(JSON.stringify({ error: "dateRange.start and dateRange.end are required ISO8601 strings" })); return; }
          const result = await evidenceDb.buildReport({ tenantId: body.tenantId.trim(), includeAibom: body.includeAibom, includeBillingRuns: body.includeBillingRuns, dateRange: body.dateRange });
          logger.info("caas-lite: audit report built", { tenantId: body.tenantId.trim(), reportPath: result.reportPath });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
      })(); return;
    }
    currentClientId = extractClientId(req);
    void webhookReceiver.handleRequest(req, res);
  });

  server.listen(PORT, () => {
    logger.info("caas-lite: webhook receiver listening", { port: PORT });
    logger.info("caas-lite: trust badge       -> http://localhost:" + PORT + "/api/v1/badge/:clientId");
    logger.info("caas-lite: dashboard         -> http://localhost:" + PORT + "/dashboard");
  });

  const shutdown = () => {
    logger.info("caas-lite: shutting down");
    policyEngine.stopWatch();
    server.close(() => { evidenceDb.close(); process.exit(0); });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e: unknown) => {
  logger.error("caas-lite: fatal startup error", { error: (e as Error).message });
  process.exit(1);
});