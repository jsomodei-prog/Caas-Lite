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
      const req = client.request({
        hostname: url.hostname, port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search, method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": payload.length, "X-Source": "caas-lite" }
      }, (res) => { res.resume(); logger.info("caas-lite: alert forwarded", { status: res.statusCode }); resolve(); });
      req.on("error", reject); req.write(payload); req.end();
    });
  } catch (e) { logger.error("caas-lite: alert forward failed", { error: (e as Error).message }); }
}

interface MiniAuditRequest { agent_id: string; prospect_id: string; profile: Record<string, unknown>; }
interface ComplianceGap { control: string; description: string; severity: "critical" | "high" | "medium"; }
interface MiniAuditReport { prospect_id: string; agent_id: string; readiness_score: number; gaps: ComplianceGap[]; summary: string; generated_at: string; }

function runMiniAudit(req: MiniAuditRequest): MiniAuditReport {
  const p = req.profile;
  const gaps: ComplianceGap[] = [];
  if (!p["mfa_enabled"]) gaps.push({ control: "CC6.1", description: "Multi-factor authentication is not enforced.", severity: "critical" });
  if (!p["access_reviews_quarterly"]) gaps.push({ control: "CC6.2", description: "Quarterly access reviews are not in place.", severity: "high" });
  if (!p["least_privilege_policy"]) gaps.push({ control: "CC6.3", description: "No documented least-privilege access policy found.", severity: "high" });
  if (!p["change_approval_process"]) gaps.push({ control: "CC7.2", description: "No formal change approval process is documented.", severity: "medium" });
  if (!p["vendor_risk_assessments"]) gaps.push({ control: "CC9.1", description: "Third-party vendor risk assessments are not conducted.", severity: "medium" });
  if (!p["incident_response_plan"]) gaps.push({ control: "CC2.1", description: "No documented incident response plan exists.", severity: "critical" });
  const deductions = gaps.reduce((sum, g) => sum + (g.severity === "critical" ? 20 : g.severity === "high" ? 12 : 7), 0);
  const readiness_score = Math.max(0, 100 - deductions);
  return {
    prospect_id: req.prospect_id, agent_id: req.agent_id, readiness_score, gaps,
    summary: gaps.length === 0 ? "No critical gaps detected." : gaps.length + " gap(s) identified. " + gaps.filter(g => g.severity === "critical").length + " critical control(s) require immediate remediation.",
    generated_at: new Date().toISOString()
  };
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
      await evidenceDb.incrementMeter(clientId, "runs");
      logger.info("caas-lite: meter incremented", { clientId, eventId: batch.event.id });
      await evidenceDb.append(batch);
      if (batch.overallOutcome === "fail" && batch.alerts.length > 0) {
        for (const alert of batch.alerts) {
          logger.warn("[ALERT] Policy Violation Detected for Batch " + batch.event.id, { policyId: alert.policyId, controlId: alert.controlId, severity: alert.severity, message: alert.message });
        }
        void forwardAlert(batch);
      }
      logger.info("caas-lite: batch appended to evidence vault", { eventId: batch.event.id, outcome: batch.overallOutcome, alerts: batch.alerts.length });
    },
  });

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/evidence") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      try {
        const rows = evidenceDb.getHistory(50);
        const parsed = rows.map((r) => ({ id: r.id, timestamp: r.timestamp, batch: JSON.parse(r.batchData) }));
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(parsed));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
      return;
    }
    if (req.method === "GET" && req.url === "/api/meters") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      try {
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(evidenceDb.getAllMeters()));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: (e as Error).message })); }
      return;
    }
    if (req.method === "GET" && req.url === "/dashboard") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      const dashPath = path.resolve(process.cwd(), "public", "index.html");
      if (!fs.existsSync(dashPath)) { res.writeHead(404); res.end("Dashboard not found."); return; }
      res.writeHead(200, { "Content-Type": "text/html" }); res.end(fs.readFileSync(dashPath)); return;
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
          logger.info("caas-lite: mini audit completed", { agent_id: report.agent_id, prospect_id: report.prospect_id, readiness_score: report.readiness_score, gaps: report.gaps.length });
          res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(report));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: (e as Error).message })); }
      })();
      return;
    }
    if (req.method === "POST" && req.url === "/api/agents/payouts") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      void (async () => {
        try {
          const body = JSON.parse(await readBody(req)) as { client_id?: string; agent_id?: string; subscription_amount?: number; momo_number?: string; };
          if (typeof body.client_id !== "string" || !body.client_id.trim()) { res.writeHead(422); res.end(JSON.stringify({ error: "client_id is required" })); return; }
          if (typeof body.subscription_amount !== "number" || body.subscription_amount <= 0) { res.writeHead(422); res.end(JSON.stringify({ error: "subscription_amount must be a positive number" })); return; }
          const clientId = body.client_id.trim();
          let agentId = typeof body.agent_id === "string" && body.agent_id.trim().length > 0 ? body.agent_id.trim() : evidenceDb.getAttribution(clientId);
          if (!agentId) { res.writeHead(404); res.end(JSON.stringify({ error: "No agent attribution found for this client" })); return; }
          evidenceDb.upsertAgent(agentId, body.momo_number);
          evidenceDb.attributeClient(clientId, agentId);
          const commission = parseFloat((body.subscription_amount * AGENT_COMMISSION_RATE).toFixed(2));
          const success = evidenceDb.addPayout(agentId, commission);
          if (!success) { res.writeHead(404); res.end(JSON.stringify({ error: "Agent not found" })); return; }
          const agent = evidenceDb.getAgent(agentId);
          logger.info("caas-lite: agent payout recorded", { agentId, clientId, commission, new_total: agent?.total_payouts });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "payout_recorded", agent_id: agentId, client_id: clientId, subscription_amount: body.subscription_amount, commission_rate: AGENT_COMMISSION_RATE, commission_earned: commission, total_payouts: agent?.total_payouts ?? commission, momo_number: agent?.momo_number ?? null, note: "Balance ready for Paystack/Stripe/MoMo disbursement" }));
        } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: (e as Error).message })); }
      })();
      return;
    }
    currentClientId = extractClientId(req);
    void webhookReceiver.handleRequest(req, res);
  });

  server.listen(PORT, () => {
    logger.info("caas-lite: webhook receiver listening", { port: PORT });
    logger.info("caas-lite: mini audit    -> http://localhost:" + PORT + "/api/audit/mini");
    logger.info("caas-lite: agent payouts -> http://localhost:" + PORT + "/api/agents/payouts");
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