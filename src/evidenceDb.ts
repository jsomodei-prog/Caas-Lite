import Database from "better-sqlite3";

export interface EvidenceRow {
  id:        number;
  timestamp: string;
  batchData: string;
}

export interface BillingMeterRow {
  client_id:         string;
  verification_runs: number;
  active_monitors:   number;
}

export interface AgentRow {
  agent_id:      string;
  total_payouts: number;
  momo_number:   string | null;
}

export interface AttributionRow {
  client_id:  string;
  agent_id:   string;
  created_at: string;
}

export type MeterMetric = "runs" | "monitors";

export class EvidenceDb {
  private db: Database.Database;
  private insertStmt:            Database.Statement;
  private upsertStmts:           Record<MeterMetric, Database.Statement>;
  private upsertAgentStmt:       Database.Statement;
  private upsertAttributionStmt: Database.Statement;
  private addPayoutStmt:         Database.Statement;

  constructor(filePath: string = "caas_evidence.db") {
    this.db = new Database(filePath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT    NOT NULL,
        batchData TEXT    NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_meters (
        client_id         TEXT    PRIMARY KEY,
        verification_runs INTEGER NOT NULL DEFAULT 0,
        active_monitors   INTEGER NOT NULL DEFAULT 1
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        agent_id      TEXT PRIMARY KEY,
        total_payouts REAL NOT NULL DEFAULT 0.0,
        momo_number   TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS client_attribution (
        client_id  TEXT PRIMARY KEY,
        agent_id   TEXT NOT NULL REFERENCES agents(agent_id),
        created_at TEXT NOT NULL
      )
    `);

    this.insertStmt = this.db.prepare(
      `INSERT INTO evidence (timestamp, batchData) VALUES (?, ?)`
    );

    this.upsertStmts = {
      runs: this.db.prepare(`
        INSERT INTO billing_meters (client_id, verification_runs, active_monitors)
          VALUES (?, 1, 1)
        ON CONFLICT(client_id) DO UPDATE
          SET verification_runs = verification_runs + 1
      `),
      monitors: this.db.prepare(`
        INSERT INTO billing_meters (client_id, verification_runs, active_monitors)
          VALUES (?, 0, 1)
        ON CONFLICT(client_id) DO UPDATE
          SET active_monitors = active_monitors + 1
      `),
    };

    this.upsertAgentStmt = this.db.prepare(`
      INSERT INTO agents (agent_id, total_payouts, momo_number)
        VALUES (?, 0.0, ?)
      ON CONFLICT(agent_id) DO UPDATE
        SET momo_number = COALESCE(excluded.momo_number, agents.momo_number)
    `);

    this.upsertAttributionStmt = this.db.prepare(`
      INSERT OR IGNORE INTO client_attribution (client_id, agent_id, created_at)
        VALUES (?, ?, ?)
    `);

    this.addPayoutStmt = this.db.prepare(`
      UPDATE agents SET total_payouts = total_payouts + ? WHERE agent_id = ?
    `);
  }

  async append(batch: unknown): Promise<void> {
    this.insertStmt.run(new Date().toISOString(), JSON.stringify(batch));
  }

  getHistory(limit: number = 50): EvidenceRow[] {
    return this.db
      .prepare(`SELECT id, timestamp, batchData FROM evidence ORDER BY id DESC LIMIT ?`)
      .all(limit) as EvidenceRow[];
  }

  async incrementMeter(clientId: string, metric: MeterMetric): Promise<void> {
    this.upsertStmts[metric].run(clientId);
  }

  getMeter(clientId: string): BillingMeterRow | null {
    return (this.db.prepare(`SELECT * FROM billing_meters WHERE client_id = ?`).get(clientId) as BillingMeterRow | undefined) ?? null;
  }

  getAllMeters(): BillingMeterRow[] {
    return this.db.prepare(`SELECT * FROM billing_meters ORDER BY verification_runs DESC`).all() as BillingMeterRow[];
  }

  upsertAgent(agentId: string, momoNumber?: string): void {
    this.upsertAgentStmt.run(agentId, momoNumber ?? null);
  }

  attributeClient(clientId: string, agentId: string): void {
    this.upsertAttributionStmt.run(clientId, agentId, new Date().toISOString());
  }

  getAttribution(clientId: string): string | null {
    const row = this.db.prepare(`SELECT agent_id FROM client_attribution WHERE client_id = ?`).get(clientId) as { agent_id: string } | undefined;
    return row?.agent_id ?? null;
  }

  addPayout(agentId: string, amount: number): boolean {
    return this.addPayoutStmt.run(amount, agentId).changes > 0;
  }

  getAgent(agentId: string): AgentRow | null {
    return (this.db.prepare(`SELECT * FROM agents WHERE agent_id = ?`).get(agentId) as AgentRow | undefined) ?? null;
  }

  getAllAgents(): AgentRow[] {
    return this.db.prepare(`SELECT * FROM agents ORDER BY total_payouts DESC`).all() as AgentRow[];
  }

  close(): void {
    this.db.close();
  }
}