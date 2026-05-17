import Database from "better-sqlite3";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

export interface EvidenceRow { id: number; timestamp: string; batchData: string; }
export interface BillingMeterRow { client_id: string; verification_runs: number; active_monitors: number; tenant_id: string; billing_tier: string; trial_start_timestamp: string; trial_status: string; }
export interface AgentRow { agent_id: string; total_payouts: number; momo_number: string | null; }
export interface AttributionRow { client_id: string; agent_id: string; created_at: string; }
export interface LedgerEntry { evidence_id: number; timestamp: string; client_id: string; event_id: string; event_type: string; overall_outcome: string; alert_count: number; }
export interface SignedLedger { payload: { client_id: string; exported_at: string; record_count: number; entries: LedgerEntry[] }; checksum: string; }
export interface AiBomComponent { id: number; client_id: string; component_name: string; vendor: string; version: string; risk_tier: string; created_at: string; }
export interface ReportResult { success: boolean; reportPath: string; sha256Checksum: string; tenantId: string; generatedAt: string; }
export type MeterMetric = "runs" | "monitors";
export type BillingTier = "PAY_AS_YOU_GO" | "GROWTH" | "ENTERPRISE";
export type TrialStatus = "ACTIVE" | "EXPIRED_CONVERTED" | "EXPIRED_LOCKED";

const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export class EvidenceDb {
  private db: Database.Database;
  private insertStmt: Database.Statement;
  private upsertStmts: Record<MeterMetric, Database.Statement>;
  private upsertAgentStmt: Database.Statement;
  private upsertAttributionStmt: Database.Statement;
  private addPayoutStmt: Database.Statement;
  private insertComponentStmt: Database.Statement;

  constructor(filePath: string = process.env["NODE_ENV"] === "production" ? "/data/caas_evidence.db" : "caas_evidence.db") {
    this.db = new Database(filePath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, batchData TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS billing_meters (client_id TEXT PRIMARY KEY, verification_runs INTEGER NOT NULL DEFAULT 0, active_monitors INTEGER NOT NULL DEFAULT 1, tenant_id TEXT NOT NULL DEFAULT 'default_tenant', billing_tier TEXT DEFAULT 'PAY_AS_YOU_GO', trial_start_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, trial_status TEXT DEFAULT 'ACTIVE')`);
    const cols = [`ALTER TABLE billing_meters ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default_tenant'`,`ALTER TABLE billing_meters ADD COLUMN billing_tier TEXT DEFAULT 'PAY_AS_YOU_GO'`,`ALTER TABLE billing_meters ADD COLUMN trial_start_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP`,`ALTER TABLE billing_meters ADD COLUMN trial_status TEXT DEFAULT 'ACTIVE'`];
    for (const sql of cols) { try { this.db.exec(sql); } catch { } }
    this.db.exec(`CREATE TABLE IF NOT EXISTS agents (agent_id TEXT PRIMARY KEY, total_payouts REAL NOT NULL DEFAULT 0.0, momo_number TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS client_attribution (client_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(agent_id), created_at TEXT NOT NULL)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS aibom_components (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id TEXT NOT NULL, component_name TEXT NOT NULL, vendor TEXT NOT NULL, version TEXT NOT NULL, risk_tier TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    this.insertStmt = this.db.prepare(`INSERT INTO evidence (timestamp, batchData) VALUES (?, ?)`);
    this.upsertStmts = {
      runs: this.db.prepare(`INSERT INTO billing_meters (client_id, verification_runs, active_monitors) VALUES (?, 1, 1) ON CONFLICT(client_id) DO UPDATE SET verification_runs = verification_runs + 1`),
      monitors: this.db.prepare(`INSERT INTO billing_meters (client_id, verification_runs, active_monitors) VALUES (?, 0, 1) ON CONFLICT(client_id) DO UPDATE SET active_monitors = active_monitors + 1`),
    };
    this.upsertAgentStmt = this.db.prepare(`INSERT INTO agents (agent_id, total_payouts, momo_number) VALUES (?, 0.0, ?) ON CONFLICT(agent_id) DO UPDATE SET momo_number = COALESCE(excluded.momo_number, agents.momo_number)`);
    this.upsertAttributionStmt = this.db.prepare(`INSERT OR IGNORE INTO client_attribution (client_id, agent_id, created_at) VALUES (?, ?, ?)`);
    this.addPayoutStmt = this.db.prepare(`UPDATE agents SET total_payouts = total_payouts + ? WHERE agent_id = ?`);
    this.insertComponentStmt = this.db.prepare(`INSERT INTO aibom_components (client_id, component_name, vendor, version, risk_tier) VALUES (?, ?, ?, ?, ?)`);
  }

  async append(batch: unknown): Promise<void> { this.insertStmt.run(new Date().toISOString(), JSON.stringify(batch)); }
  getHistory(limit: number = 50): EvidenceRow[] { return this.db.prepare(`SELECT id, timestamp, batchData FROM evidence ORDER BY id DESC LIMIT ?`).all(limit) as EvidenceRow[]; }
  async incrementMeter(clientId: string, metric: MeterMetric): Promise<void> { this.upsertStmts[metric].run(clientId); }
  getMeter(clientId: string): BillingMeterRow | null { return (this.db.prepare(`SELECT * FROM billing_meters WHERE client_id = ?`).get(clientId) as BillingMeterRow | undefined) ?? null; }
  getMeterByTenant(tenantId: string): BillingMeterRow[] { return this.db.prepare(`SELECT * FROM billing_meters WHERE tenant_id = ? ORDER BY verification_runs DESC`).all(tenantId) as BillingMeterRow[]; }
  getAllMeters(): BillingMeterRow[] { return this.db.prepare(`SELECT * FROM billing_meters ORDER BY verification_runs DESC`).all() as BillingMeterRow[]; }

  evaluateTrialStatus(tenantId: string, nowMs: number = Date.now()): TrialStatus {
    const rows = this.getMeterByTenant(tenantId);
    if (!rows.length) return "ACTIVE";
    const row = rows[0]!;
    if (row.trial_status !== "ACTIVE") return row.trial_status as TrialStatus;
    const expired = nowMs > new Date(row.trial_start_timestamp).getTime() + TRIAL_DURATION_MS;
    if (expired) { this.db.prepare(`UPDATE billing_meters SET trial_status = 'EXPIRED_LOCKED' WHERE tenant_id = ?`).run(tenantId); return "EXPIRED_LOCKED"; }
    return "ACTIVE";
  }

  upsertAgent(agentId: string, momoNumber?: string): void { this.upsertAgentStmt.run(agentId, momoNumber ?? null); }
  attributeClient(clientId: string, agentId: string): void { this.upsertAttributionStmt.run(clientId, agentId, new Date().toISOString()); }
  getAttribution(clientId: string): string | null { const row = this.db.prepare(`SELECT agent_id FROM client_attribution WHERE client_id = ?`).get(clientId) as { agent_id: string } | undefined; return row?.agent_id ?? null; }
  addPayout(agentId: string, amount: number): boolean { return this.addPayoutStmt.run(amount, agentId).changes > 0; }
  getAgent(agentId: string): AgentRow | null { return (this.db.prepare(`SELECT * FROM agents WHERE agent_id = ?`).get(agentId) as AgentRow | undefined) ?? null; }
  getAllAgents(): AgentRow[] { return this.db.prepare(`SELECT * FROM agents ORDER BY total_payouts DESC`).all() as AgentRow[]; }

  async exportSignedLedger(clientId: string): Promise<SignedLedger> {
    const rows = this.db.prepare(`SELECT id, timestamp, batchData FROM evidence WHERE json_extract(batchData, '$.event.actor.id') IS NOT NULL OR json_extract(batchData, '$.event.id') IS NOT NULL ORDER BY id ASC`).all() as EvidenceRow[];
    const meter = this.getMeter(clientId);
    const allParsed = rows.map(row => { try { return { row, batch: JSON.parse(row.batchData) as Record<string, unknown> }; } catch { return null; } }).filter((x): x is { row: EvidenceRow; batch: Record<string, unknown> } => x !== null);
    const attributed = meter !== null ? allParsed : [];
    const entries: LedgerEntry[] = attributed.map(({ row, batch }) => { const event = batch["event"] as Record<string, unknown> | undefined; const alerts = batch["alerts"] as unknown[] | undefined; return { evidence_id: row.id, timestamp: row.timestamp, client_id: clientId, event_id: (event?.["id"] as string | undefined) ?? "unknown", event_type: (event?.["type"] as string | undefined) ?? "unknown", overall_outcome: (batch["overallOutcome"] as string | undefined) ?? "unknown", alert_count: alerts?.length ?? 0 }; });
    const payload = { client_id: clientId, exported_at: new Date().toISOString(), record_count: entries.length, entries };
    const checksum = crypto.createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
    return { payload, checksum };
  }

  async registerComponent(component: { clientId: string; name: string; vendor: string; version: string; riskTier: string }): Promise<void> { this.insertComponentStmt.run(component.clientId, component.name, component.vendor, component.version, component.riskTier); }
  async getComponentsByClient(clientId: string): Promise<AiBomComponent[]> { return this.db.prepare(`SELECT id, client_id, component_name, vendor, version, risk_tier, created_at FROM aibom_components WHERE client_id = ? ORDER BY id DESC`).all(clientId) as AiBomComponent[]; }
  getComponentsByTenant(tenantId: string, startDate?: string, endDate?: string): AiBomComponent[] {
    let sql = `SELECT a.* FROM aibom_components a INNER JOIN billing_meters b ON a.client_id = b.client_id WHERE b.tenant_id = ?`;
    const params: string[] = [tenantId];
    if (startDate) { sql += ` AND a.created_at >= ?`; params.push(startDate); }
    if (endDate)   { sql += ` AND a.created_at <= ?`; params.push(endDate); }
    sql += ` ORDER BY a.created_at DESC`;
    return this.db.prepare(sql).all(...params) as AiBomComponent[];
  }
  getBillingRunsByTenant(tenantId: string): BillingMeterRow[] { return this.getMeterByTenant(tenantId); }

  async buildReport(opts: { tenantId: string; includeAibom: boolean; includeBillingRuns: boolean; dateRange: { start: string; end: string } }): Promise<ReportResult> {
    const { tenantId, includeAibom, includeBillingRuns, dateRange } = opts;
    const lines: string[] = [];
    const now = new Date().toISOString();
    lines.push(`# CaaS Lite Compliance Audit Report`);
    lines.push(`Tenant:      ${tenantId}`);
    lines.push(`Generated:   ${now}`);
    lines.push(`Date Range:  ${dateRange.start} to ${dateRange.end}`);
    lines.push(`${"─".repeat(60)}`);
    if (includeBillingRuns) {
      const meters = this.getBillingRunsByTenant(tenantId);
      lines.push(`\n## Billing Meters (${meters.length} client(s))\n`);
      meters.forEach(m => { lines.push(`  Client: ${m.client_id}  Tier: ${m.billing_tier ?? "PAY_AS_YOU_GO"}  Runs: ${m.verification_runs}  Trial: ${m.trial_status}`); });
    }
    if (includeAibom) {
      const components = this.getComponentsByTenant(tenantId, dateRange.start, dateRange.end);
      lines.push(`\n## AI Bill of Materials (${components.length} component(s))\n`);
      components.forEach(c => { lines.push(`  ${c.component_name} v${c.version} | ${c.vendor} | ${c.risk_tier}`); });
    }
    const plaintext = lines.join("\n");
    const sha256Checksum = crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
    const reportsDir = process.env["NODE_ENV"] === "production" ? "/data/reports" : "./reports";
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    const reportPath = path.join(reportsDir, `${tenantId}_${Date.now()}.report`);
    fs.writeFileSync(reportPath, plaintext, "utf8");
    return { success: true, reportPath, sha256Checksum, tenantId, generatedAt: now };
  }

  close(): void { this.db.close(); }
}