import Database from "better-sqlite3";

export interface EvidenceRow {
  id: number;
  timestamp: string;
  batchData: string;
}

export interface BillingMeterRow {
  client_id:          string;
  verification_runs:  number;
  active_monitors:    number;
}

/** Valid metering metrics for incrementMeter(). */
export type MeterMetric = "runs" | "monitors";

/** Maps MeterMetric values to their billing_meters column names. */
const METRIC_COLUMN: Record<MeterMetric, string> = {
  runs:     "verification_runs",
  monitors: "active_monitors",
};

export class EvidenceDb {
  private db:         Database.Database;
  private insertStmt: Database.Statement;
  private upsertStmts: Record<MeterMetric, Database.Statement>;

  constructor(filePath: string = "caas_evidence.db") {
    this.db = new Database(filePath);

    // ── evidence table ────────────────────────────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT    NOT NULL,
        batchData TEXT    NOT NULL
      )
    `);

    // ── billing_meters table (Phase 5.1) ──────────────────────────────────────
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS billing_meters (
        client_id         TEXT    PRIMARY KEY,
        verification_runs INTEGER NOT NULL DEFAULT 0,
        active_monitors   INTEGER NOT NULL DEFAULT 1
      )
    `);

    // Prepare evidence insert once — reused on every append()
    this.insertStmt = this.db.prepare(
      `INSERT INTO evidence (timestamp, batchData) VALUES (?, ?)`
    );

    // Prepare one upsert per metric — avoids re-compiling SQL on every call.
    // INSERT OR IGNORE seeds the row if missing; UPDATE increments atomically.
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
  }

  // ── Evidence vault ──────────────────────────────────────────────────────────

  async append(batch: unknown): Promise<void> {
    const timestamp = new Date().toISOString();
    const batchData = JSON.stringify(batch);
    this.insertStmt.run(timestamp, batchData);
  }

  getHistory(limit: number = 50): EvidenceRow[] {
    return this.db
      .prepare(
        `SELECT id, timestamp, batchData
         FROM evidence
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit) as EvidenceRow[];
  }

  // ── Billing meters (Phase 5.1) ──────────────────────────────────────────────

  /**
   * Atomically increments the specified metric for the given client.
   * Creates the client row with sensible defaults if it doesn't exist yet.
   *
   * @param clientId - Caller-supplied client identifier (e.g. from X-Client-Id header)
   * @param metric   - "runs" increments verification_runs; "monitors" increments active_monitors
   */
  async incrementMeter(clientId: string, metric: MeterMetric): Promise<void> {
    this.upsertStmts[metric].run(clientId);
  }

  /**
   * Returns the current meter totals for a given client.
   * Returns null if the client has no recorded activity yet.
   */
  getMeter(clientId: string): BillingMeterRow | null {
    return (
      this.db
        .prepare(`SELECT * FROM billing_meters WHERE client_id = ?`)
        .get(clientId) as BillingMeterRow | undefined
    ) ?? null;
  }

  /**
   * Returns meter totals for all clients — useful for a billing dashboard.
   */
  getAllMeters(): BillingMeterRow[] {
    return this.db
      .prepare(`SELECT * FROM billing_meters ORDER BY verification_runs DESC`)
      .all() as BillingMeterRow[];
  }

  close(): void {
    this.db.close();
  }
}
