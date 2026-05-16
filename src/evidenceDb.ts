import Database from "better-sqlite3";
import * as crypto from "crypto";

export interface EvidenceRow { id: number; timestamp: string; batchData: string; }
export interface BillingMeterRow { client_id: string; verification_runs: number; active_monitors: number; }
export interface AgentRow { agent_id: string; total_payouts: number; momo_number: string | null; }
export interface AttributionRow { client_id: string; agent_id: string; created_at: string; }
export interface LedgerEntry { evidence_id: number; timestamp: string; client_id: string; event_id: string; event_type: string; overall_outcome: string; alert_count: number; }
export interface SignedLedger { payload: { client_id: string; exported_at: string; record_count: number; entries: LedgerEntry[] }; checksum: string; }
export interface AiBomComponent { id: number; client_id: string; component_name: string; vendor: string; version: string; risk_tier: string; created_at: string; }
export type MeterMetric = "runs" | "monitors";

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
    this.db.exec(`CREATE TABLE IF NOT EXISTS billing_meters (client_id TEXT PRIMARY KEY, verification_runs INTEGER NOT NULL DEFAULT 0, active_monitors INTEGER NOT NULL DEFAULT 1)`);
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

  getHistory(limit: number = 50): EvidenceRow[] {
    return this.db.prepare(`SELECT id, timestamp, batchData FROM evidence ORDER BY id DESC LIMIT ?`).all(limit) as EvidenceRow[];
  }

  async incrementMeter(clientId: string, metric: MeterMetric): Promise<void> { this.upsertStmts[metric].run(clientId); }

  getMeter(clientId: string): BillingMeterRow | null {
    return (this.db.prepare(`SELECT * FROM billing_meters WHERE client_id = ?`).get(clientId) as BillingMeterRow | undefined) ?? null;
  }

  getAllMeters(): BillingMeterRow[] {
    return this.db.prepare(`SELECT * FROM billing_meters ORDER BY verification_runs DESC`).all() as BillingMeterRow[];
  }

  upsertAgent(agentId: string, momoNumber?: string): void { this.upsertAgentStmt.run(agentId, momoNumber ?? null); }

  attributeClient(clientId: string, agentId: string): void { this.upsertAttributionStmt.run(clientId, agentId, new Date().toISOString()); }

  getAttribution(clientId: string): string | null {
    const row = this.db.prepare(`SELECT agent_id FROM client_attribution WHERE client_id = ?`).get(clientId) as { agent_id: string } | undefined;
    return row?.agent_id ?? null;
  }

  addPayout(agentId: string, amount: number): boolean { return this.addPayoutStmt.run(amount, agentId).changes > 0; }

  getAgent(agentId: string): AgentRow | null {
    return (this.db.prepare(`SELECT * FROM agents WHERE agent_id = ?`).get(agentId) as AgentRow | undefined) ?? null;
  }

  getAllAgents(): AgentRow[] {
    return this.db.prepare(`SELECT * FROM agents ORDER BY total_payouts DESC`).all() as AgentRow[];
  }

  async exportSignedLedger(clientId: string): Promise<SignedLedger> {
    const rows = this.db.prepare(`SELECT id, timestamp, batchData FROM evidence WHERE json_extract(batchData, '$.event.actor.id') IS NOT NULL OR json_extract(batchData, '$.event.id') IS NOT NULL ORDER BY id ASC`).all() as EvidenceRow[];
    const meter = this.getMeter(clientId);
    const allParsed = rows.map((row) => { try { return { row, batch: JSON.parse(row.batchData) as Record<string, unknown> }; } catch { return null; } }).filter((x): x is { row: EvidenceRow; batch: Record<string, unknown> } => x !== null);
    const attributed = meter !== null ? allParsed : [];
    const entries: LedgerEntry[] = attributed.map(({ row, batch }) => {
      const event = batch["event"] as Record<string, unknown> | undefined;
      const alerts = batch["alerts"] as unknown[] | undefined;
      return { evidence_id: row.id, timestamp: row.timestamp, client_id: clientId, event_id: (event?.["id"] as string | undefined) ?? "unknown", event_type: (event?.["type"] as string | undefined) ?? "unknown", overall_outcome: (batch["overallOutcome"] as string | undefined) ?? "unknown", alert_count: alerts?.length ?? 0 };
    });
    const payload = { client_id: clientId, exported_at: new Date().toISOString(), record_count: entries.length, entries };
    const checksum = crypto.createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
    return { payload, checksum };
  }

  async registerComponent(component: { clientId: string; name: string; vendor: string; version: string; riskTier: string }): Promise<void> {
    this.insertComponentStmt.run(component.clientId, component.name, component.vendor, component.version, component.riskTier);
  }

  async getComponentsByClient(clientId: string): Promise<AiBomComponent[]> {
    return this.db.prepare(`SELECT id, client_id, component_name, vendor, version, risk_tier, created_at FROM aibom_components WHERE client_id = ? ORDER BY id DESC`).all(clientId) as AiBomComponent[];
  }

  close(): void { this.db.close(); }
}