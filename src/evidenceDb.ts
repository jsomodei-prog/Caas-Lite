import Database from "better-sqlite3";

export interface EvidenceRow {
  id: number;
  timestamp: string;
  batchData: string;
}

export class EvidenceDb {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor(filePath: string = "caas_evidence.db") {
    this.db = new Database(filePath);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS evidence (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT    NOT NULL,
        batchData TEXT    NOT NULL
      )
    `);

    this.insertStmt = this.db.prepare(
      `INSERT INTO evidence (timestamp, batchData) VALUES (?, ?)`
    );
  }

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

  close(): void {
    this.db.close();
  }
}
