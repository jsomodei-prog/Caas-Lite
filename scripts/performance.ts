/**
 * src/analytics/performance.ts
 * Advanced performance tuning, query telemetry, and Prometheus metrics.
 *
 * Capabilities:
 *  - PerformanceMonitor: wraps any synchronous DB call, records duration,
 *    writes to slow_query_log when threshold is breached.
 *  - analyzeIndexes: inspects PRAGMA index_list / index_info / stats to surface
 *    unused or missing indexes across all tables.
 *  - explainQuery: runs EXPLAIN QUERY PLAN and returns the parsed scan tree.
 *  - getTableStats: page counts, row estimates, fragmentation ratios.
 *  - Prometheus registry: exports canonical CaaS metrics on /metrics.
 *  - createQueryTimingMiddleware: Express middleware for HTTP request telemetry.
 *  - generatePerformanceReport: full point-in-time diagnostic snapshot.
 *
 * Required packages:
 *   npm install prom-client
 *
 * Phase 10 build-out  |  Commit baseline: a4f5db6
 */

import { performance } from "perf_hooks";
import type { Request, Response, NextFunction } from "express";
import type { Database as DB } from "better-sqlite3";
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
  type LabelValues,
} from "prom-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SlowQueryEntry {
  id: string;
  label: string;
  duration_ms: number;
  threshold_ms: number;
  context_json: string;
  recorded_at: string;
}

export interface QueryRecord {
  label: string;
  duration_ms: number;
  slow: boolean;
  recorded_at: string;
}

export interface IndexInfo {
  table: string;
  index_name: string;
  unique: boolean;
  columns: string[];
  /** Estimated rows scanned per lookup (from sqlite_stat1). */
  avg_rows_scanned: number | null;
  /** Whether sqlite_stat1 has data for this index (requires ANALYZE). */
  has_stats: boolean;
}

export interface TableStats {
  table: string;
  row_count_estimate: number | null;
  page_count: number;
  page_size_bytes: number;
  size_bytes: number;
  index_count: number;
  fragmentation_ratio: number | null;
}

export interface ExplainNode {
  id: number;
  parent: number;
  detail: string;
  scan_type: "SCAN" | "SEARCH" | "USE TEMP" | "COMPOUND" | "OTHER";
}

export interface PerformanceReport {
  generated_at: string;
  db_path: string;
  sqlite_version: string;
  page_size_bytes: number;
  journal_mode: string;
  wal_checkpoint_info: Record<string, number>;
  table_stats: TableStats[];
  index_analysis: IndexInfo[];
  slow_queries_last_hour: SlowQueryEntry[];
  slow_query_count_24h: number;
  recommendations: string[];
}

// ─── Prometheus Registry ──────────────────────────────────────────────────────

/** Singleton Prometheus registry for the CaaS platform. */
export const registry = new Registry();
registry.setDefaultLabels({ app: "caas_lite", env: process.env.NODE_ENV ?? "production" });

// Collect default Node.js metrics (heap, GC, event loop lag, etc.)
collectDefaultMetrics({ register: registry });

// ── Query duration histogram ──
export const queryDurationHistogram = new Histogram({
  name: "caas_query_duration_seconds",
  help: "Duration of database queries in seconds",
  labelNames: ["label", "slow"] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// ── Slow query counter ──
export const slowQueryCounter = new Counter({
  name: "caas_slow_queries_total",
  help: "Total number of queries exceeding the slow query threshold",
  labelNames: ["label"] as const,
  registers: [registry],
});

// ── HTTP request duration ──
export const httpRequestDuration = new Histogram({
  name: "caas_http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// ── HTTP request counter ──
export const httpRequestCounter = new Counter({
  name: "caas_http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["method", "route", "status_code"] as const,
  registers: [registry],
});

// ── Active HTTP connections gauge ──
export const activeConnectionsGauge = new Gauge({
  name: "caas_active_http_connections",
  help: "Number of currently active HTTP connections",
  registers: [registry],
});

// ── DB backup metrics ──
export const backupDurationHistogram = new Histogram({
  name: "caas_db_backup_duration_seconds",
  help: "Duration of database backup operations in seconds",
  labelNames: ["status"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [registry],
});

export const backupSizeGauge = new Gauge({
  name: "caas_db_backup_size_bytes",
  help: "Size of the most recent database backup in bytes",
  registers: [registry],
});

// ── Rate limit metrics ──
export const rateLimitCounter = new Counter({
  name: "caas_rate_limit_hits_total",
  help: "Total number of requests rejected by the rate limiter",
  labelNames: ["tier", "tenant_id"] as const,
  registers: [registry],
});

// ── Failover gauge ──
export const failoverGauge = new Gauge({
  name: "caas_db_failover_active",
  help: "1 if the database is currently running in failover/read-only replica mode",
  registers: [registry],
});

// ── Payout sweep metrics ──
export const payoutSweepCounter = new Counter({
  name: "caas_payout_sweep_total",
  help: "Total payouts initiated per sweep",
  labelNames: ["tenant_id", "status", "local_currency"] as const,
  registers: [registry],
});

export const payoutAmountHistogram = new Histogram({
  name: "caas_payout_amount_usd",
  help: "Distribution of payout amounts in USD",
  labelNames: ["local_currency"] as const,
  buckets: [1, 10, 50, 100, 500, 1000, 5000, 10000, 50000],
  registers: [registry],
});

// ── FX rate gauge ──
export const fxRateGauge = new Gauge({
  name: "caas_fx_mid_rate",
  help: "Most recently cached mid-market FX rate (USD → local currency)",
  labelNames: ["currency", "provider"] as const,
  registers: [registry],
});

// ── Anomaly metrics ──
export const anomalyCounter = new Counter({
  name: "caas_anomaly_events_total",
  help: "Total anomaly events detected",
  labelNames: ["event_type", "risk_level", "tenant_id"] as const,
  registers: [registry],
});

// ─── Slow Query Table Bootstrap ───────────────────────────────────────────────

/**
 * Creates the slow_query_log table if it does not already exist.
 * Called once during PerformanceMonitor construction.
 */
export function ensureSlowQueryTable(db: DB): void {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS slow_query_log (
      id           TEXT    PRIMARY KEY,
      label        TEXT    NOT NULL,
      duration_ms  REAL    NOT NULL,
      threshold_ms REAL    NOT NULL,
      context_json TEXT    NOT NULL DEFAULT '{}',
      recorded_at  TEXT    NOT NULL
    )
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_slow_query_log_label
    ON slow_query_log (label, recorded_at DESC)
  `).run();

  db.prepare(`
    CREATE INDEX IF NOT EXISTS idx_slow_query_log_duration
    ON slow_query_log (duration_ms DESC)
  `).run();
}

// ─── PerformanceMonitor ───────────────────────────────────────────────────────

/**
 * Wraps synchronous database operations to record execution time.
 * Writes an entry to slow_query_log whenever duration exceeds thresholdMs.
 * Increments the caas_slow_queries_total Prometheus counter on every slow query.
 */
export class PerformanceMonitor {
  private readonly thresholdMs: number;

  constructor(
    private readonly db: DB,
    options: { slowQueryThresholdMs?: number } = {}
  ) {
    this.thresholdMs = options.slowQueryThresholdMs ?? 100;
    ensureSlowQueryTable(db);
  }

  /**
   * Executes fn(), records its duration, logs if slow.
   * @param label   Human-readable identifier shown in logs and Prometheus.
   * @param fn      Synchronous database operation.
   * @param context Optional metadata attached to the slow-query log entry.
   */
  track<T>(
    label: string,
    fn: () => T,
    context: Record<string, unknown> = {}
  ): T {
    const start = performance.now();
    let threw = false;
    try {
      const result = fn();
      return result;
    } catch (err) {
      threw = true;
      throw err;
    } finally {
      const durationMs = performance.now() - start;
      const durationSec = durationMs / 1000;
      const slow = durationMs >= this.thresholdMs;

      queryDurationHistogram.observe(
        { label, slow: slow ? "true" : "false" } as LabelValues<"label" | "slow">,
        durationSec
      );

      if (slow && !threw) {
        slowQueryCounter.inc({ label } as LabelValues<"label">);
        this.writeSlowQueryLog(label, durationMs, {
          ...context,
          threshold_ms: this.thresholdMs,
        });
      }
    }
  }

  private writeSlowQueryLog(
    label: string,
    durationMs: number,
    context: Record<string, unknown>
  ): void {
    try {
      const { randomUUID } = require("crypto") as typeof import("crypto");
      this.db.prepare(`
        INSERT INTO slow_query_log (id, label, duration_ms, threshold_ms, context_json, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        label,
        durationMs,
        this.thresholdMs,
        JSON.stringify(context),
        new Date().toISOString()
      );
    } catch {
      // Never let monitoring logic crash the application.
    }
  }

  getSlowQueries(
    since: string = new Date(Date.now() - 3_600_000).toISOString(),
    limit = 100
  ): SlowQueryEntry[] {
    return this.db
      .prepare(
        `SELECT * FROM slow_query_log
         WHERE recorded_at >= ?
         ORDER BY duration_ms DESC
         LIMIT ?`
      )
      .all(since, limit) as SlowQueryEntry[];
  }

  getSlowQueryCount(sinceHours = 24): number {
    const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
    const row = this.db
      .prepare("SELECT COUNT(*) as cnt FROM slow_query_log WHERE recorded_at >= ?")
      .get(since) as { cnt: number };
    return row.cnt;
  }

  purgeSlowQueryLog(olderThanDays = 7): number {
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const result = this.db
      .prepare("DELETE FROM slow_query_log WHERE recorded_at < ?")
      .run(cutoff);
    return result.changes;
  }
}

// ─── Index Analysis ───────────────────────────────────────────────────────────

/**
 * Performs a deep analysis of all indexes across user tables.
 * Reads PRAGMA index_list, index_info, and sqlite_stat1 (populated by ANALYZE).
 * For fresh databases with no ANALYZE data, avg_rows_scanned will be null.
 *
 * Call ANALYZE periodically (e.g. weekly) to keep statistics current.
 */
export function analyzeIndexes(db: DB): IndexInfo[] {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .all() as { name: string }[];

  // Load sqlite_stat1 if ANALYZE has been run.
  const statRows = db
    .prepare(
      `SELECT name, stat FROM sqlite_stat1 WHERE 1=1`
    )
    .all()
    .catch?.(() => []) as unknown as { name: string; stat: string }[];

  const statMap = new Map<string, number>();
  for (const row of statRows) {
    const parts = row.stat.split(" ").map(Number);
    // stat format: "totalRows rowsPerEntry …"
    // avg rows scanned ≈ totalRows / rowsPerEntry gives selectivity.
    if (parts.length >= 2 && parts[1] > 0) {
      statMap.set(row.name, Math.round(parts[0] / parts[1]));
    }
  }

  const results: IndexInfo[] = [];

  for (const { name: table } of tables) {
    const indexes = db
      .prepare(`PRAGMA index_list("${table}")`)
      .all() as { seq: number; name: string; unique: number; origin: string }[];

    for (const idx of indexes) {
      const columns = (
        db
          .prepare(`PRAGMA index_info("${idx.name}")`)
          .all() as { seqno: number; cid: number; name: string }[]
      ).map((c) => c.name);

      results.push({
        table,
        index_name: idx.name,
        unique: idx.unique === 1,
        columns,
        avg_rows_scanned: statMap.get(idx.name) ?? null,
        has_stats: statMap.has(idx.name),
      });
    }
  }

  return results;
}

/**
 * Identifies potentially problematic index situations and returns
 * human-readable recommendations.
 */
export function recommendIndexImprovements(
  db: DB,
  indexes: IndexInfo[]
): string[] {
  const recommendations: string[] = [];

  // Tables with high row counts but no indexes beyond the PK.
  const tables = db
    .prepare(
      `SELECT tbl_name as name, SUM(payload) as payload
       FROM dbstat WHERE aggregate = TRUE
       GROUP BY tbl_name`
    )
    .all() as { name: string; payload: number }[];

  const indexCountByTable = new Map<string, number>();
  for (const idx of indexes) {
    indexCountByTable.set(idx.table, (indexCountByTable.get(idx.table) ?? 0) + 1);
  }

  for (const table of tables) {
    const count = indexCountByTable.get(table.name) ?? 0;
    if (table.payload > 1_000_000 && count <= 1) {
      recommendations.push(
        `Table "${table.name}" is large (${(table.payload / 1024).toFixed(0)} KiB payload) ` +
          `but has only ${count} index. Consider adding indexes for frequently-filtered columns.`
      );
    }
  }

  // Indexes with no ANALYZE stats (may indicate ANALYZE has never been run).
  const missingStats = indexes.filter((i) => !i.has_stats && !i.index_name.startsWith("sqlite_"));
  if (missingStats.length > 0) {
    recommendations.push(
      `${missingStats.length} index(es) lack sqlite_stat1 data. ` +
        `Run ANALYZE to enable query-planner optimizations. ` +
        `Schedule weekly: db.prepare('ANALYZE').run()`
    );
  }

  // Duplicate column combinations.
  const colSigs = new Map<string, string[]>();
  for (const idx of indexes) {
    const sig = `${idx.table}:${idx.columns.sort().join(",")}`;
    if (!colSigs.has(sig)) colSigs.set(sig, []);
    colSigs.get(sig)!.push(idx.index_name);
  }
  for (const [sig, names] of colSigs) {
    if (names.length > 1) {
      recommendations.push(
        `Duplicate indexes detected on (${sig}): ${names.join(", ")}. ` +
          `Drop the redundant one to reduce write overhead.`
      );
    }
  }

  return recommendations;
}

// ─── EXPLAIN QUERY PLAN ───────────────────────────────────────────────────────

/**
 * Runs EXPLAIN QUERY PLAN for a given SQL statement and returns the parsed tree.
 * Use this to verify that indexes are being used as expected.
 */
export function explainQuery(
  db: DB,
  sql: string,
  params: unknown[] = []
): ExplainNode[] {
  const rows = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params) as {
      id: number;
      parent: number;
      notused: number;
      detail: string;
    }[];

  return rows.map((row) => {
    let scanType: ExplainNode["scan_type"] = "OTHER";
    const d = row.detail.toUpperCase();
    if (d.includes("SCAN")) scanType = "SCAN";
    else if (d.includes("SEARCH")) scanType = "SEARCH";
    else if (d.includes("USE TEMP")) scanType = "USE TEMP";
    else if (d.includes("COMPOUND")) scanType = "COMPOUND";

    return {
      id: row.id,
      parent: row.parent,
      detail: row.detail,
      scan_type: scanType,
    };
  });
}

// ─── Table Statistics ─────────────────────────────────────────────────────────

/**
 * Returns size and row-count statistics for every user table using
 * the dbstat virtual table and sqlite_stat1.
 *
 * page_count is accurate.  row_count_estimate requires ANALYZE.
 */
export function getTableStats(db: DB): TableStats[] {
  const pageSize = (
    db.prepare("PRAGMA page_size").get() as { page_size: number }
  ).page_size;

  const dbStatRows = db
    .prepare(
      `SELECT name, pageno_count as page_count
       FROM (SELECT name, COUNT(*) as pageno_count FROM dbstat GROUP BY name)
       WHERE name NOT LIKE 'sqlite_%'`
    )
    .all() as { name: string; page_count: number }[];

  // Row counts from sqlite_stat1 (only available after ANALYZE).
  const statRows = db
    .prepare("SELECT tbl, stat FROM sqlite_stat1 WHERE 1=1")
    .all()
    .catch?.(() => []) as unknown as { tbl: string; stat: string }[];

  const rowCountMap = new Map<string, number>();
  for (const row of statRows) {
    const parts = row.stat.split(" ").map(Number);
    if (parts[0]) rowCountMap.set(row.tbl, parts[0]);
  }

  const indexCountRows = db
    .prepare(
      `SELECT tbl_name as name, COUNT(*) as cnt
       FROM sqlite_master WHERE type='index' GROUP BY tbl_name`
    )
    .all() as { name: string; cnt: number }[];
  const indexCountMap = new Map(indexCountRows.map((r) => [r.name, r.cnt]));

  return dbStatRows.map((row) => ({
    table: row.name,
    row_count_estimate: rowCountMap.get(row.name) ?? null,
    page_count: row.page_count,
    page_size_bytes: pageSize,
    size_bytes: row.page_count * pageSize,
    index_count: indexCountMap.get(row.name) ?? 0,
    fragmentation_ratio: null, // SQLite does not expose fragmentation directly.
  }));
}

// ─── Full Performance Report ──────────────────────────────────────────────────

/**
 * Generates a complete point-in-time diagnostic snapshot.
 * This is the primary artefact for scheduled performance audits and
 * can be fed directly to the compliance report builder.
 */
export function generatePerformanceReport(
  db: DB,
  monitor: PerformanceMonitor
): PerformanceReport {
  const generatedAt = new Date().toISOString();

  const sqliteVersion = (
    db.prepare("SELECT sqlite_version() as v").get() as { v: string }
  ).v;

  const pageSize = (
    db.prepare("PRAGMA page_size").get() as { page_size: number }
  ).page_size;

  const journalMode = (
    db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }
  ).journal_mode;

  const walInfo = db
    .prepare("PRAGMA wal_checkpoint(PASSIVE)")
    .get() as { busy: number; log: number; checkpointed: number };

  const indexes      = analyzeIndexes(db);
  const tableStats   = getTableStats(db);
  const slowLastHour = monitor.getSlowQueries(
    new Date(Date.now() - 3_600_000).toISOString()
  );
  const slowCount24h  = monitor.getSlowQueryCount(24);
  const recommendations = recommendIndexImprovements(db, indexes);

  if (slowCount24h > 50) {
    recommendations.push(
      `${slowCount24h} slow queries in the last 24 hours. ` +
        `Review the slow_query_log table and consider adding indexes or ` +
        `breaking large queries into batches.`
    );
  }

  if (journalMode !== "wal") {
    recommendations.push(
      `Journal mode is "${journalMode}". Switching to WAL (PRAGMA journal_mode=WAL) ` +
        `dramatically improves concurrent read/write throughput.`
    );
  }

  const dbPath = (db as unknown as { name: string }).name ?? "unknown";

  return {
    generated_at: generatedAt,
    db_path: dbPath,
    sqlite_version: sqliteVersion,
    page_size_bytes: pageSize,
    journal_mode: journalMode,
    wal_checkpoint_info: {
      busy: walInfo.busy,
      log: walInfo.log,
      checkpointed: walInfo.checkpointed,
    },
    table_stats: tableStats,
    index_analysis: indexes,
    slow_queries_last_hour: slowLastHour,
    slow_query_count_24h: slowCount24h,
    recommendations,
  };
}

// ─── Express Middleware ────────────────────────────────────────────────────────

/**
 * Express middleware that records HTTP request duration and increments
 * the caas_http_requests_total Prometheus counter.
 *
 * Mount this before all routes:
 *   app.use(createQueryTimingMiddleware());
 */
export function createQueryTimingMiddleware() {
  return function caasTimingMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    const start = performance.now();
    activeConnectionsGauge.inc();

    res.on("finish", () => {
      const durationSec = (performance.now() - start) / 1000;
      const route  = (req.route?.path as string | undefined) ?? req.path ?? "unknown";
      const method = req.method;
      const status = String(res.statusCode);

      const labels = { method, route, status_code: status } as LabelValues<
        "method" | "route" | "status_code"
      >;
      httpRequestDuration.observe(labels, durationSec);
      httpRequestCounter.inc(labels);
      activeConnectionsGauge.dec();
    });

    next();
  };
}

/**
 * Express route handler that serves Prometheus metrics.
 * Mount on GET /metrics — restrict to internal networks in production.
 *
 *   app.get("/metrics", metricsHandler);
 */
export async function metricsHandler(
  _req: Request,
  res: Response
): Promise<void> {
  res.setHeader("Content-Type", registry.contentType);
  res.end(await registry.metrics());
}

// ─── Grafana Dashboard Pointer ────────────────────────────────────────────────
//
// A pre-built Grafana dashboard JSON for these metrics is maintained at:
//   docs/grafana/caas-dashboard.json
//
// Import it via Grafana → Dashboards → Import → Upload JSON file.
//
// Key panels:
//   - Request rate (caas_http_requests_total)
//   - P50/P95/P99 request latency (caas_http_request_duration_seconds)
//   - Slow query rate (caas_slow_queries_total)
//   - Query duration heatmap (caas_query_duration_seconds)
//   - Rate-limit rejection rate (caas_rate_limit_hits_total)
//   - Payout sweep throughput (caas_payout_sweep_total)
//   - FX mid-rate per currency (caas_fx_mid_rate)
//   - Anomaly event rate by risk level (caas_anomaly_events_total)
//   - DB backup size trend (caas_db_backup_size_bytes)
//   - Failover status (caas_db_failover_active)
//   - Node.js heap / GC pressure (default prom-client metrics)
//
// Prometheus scrape config (prometheus.yml):
//   scrape_configs:
//     - job_name: caas_lite
//       static_configs:
//         - targets: ['localhost:3000']
//       metrics_path: /metrics
//       scrape_interval: 15s
