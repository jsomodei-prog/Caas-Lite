/**
 * src/services/queue.ts
 * Asynchronous processing queue with a concurrency-limited worker pool.
 *
 * Offloads high-volume payout clearings and batch operations from the Express
 * request thread so the API stays responsive under heavy sweep loads.
 *
 * Architecture:
 *   - Single in-process async queue (no external dependencies like Redis/Bull)
 *   - Configurable worker concurrency (default: 4 parallel jobs)
 *   - Priority levels: critical > high > normal > low
 *   - Automatic retry with exponential backoff (max 3 attempts)
 *   - Dead-letter queue (DLQ) for permanently failed jobs
 *   - Job lifecycle events emitted for Prometheus metric hooks
 *   - All job state persisted to SQLite for crash recovery on restart
 *
 * Phase 11 build-out | Commit baseline: a4f5db6
 */

import crypto from "crypto";
import { EventEmitter } from "events";
import type { Database as DB } from "better-sqlite3";

// ─── Types ────────────────────────────────────────────────────────────────────

export type JobPriority = "critical" | "high" | "normal" | "low";
export type JobStatus   = "queued" | "processing" | "completed" | "failed" | "dead";

export type JobType =
  | "payout_sweep"
  | "payout_single"
  | "wht_receipt_generate"
  | "bulk_statement_generate"
  | "anomaly_scan"
  | "fx_rate_refresh"
  | "regulatory_report"
  | "notification_dispatch"
  | "analyze_db";

export interface JobDefinition<TPayload = unknown> {
  type: JobType;
  payload: TPayload;
  priority?: JobPriority;
  /** Maximum attempts before the job goes to the dead-letter queue. */
  maxAttempts?: number;
  /** Optional deduplication key — if a job with the same key is already queued, skip. */
  idempotencyKey?: string;
}

export interface Job<TPayload = unknown> {
  id: string;
  type: JobType;
  payload: TPayload;
  priority: JobPriority;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  idempotencyKey: string | null;
  result: unknown | null;
  error: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  next_attempt_at: string | null;
}

export type JobHandler<TPayload = unknown> = (
  job: Job<TPayload>,
  db: DB
) => Promise<unknown>;

export interface QueueStats {
  queued:     number;
  processing: number;
  completed:  number;
  failed:     number;
  dead:       number;
  total:      number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

const PRIORITY_ORDER: Record<JobPriority, number> = {
  critical: 0, high: 1, normal: 2, low: 3,
};

const DEFAULT_CONCURRENCY = parseInt(process.env.QUEUE_CONCURRENCY ?? "4", 10);
const DEFAULT_MAX_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS  = 2_000;

// ─── DB Bootstrap ─────────────────────────────────────────────────────────────

export function ensureJobTable(db: DB): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS job_queue (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      priority        TEXT NOT NULL DEFAULT 'normal',
      status          TEXT NOT NULL DEFAULT 'queued',
      attempts        INTEGER NOT NULL DEFAULT 0,
      max_attempts    INTEGER NOT NULL DEFAULT 3,
      idempotency_key TEXT UNIQUE,
      result_json     TEXT,
      error           TEXT,
      queued_at       TEXT NOT NULL,
      started_at      TEXT,
      completed_at    TEXT,
      next_attempt_at TEXT
    )
  `).run();

  db.prepare(`CREATE INDEX IF NOT EXISTS idx_job_queue_status_priority
    ON job_queue (status, priority, next_attempt_at)`).run();

  db.prepare(`CREATE INDEX IF NOT EXISTS idx_job_queue_type
    ON job_queue (type, status)`).run();
}

// ─── Queue Class ──────────────────────────────────────────────────────────────

export class ProcessingQueue extends EventEmitter {
  private readonly handlers   = new Map<JobType, JobHandler>();
  private readonly concurrency: number;
  private activeCount  = 0;
  private running      = false;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: DB,
    options: { concurrency?: number } = {}
  ) {
    super();
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    ensureJobTable(db);
    // Recover any jobs that were "processing" when the server last crashed.
    this.db.prepare(
      `UPDATE job_queue SET status = 'queued', started_at = NULL
       WHERE status = 'processing'`
    ).run();
  }

  // ── Handler Registration ──────────────────────────────────────────────────

  /** Register a handler for a job type. */
  register<TPayload>(type: JobType, handler: JobHandler<TPayload>): void {
    this.handlers.set(type, handler as JobHandler);
  }

  // ── Job Submission ─────────────────────────────────────────────────────────

  /**
   * Enqueues a job. Returns the job ID.
   * If idempotencyKey is set and a queued/processing job with the same key
   * already exists, returns that job's ID without creating a duplicate.
   */
  enqueue<TPayload>(def: JobDefinition<TPayload>): string {
    const priority    = def.priority    ?? "normal";
    const maxAttempts = def.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const ikey        = def.idempotencyKey ?? null;

    // Idempotency check
    if (ikey) {
      const existing = this.db
        .prepare("SELECT id FROM job_queue WHERE idempotency_key = ? AND status IN ('queued','processing')")
        .get(ikey) as { id: string } | undefined;
      if (existing) return existing.id;
    }

    const id = crypto.randomUUID();
    this.db.prepare(`
      INSERT INTO job_queue
        (id, type, payload_json, priority, status, attempts, max_attempts,
         idempotency_key, queued_at)
      VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?)
    `).run(
      id, def.type, JSON.stringify(def.payload),
      priority, maxAttempts, ikey, new Date().toISOString()
    );

    this.emit("enqueued", { id, type: def.type, priority });
    this.tick();
    return id;
  }

  // ── Worker Loop ───────────────────────────────────────────────────────────

  /** Starts the queue processor. Call once during app startup. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.tickInterval = setInterval(() => this.tick(), 500);
    console.info(`[queue] Started — concurrency: ${this.concurrency}`);
  }

  /** Stops the queue processor gracefully. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    // Wait for active jobs to complete (max 15 s).
    const deadline = Date.now() + 15_000;
    while (this.activeCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    console.info("[queue] Stopped.");
  }

  private tick(): void {
    if (!this.running) return;

    while (this.activeCount < this.concurrency) {
      const job = this.dequeueNext();
      if (!job) break;
      this.activeCount++;
      this.processJob(job).finally(() => {
        this.activeCount--;
        this.tick();
      });
    }
  }

  private dequeueNext(): Job | null {
    const now = new Date().toISOString();
    const row = this.db.prepare(`
      SELECT * FROM job_queue
      WHERE status = 'queued'
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END ASC,
        queued_at ASC
      LIMIT 1
    `).get(now) as (Omit<Job, "payload"> & { payload_json: string }) | undefined;

    if (!row) return null;

    this.db.prepare(
      `UPDATE job_queue SET status = 'processing', started_at = ?, attempts = attempts + 1 WHERE id = ?`
    ).run(now, row.id);

    return {
      ...row,
      payload: JSON.parse(row.payload_json),
      result: null,
      error: null,
    } as unknown as Job;
  }

  private async processJob(job: Job): Promise<void> {
    const handler = this.handlers.get(job.type);
    this.emit("started", { id: job.id, type: job.type, attempt: job.attempts });

    if (!handler) {
      this.markFailed(job, `No handler registered for job type: ${job.type}`, true);
      return;
    }

    try {
      const result = await handler(job, this.db);
      this.markCompleted(job, result);
      this.emit("completed", { id: job.id, type: job.type, result });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const exhausted = job.attempts >= job.maxAttempts;
      this.markFailed(job, errMsg, exhausted);
      this.emit("failed", { id: job.id, type: job.type, error: errMsg, exhausted });
    }
  }

  private markCompleted(job: Job, result: unknown): void {
    this.db.prepare(
      `UPDATE job_queue SET status='completed', result_json=?, completed_at=?, error=NULL WHERE id=?`
    ).run(JSON.stringify(result), new Date().toISOString(), job.id);
  }

  private markFailed(job: Job, error: string, exhausted: boolean): void {
    if (exhausted) {
      this.db.prepare(
        `UPDATE job_queue SET status='dead', error=?, completed_at=? WHERE id=?`
      ).run(error, new Date().toISOString(), job.id);
      console.error(`[queue] Job ${job.id} (${job.type}) moved to DLQ after ${job.attempts} attempts: ${error}`);
    } else {
      const delayMs      = BASE_RETRY_DELAY_MS * Math.pow(2, job.attempts - 1);
      const nextAttempt  = new Date(Date.now() + delayMs).toISOString();
      this.db.prepare(
        `UPDATE job_queue SET status='queued', error=?, next_attempt_at=? WHERE id=?`
      ).run(error, nextAttempt, job.id);
      console.warn(`[queue] Job ${job.id} (${job.type}) failed (attempt ${job.attempts}). Retry at ${nextAttempt}: ${error}`);
    }
  }

  // ── Inspection ────────────────────────────────────────────────────────────

  getJob(id: string): Job | null {
    const row = this.db
      .prepare("SELECT * FROM job_queue WHERE id = ?")
      .get(id) as (Omit<Job,"payload"> & { payload_json: string; result_json: string | null }) | undefined;
    if (!row) return null;
    return { ...row, payload: JSON.parse(row.payload_json), result: row.result_json ? JSON.parse(row.result_json) : null } as unknown as Job;
  }

  getStats(): QueueStats {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) as cnt FROM job_queue GROUP BY status")
      .all() as { status: string; cnt: number }[];
    const map = Object.fromEntries(rows.map(r => [r.status, r.cnt]));
    return {
      queued:     map.queued     ?? 0,
      processing: map.processing ?? 0,
      completed:  map.completed  ?? 0,
      failed:     map.failed     ?? 0,
      dead:       map.dead       ?? 0,
      total:      rows.reduce((s, r) => s + r.cnt, 0),
    };
  }

  getDeadLetterQueue(limit = 50): Job[] {
    return this.db
      .prepare("SELECT * FROM job_queue WHERE status = 'dead' ORDER BY completed_at DESC LIMIT ?")
      .all(limit)
      .map((r: unknown) => {
        const row = r as Omit<Job,"payload"> & { payload_json: string; result_json: string | null };
        return { ...row, payload: JSON.parse(row.payload_json), result: row.result_json ? JSON.parse(row.result_json) : null } as unknown as Job;
      });
  }

  /**
   * Retries a dead-letter job by resetting it to queued.
   */
  retryDead(jobId: string): boolean {
    const result = this.db.prepare(
      `UPDATE job_queue SET status='queued', error=NULL, attempts=0, next_attempt_at=NULL WHERE id=? AND status='dead'`
    ).run(jobId);
    if (result.changes > 0) { this.tick(); return true; }
    return false;
  }

  /**
   * Purges completed and dead jobs older than retentionDays.
   */
  purge(retentionDays = 7): number {
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const result = this.db.prepare(
      `DELETE FROM job_queue WHERE status IN ('completed','dead') AND completed_at < ?`
    ).run(cutoff);
    return result.changes;
  }
}

// ─── Singleton Factory ────────────────────────────────────────────────────────

let _queue: ProcessingQueue | null = null;

/**
 * Returns (or creates) the singleton ProcessingQueue bound to the given DB.
 * Call from app.ts after the DB is open.
 */
export function getQueue(db?: DB): ProcessingQueue {
  if (!_queue) {
    if (!db) throw new Error("ProcessingQueue not initialised — pass db on first call");
    _queue = new ProcessingQueue(db, { concurrency: DEFAULT_CONCURRENCY });
    registerBuiltInHandlers(_queue);
  }
  return _queue;
}

// ─── Built-in Job Handlers ────────────────────────────────────────────────────

function registerBuiltInHandlers(queue: ProcessingQueue): void {

  // FX rate refresh
  queue.register("fx_rate_refresh", async (job, db) => {
    const { getRate } = await import("./fx");
    const currencies = (job.payload as { currencies: string[] }).currencies ?? ["GHS","NGN","KES","GBP"];
    const results: Record<string, number> = {};
    for (const cur of currencies) {
      const rate = await getRate(db, cur);
      results[cur] = rate.mid_rate;
    }
    return results;
  });

  // ANALYZE
  queue.register("analyze_db", async (_job, db) => {
    db.prepare("ANALYZE").run();
    return { analyzed_at: new Date().toISOString() };
  });

  // Notification dispatch
  queue.register("notification_dispatch", async (job) => {
    const { notifyIncident } = await import("./notifications");
    const incident = job.payload as Parameters<typeof notifyIncident>[0];
    return notifyIncident(incident);
  });

  // WHT receipt generation
  queue.register("wht_receipt_generate", async (job, db) => {
    const { generatePayoutReceipt } = await import("./taxReceipt");
    const data = job.payload as Parameters<typeof generatePayoutReceipt>[1];
    return generatePayoutReceipt(db, data);
  });

  // Bulk statement
  queue.register("bulk_statement_generate", async (job, db) => {
    const { generateBulkStatement, buildBulkStatementFromDB } = await import("./taxReceipt");
    const { tenantId, countryCode, periodStart, periodEnd } = job.payload as {
      tenantId: string; countryCode: string; periodStart: string; periodEnd: string;
    };
    const stmt = buildBulkStatementFromDB(db, tenantId, countryCode, periodStart, periodEnd);
    if (!stmt) return { skipped: true, reason: "No WHT payouts found for period" };
    return generateBulkStatement(db, stmt);
  });

  // Payout sweep (offloaded from request thread)
  queue.register("payout_sweep", async (job, db) => {
    const { runPayoutSweep } = await import("./payout");
    const { tenantId } = job.payload as { tenantId: string };
    return runPayoutSweep(tenantId, db);
  });

  console.info("[queue] Built-in handlers registered: fx_rate_refresh, analyze_db, notification_dispatch, wht_receipt_generate, bulk_statement_generate, payout_sweep");
}
