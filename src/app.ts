/**
 * src/app.ts
 * Production Express application factory.
 *
 * Initialization order (strict — do not reorder):
 *   1.  Environment validation
 *   2.  Database open + migrations
 *   3.  Performance monitor init
 *   4.  Backup manager init
 *   4b. Async processing queue init      ← Phase 11
 *   5.  Cron scheduler
 *   6.  Express app construction
 *   7.  Global middleware (helmet, CORS, compression, body parsing)
 *   8.  Request timing middleware
 *   9.  Rate limiter middleware
 *   10. API routes (auth, users, commercial, payouts, anomalies, fx, compliance, admin, queue, regulatory)
 *   11. /metrics Prometheus endpoint
 *   12. /health, /healthz, /readyz + /dashboard endpoints
 *   13. 404 handler
 *   14. Global error handler
 *   15. Graceful-shutdown hooks
 *
 * Phase 12-13 build-out | Commit baseline: cc20b1a
 * Phase 14 update      | Dynamic regulatory ingestion replaces hardcoded compliance profiles.
 */

import express, { type Express } from "express";
import helmet      from "helmet";
import cors        from "cors";
import compression from "compression";
import * as cron   from "node-cron";
import path        from "path";
import type { Database as DB } from "better-sqlite3";

import { openDatabase, getPendingMigrations } from "./db/migrate";
import { BackupManager }          from "./db/replication";
import { checkDatabaseIntegrity } from "./db/replication";
import {
  PerformanceMonitor,
  generatePerformanceReport,
  createQueryTimingMiddleware,
  metricsHandler,
  backupDurationHistogram,
  backupSizeGauge,
  failoverGauge,
  fxRateGauge,
} from "./analytics/performance";
import { createRateLimiter, buildTierOverridesFromEnv } from "./middleware/rateLimiter";
import { createAuthRouter }       from "./routes/auth";
import { createUsersRouter }      from "./routes/users";
import { createCommercialRouter } from "./routes/commercial";
import { getQueue }               from "./services/queue";
import { requestIdMiddleware }    from "./middleware/request-id";
import { validate }               from "./middleware/validate";
import { errorHandler }           from "./middleware/error-handler";
import { httpLoggerMiddleware }   from "./middleware/http-logger";
import { AppError }               from "./lib/errors";
import { pinoLogger, childLogger, logError } from "./lib/pino";
import { installShutdownHandlers } from "./lib/shutdown";
import {
  PayoutSweepBody, PayoutsListQuery, AnomaliesQuery, FxRateParams,
  QueueEnqueueBody, QueueJobParams, BulkStatementBody, NotifyTestBody,
  AdminBackupBody,
} from "./schemas/app-routes";
import {
  injectPlaneContext,
  getAccessMetricsHandler,
  requireBusinessPlane,
} from "./middleware/dualPlaneAuth";

// ─── Phase 14: Dynamic Regulatory Ingestion ──────────────────────────────────
// Replaces ./config/industryProfiles and ./config/countryRequirements imports.
// Frameworks are now loaded from regulatory_frameworks / regulatory_field_rules /
// regulatory_consent_purposes tables and managed via /api/v1/regulatory.
import { createRegulatoryIngestRouter } from "./routes/regulatoryIngest";

// Type-only import: notifications.ts is dynamically imported at handler time
// (see /admin/notify/test below) to keep cold-start light, but the union types
// are needed at compile time. Type-only imports erase at compile time so
// they don't change the runtime module graph.
import type { IncidentType, IncidentSeverity } from "./services/notifications";
// CSP connect-src origins. Env-var driven so deployment can point at production
// hostnames without code changes; localhost defaults keep local dev frictionless.
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
const API_ORIGIN      = process.env.API_ORIGIN      ?? "http://localhost:3000";

// ─── Environment Validation ───────────────────────────────────────────────────

interface RequiredEnv {
  PAYOUT_HMAC_SECRET: string;
  JWT_ACCESS_SECRET:  string;
  JWT_REFRESH_SECRET: string;
  DB_PATH:            string;
}

function validateEnvironment(): RequiredEnv {
  const required: (keyof RequiredEnv)[] = [
    "PAYOUT_HMAC_SECRET",
    "JWT_ACCESS_SECRET",
    "JWT_REFRESH_SECRET",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
      `Copy .env.example to .env and populate all values.`
    );
  }
  return {
    PAYOUT_HMAC_SECRET: process.env.PAYOUT_HMAC_SECRET!,
    JWT_ACCESS_SECRET:  process.env.JWT_ACCESS_SECRET!,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET!,
    DB_PATH:            process.env.DB_PATH ?? "/data/caas_evidence.db",
  };
}

// ─── Backup Manager Factory ───────────────────────────────────────────────────

function buildBackupManager(db: DB, hmacSecret: string): BackupManager {
  return new BackupManager(db, {
    localTempDir:   process.env.BACKUP_TEMP_DIR ?? path.join(process.cwd(), "tmp", "backups"),
    integrityCheck: true,
    hmacSecret,
    pagesPerStep:   200,

    ...(process.env.BACKUP_S3_BUCKET
      ? {
          s3: {
            bucket:          process.env.BACKUP_S3_BUCKET,
            keyPrefix:       process.env.BACKUP_S3_PREFIX         ?? "backups/",
            region:          process.env.AWS_REGION               ?? "us-east-1",
            retentionDays:   parseInt(process.env.BACKUP_S3_RETENTION_DAYS ?? "30", 10),
            endpoint:        process.env.BACKUP_S3_ENDPOINT,
            accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
          },
        }
      : {}),

    ...(process.env.BACKUP_FS_DIR
      ? {
          filesystem: {
            destDir:        process.env.BACKUP_FS_DIR,
            retentionCount: parseInt(process.env.BACKUP_FS_RETENTION ?? "7", 10),
          },
        }
      : {}),
  });
}

// ─── Cron Scheduler ───────────────────────────────────────────────────────────

function registerCronJobs(
  db: DB,
  backupManager: BackupManager,
  monitor: PerformanceMonitor
): () => void {
  const log = childLogger("cron");
  const jobs: ReturnType<typeof cron.schedule>[] = [];

  const backupSchedule = process.env.BACKUP_CRON_SCHEDULE ?? "0 2 * * *";

  jobs.push(cron.schedule(backupSchedule, async () => {
    log.info({ job: "backup" }, "scheduled backup starting");
    const start = Date.now();
    try {
      const manifest = await backupManager.runBackup();
      backupDurationHistogram.observe({ status: manifest.status }, (Date.now() - start) / 1000);
      backupSizeGauge.set(manifest.size_bytes);
      log.info(
        { job: "backup", status: manifest.status, sizeBytes: manifest.size_bytes },
        "scheduled backup complete",
      );
    } catch (err) {
      backupDurationHistogram.observe({ status: "failed" }, (Date.now() - start) / 1000);
      logError(log, "scheduled backup failed", err, { job: "backup" });
    }
  }, { timezone: "UTC" }));

  jobs.push(cron.schedule("0 * * * *", () => {
    try {
      const result = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[];
      log.debug({ job: "wal_checkpoint", result: result[0] }, "wal checkpoint complete");
    } catch (err) { logError(log, "wal checkpoint failed", err, { job: "wal_checkpoint" }); }
  }, { timezone: "UTC" }));

  jobs.push(cron.schedule("0 3 * * 0", () => {
    try { db.prepare("ANALYZE").run(); log.info({ job: "analyze" }, "ANALYZE complete"); }
    catch (err) { logError(log, "ANALYZE failed", err, { job: "analyze" }); }
  }, { timezone: "UTC" }));

  jobs.push(cron.schedule("0 1 * * *", () => {
    try {
      const removed = monitor.purgeSlowQueryLog(7);
      log.debug({ job: "slow_query_prune", removed }, "slow-query log pruned");
    } catch (err) { logError(log, "slow-query prune failed", err, { job: "slow_query_prune" }); }
  }, { timezone: "UTC" }));

  // Phase 11: daily FX rate refresh via queue
  jobs.push(cron.schedule("0 6 * * *", () => {
    try {
      const queue = getQueue();
      queue.enqueue({
        type: "fx_rate_refresh",
        priority: "high",
        payload: { currencies: ["GHS","NGN","KES","ZAR","GBP","EUR","CAD","AUD","INR","PHP","IDR","SGD","AUD","MXN","BRL","COP","AED"] },
        idempotencyKey: `fx_refresh_${new Date().toISOString().slice(0, 10)}`,
      });
    } catch (err) { logError(log, "FX refresh enqueue failed", err, { job: "fx_refresh" }); }
  }, { timezone: "UTC" }));

  // Phase 11: daily job queue purge (keep 7 days of completed jobs)
  jobs.push(cron.schedule("30 1 * * *", () => {
    try {
      const queue = getQueue();
      const removed = queue.purge(7);
      log.debug({ job: "queue_purge", removed }, "job queue purged");
    } catch (err) { logError(log, "queue purge failed", err, { job: "queue_purge" }); }
  }, { timezone: "UTC" }));

  log.info(
    {
      backupSchedule,
      walCheckpoint: "0 * * * *",
      analyze:       "0 3 * * 0",
      slowQueryPrune:"0 1 * * *",
      fxRefresh:     "0 6 * * *",
      queuePurge:    "30 1 * * *",
    },
    "cron jobs scheduled",
  );

  return () => { for (const job of jobs) job.stop(); };
}

// ─── CORS Configuration ───────────────────────────────────────────────────────

function buildCorsOptions(): cors.CorsOptions {
  const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",").map((o) => o.trim()).filter(Boolean);

  if (allowedOrigins.length === 0 && process.env.NODE_ENV === "production") {
    pinoLogger.warn("CORS_ORIGINS is not set — all origins allowed in dev mode");
  }

  return {
    origin: allowedOrigins.length > 0
      ? (origin, cb) => {
          if (!origin || allowedOrigins.includes(origin)) cb(null, true);
          else cb(new Error(`Origin ${origin} not allowed by CORS policy`));
        }
      : true,
    credentials: true,
    methods:        ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Tenant-ID", "X-CaaS-Role", "X-CaaS-Tier", "X-Request-ID"],
    exposedHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"],
    maxAge: 86_400,
  };
}

// ─── Request ID Middleware ────────────────────────────────────────────────────
// Moved to src/middleware/request-id.ts (slice 2). The implementation here now
// validates the inbound X-Request-ID header to prevent log spoofing — see that
// module for the rationale.

// ─── Health Routes ────────────────────────────────────────────────────────────

function registerHealthRoutes(
  app: Express,
  db: DB,
  backupManager: BackupManager,
  startedAt: string
): void {
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", started_at: startedAt, uptime_seconds: Math.floor(process.uptime()) });
  });

  app.get("/health/db", (_req, res) => {
    const failoverState = backupManager.getFailoverState();
    failoverGauge.set(failoverState.active ? 1 : 0);
    let integrityOk = true;
    try { integrityOk = checkDatabaseIntegrity(db).ok; } catch { integrityOk = false; }
    const lastBackup = backupManager.getLastManifest();
    const status = failoverState.active || !integrityOk ? 503 : 200;
    res.status(status).json({
      status: status === 200 ? "ok" : "degraded",
      integrity_ok: integrityOk,
      failover: failoverState,
      last_backup: lastBackup
        ? { backup_id: lastBackup.backup_id, status: lastBackup.status, size_bytes: lastBackup.size_bytes, completed_at: lastBackup.completed_at }
        : null,
    });
  });

  app.get("/health/performance", (_req, res) => {
    const monitor = new PerformanceMonitor(db);
    res.json(generatePerformanceReport(db, monitor));
  });

  // ── Slice 4: /healthz (liveness) and /readyz (readiness) ────────────────
  // These follow the k8s probe convention: /healthz answers "is the process
  // alive" (restart-trigger), /readyz answers "should I receive traffic"
  // (load-balancer trigger). Legacy /health, /health/db, /health/performance
  // routes above stay for backward compatibility with anything that already
  // polls them.

  /**
   * Liveness — the process is running and the event loop isn't wedged.
   * NO dependency checks. NEVER hits the DB. If this returns a body at all,
   * the orchestrator should leave the pod alone.
   *
   * If you find yourself wanting to add a DB check here, you want /readyz
   * instead. Liveness-failing on a transient DB issue causes a restart
   * loop — readiness-failing causes traffic to drain to other replicas.
   */
  app.get("/healthz", (_req, res) => {
    res.status(200).json({
      status:         "ok",
      uptime_seconds: Math.floor(process.uptime()),
    });
  });

  /**
   * Readiness — all dependencies the process needs to serve a real request
   * are usable. Returns 503 with a per-check `reasons` object on failure so
   * the operator can tell at a glance which dependency is degraded.
   *
   * Checks (all must pass for 200):
   *   1. db.select_1      — trivial SQL query against the open connection
   *   2. db.migrations    — schema is at head; getPendingMigrations is empty
   *   3. backup.failover  — backup manager is not in active failover
   *
   * Why migrations matter: a pod that's up but on the wrong schema is the
   * classic silent-failure mode after a partial rollout. Returning 503 here
   * keeps such a pod out of the load balancer until the operator notices.
   */
  app.get("/readyz", (_req, res) => {
    const reasons: Record<string, { ok: boolean; detail?: string }> = {};

    // 1. DB reachable + responsive
    try {
      const row = db.prepare("SELECT 1 AS ok").get() as { ok: number } | undefined;
      reasons["db.select_1"] = row?.ok === 1
        ? { ok: true }
        : { ok: false, detail: "SELECT 1 returned unexpected row" };
    } catch (err) {
      reasons["db.select_1"] = { ok: false, detail: (err as Error).message };
    }

    // 2. Schema is at head — no pending migrations
    try {
      const pending = getPendingMigrations(db);
      reasons["db.migrations"] = pending.length === 0
        ? { ok: true }
        : { ok: false, detail: `${pending.length} migration(s) pending: ${pending.map(p => `v${p.version}`).join(", ")}` };
    } catch (err) {
      reasons["db.migrations"] = { ok: false, detail: (err as Error).message };
    }

    // 3. Backup manager not in active failover
    try {
      const failover = backupManager.getFailoverState();
      reasons["backup.failover"] = failover.active
        ? { ok: false, detail: "backup manager is in active failover" }
        : { ok: true };
    } catch (err) {
      reasons["backup.failover"] = { ok: false, detail: (err as Error).message };
    }

    const allOk = Object.values(reasons).every((r) => r.ok);
    res.status(allOk ? 200 : 503).json({
      status:  allOk ? "ready" : "not_ready",
      checks:  reasons,
      started_at:     startedAt,
      uptime_seconds: Math.floor(process.uptime()),
    });
  });
}

// ─── Application Factory ──────────────────────────────────────────────────────

export interface AppContext {
  app:           Express;
  db:            DB;
  backupManager: BackupManager;
  monitor:       PerformanceMonitor;
  stopCron:      () => void;
}

export function createApp(): AppContext {

  // ── Step 1: Environment ───────────────────────────────────────────────────
  const env = validateEnvironment();

  // ── Step 2: Database ──────────────────────────────────────────────────────
  const db = openDatabase(env.DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");
  db.pragma("temp_store = MEMORY");
  db.pragma("mmap_size = 268435456");
  db.pragma("cache_size = -16000");

  // ── Step 3: Performance monitor ───────────────────────────────────────────
  const monitor = new PerformanceMonitor(db, {
    slowQueryThresholdMs: parseInt(process.env.SLOW_QUERY_THRESHOLD_MS ?? "100", 10),
  });

  // ── Step 4: Backup manager ────────────────────────────────────────────────
  const backupManager = buildBackupManager(db, env.PAYOUT_HMAC_SECRET);

  // ── Step 4b: Async processing queue ──────────────────────────────────────
  const queue = getQueue(db);
  queue.start();

  // ── Step 5: Cron scheduler ────────────────────────────────────────────────
  const stopCron = registerCronJobs(db, backupManager, monitor);

  // ── Step 6: Express app ───────────────────────────────────────────────────
  const app      = express();
  const startedAt = new Date().toISOString();

  app.locals.db      = db;
  app.locals.monitor = monitor;
  app.locals.queue   = queue;

  // ── Step 7: Security + global middleware ──────────────────────────────────
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:    ["'self'"],
        scriptSrc:     ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        connectSrc:    ["'self'", FRONTEND_ORIGIN, API_ORIGIN],
        objectSrc:     ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: { maxAge: 31_536_000, includeSubDomains: true, preload: true },
  }));
  app.use(cors(buildCorsOptions()));
  app.use(compression());
  app.use(express.json({ limit: "512kb" }));
  app.use(express.urlencoded({ extended: false, limit: "512kb" }));
  app.use(requestIdMiddleware);
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // ── Step 7b: HTTP request logging ────────────────────────────────────────
  // Mounted after requestIdMiddleware so req.id is populated for the log line.
  // Skips noisy paths (health, metrics, dashboard). See src/middleware/http-logger.ts.
  app.use(httpLoggerMiddleware());

  // ── Step 8: Request timing ────────────────────────────────────────────────
  app.use(createQueryTimingMiddleware());

  // ── Step 8b: Dual-plane context injection ─────────────────────────────────
  // Resolves and attaches the plane principal to every authenticated request.
  app.use(injectPlaneContext());

  // ── Step 9: Rate limiter ──────────────────────────────────────────────────
  app.use(createRateLimiter({
    tierHeader:       "X-CaaS-Tier",
    tenantHeader:     "X-Tenant-ID",
    allowUnknownTier: process.env.RATE_LIMIT_ALLOW_UNKNOWN_TIER === "true",
    maxBuckets:       50_000,
    tierOverrides:    buildTierOverridesFromEnv(),
    bypassPaths: [
      "/health", "/health/db", "/health/performance", "/healthz", "/readyz", "/metrics",
      "/dashboard", "/register", "/api/v1/auth", "/api/v1/admin", "/api/v1/fx",
    ],
  }));

  // ── Step 10: API routes ───────────────────────────────────────────────────
  const apiV1 = express.Router();

  // Auth
  apiV1.use("/auth", createAuthRouter());

  // Users + profiles (Phase 11)
  apiV1.use("/users", createUsersRouter());

  // Commercial pipeline + insurance underwriting (Phase 12-13)
  apiV1.use("/commercial", createCommercialRouter());

  // ── Phase 14: Dynamic regulatory ingestion ──────────────────────────────
  // Admin-only onboarding + CRUD for region frameworks (Ghana Act 843, NDPA, etc.).
  // All sub-routes are internally gated by requireBusinessPlane(["global_super_admin"]).
  apiV1.use("/regulatory", createRegulatoryIngestRouter(db));

  // Payouts
  apiV1.post("/payouts/sweep", validate({ body: PayoutSweepBody }), async (req, res) => {
    const { runPayoutSweep } = await import("./services/payout");
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    if (!tenantId) throw AppError.badRequest("X-Tenant-ID header is required");
    const summary = await monitor.track("payout_sweep", () => runPayoutSweep(tenantId, db));
    res.json(summary);
  });

  apiV1.get("/payouts", validate({ query: PayoutsListQuery }), async (req, res) => {
    const { getPayoutHistory } = await import("./services/payout");
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    if (!tenantId) throw AppError.badRequest("X-Tenant-ID header is required");
    const limit  = (req.query.limit  as number | undefined) ?? 100;
    const offset = (req.query.offset as number | undefined) ?? 0;
    res.json({ data: monitor.track("payout_history", () => getPayoutHistory(db, tenantId, limit, offset)), limit, offset });
  });

  // Anomalies
  apiV1.get("/anomalies", validate({ query: AnomaliesQuery }), async (req, res) => {
    const { queryAnomalyLogs, getAnomalyStats } = await import("./analytics/anomaly");
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    if (!tenantId) throw AppError.badRequest("X-Tenant-ID header is required");
    const q = req.query as {
      risk_level?: "low" | "medium" | "high" | "critical";
      since?:      string;
      limit?:      number;
      offset?:     number;
    };
    res.json({
      stats: monitor.track("anomaly_stats", () => getAnomalyStats(db, tenantId, q.since)),
      data:  monitor.track("anomaly_logs",  () => queryAnomalyLogs(db, tenantId, {
        risk_level: q.risk_level,
        since:      q.since,
        limit:      q.limit  ?? 100,
        offset:     q.offset ?? 0,
      })),
    });
  });

  // FX rates
  apiV1.get("/fx/rates/:currency", validate({ params: FxRateParams }), async (req, res) => {
    const { getRate, getRateHistory } = await import("./services/fx");
    // req.params.currency is typed string | string[] by Express 5 (to support
    // /foo/:bar+ repeatable params). The validate() middleware above has
    // already enforced FxRateParams which treats it as a single string, so
    // the cast reflects runtime reality. See src/middleware/validate.ts.
    const currency = req.params.currency as string;
    const rate     = await getRate(db, currency);
    fxRateGauge.set({ currency: rate.target, provider: rate.provider }, rate.mid_rate);
    res.json({ current: rate, recent: getRateHistory(db, currency, 10) });
  });

  // Admin — backups
  apiV1.get("/admin/backups", (_req, res) => {
    res.json({ failover: backupManager.getFailoverState(), manifests: backupManager.getManifestHistory() });
  });

  apiV1.post("/admin/backups", validate({ body: AdminBackupBody }), async (_req, res) => {
    const manifest = await backupManager.runBackup();
    backupSizeGauge.set(manifest.size_bytes);
    res.status(manifest.status === "success" ? 201 : 207).json(manifest);
  });

  // Admin — queue (Phase 11)
  apiV1.get("/admin/queue", (_req, res) => {
    res.json({ stats: queue.getStats(), dead_letter: queue.getDeadLetterQueue(20) });
  });

  // Admin — access metrics (Phase 12 Roles)
  apiV1.get("/admin/access-metrics",
    requireBusinessPlane(["global_super_admin", "platform_auditor"]),
    (req, res, next) => getAccessMetricsHandler(req, res).catch(next)
  );

  apiV1.post("/admin/queue/enqueue", validate({ body: QueueEnqueueBody }), (req, res) => {
    const { type, payload, priority, idempotencyKey } = req.body as {
      type:           Parameters<typeof queue.enqueue>[0]["type"];
      payload:        unknown;
      priority?:      "low" | "normal" | "high" | "critical";
      idempotencyKey?: string;
    };
    const id = queue.enqueue({ type, payload, priority: priority as "normal" | undefined, idempotencyKey });
    res.status(202).json({ job_id: id, message: "Job enqueued" });
  });

  apiV1.post("/admin/queue/retry/:jobId", validate({ params: QueueJobParams }), (req, res) => {
    // See FX handler above for cast rationale (Express 5 req.params typing).
    const jobId   = req.params.jobId as string;
    const retried = queue.retryDead(jobId);
    res.json({ retried, job_id: jobId });
  });

  apiV1.get("/admin/queue/job/:jobId", validate({ params: QueueJobParams }), (req, res) => {
    const jobId = req.params.jobId as string;
    const job   = queue.getJob(jobId);
    if (!job) throw AppError.notFound("Job not found");
    res.json(job);
  });

  // Admin — receipts (Phase 11)
  apiV1.get("/admin/receipts", (req, res) => {
    const { getReceiptLog, ensureReceiptLogTable } = require("./services/taxReceipt");
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    if (!tenantId) throw AppError.badRequest("X-Tenant-ID header is required");
    ensureReceiptLogTable(db);
    res.json({ data: getReceiptLog(db, tenantId) });
  });

  apiV1.post("/admin/receipts/bulk-statement", validate({ body: BulkStatementBody }), async (req, res) => {
    const { generateBulkStatement, buildBulkStatementFromDB } = await import("./services/taxReceipt");
    const { tenantId, countryCode, periodStart, periodEnd } = req.body as {
      tenantId: string; countryCode: string; periodStart: string; periodEnd: string;
    };
    const stmt = buildBulkStatementFromDB(db, tenantId, countryCode, periodStart, periodEnd);
    if (!stmt) throw AppError.notFound("No WHT payouts found for the specified period and country");
    const result = await generateBulkStatement(db, stmt);
    res.status(201).json(result);
  });

  // ── Phase 14: Compliance endpoints now read from regulatory_frameworks ──
  // The old ./config/industryProfiles and ./config/countryRequirements modules
  // are retired. These endpoints preserve the public response shape so existing
  // clients keep working, but now resolve frameworks from the database.

  apiV1.get("/compliance/profiles", (_req, res) => {
    const rows = db.prepare(`
      SELECT
        framework_code AS id,
        framework_name AS display_name,
        version
      FROM regulatory_frameworks
      WHERE is_active = 1
      ORDER BY framework_name ASC
    `).all();
    res.json(rows);
  });

  apiV1.get("/compliance/countries", (_req, res) => {
    const rows = db.prepare(`
      SELECT
        region_code AS country_code,
        region_name AS country_name,
        framework_code,
        framework_name,
        regulator_name AS regulator,
        version,
        effective_date,
        metadata
      FROM regulatory_frameworks
      WHERE is_active = 1
      ORDER BY region_name ASC
    `).all() as Array<{
      country_code: string;
      country_name: string;
      framework_code: string;
      framework_name: string;
      regulator: string | null;
      version: string;
      effective_date: string | null;
      metadata: string;
    }>;

    const data = rows.map((r) => {
      let meta: Record<string, unknown> = {};
      try { meta = r.metadata ? JSON.parse(r.metadata) : {}; } catch { /* swallow */ }
      return {
        country_code:   r.country_code,
        country_name:   r.country_name,
        framework_code: r.framework_code,
        framework_name: r.framework_name,
        regulator:      r.regulator,
        version:        r.version,
        effective_date: r.effective_date,
        // Surface common metadata keys when present so legacy clients see them.
        local_currency:       meta.local_currency       ?? null,
        min_kyc_tier:         meta.min_kyc_tier         ?? null,
        withholding_tax_rate: meta.withholding_tax_rate ?? null,
        supported_methods:    meta.supported_methods    ?? [],
      };
    });

    res.json({ data, total: data.length });
  });

  // Notification test (Phase 11) — POST /api/v1/admin/notify/test
  apiV1.post("/admin/notify/test", validate({ body: NotifyTestBody }), async (req, res) => {
    const { notifyIncident } = await import("./services/notifications");
    const tenantId = (req.headers["x-tenant-id"] as string) ?? "test-tenant";
    // type / severity unions are sourced from notifications.ts (the producer).
    // The previous inline literals included values ("anomaly_low",
    // "anomaly_medium", "low", "medium") that are NOT in IncidentType /
    // IncidentSeverity. notifyIncident did SEVERITY_ORDER[unknown] >= min,
    // which returned false, silently dropping the notification — making the
    // test endpoint appear to succeed while doing nothing. NotifyTestBody
    // (Zod schema) is the runtime gate; this type assertion is just the
    // compile-time match. Audit NotifyTestBody if you change these unions.
    const b = req.body as {
      type?:        IncidentType;
      severity?:    IncidentSeverity;
      title?:       string;
      description?: string;
      metadata?:    Record<string, unknown>;
    };
    const log = await notifyIncident({
      type:        b.type     ?? "anomaly_high",
      severity:    b.severity ?? "high",
      tenant_id:   tenantId,
      title:       b.title       ?? "Test Notification",
      description: b.description ?? "This is a test notification fired from the admin API.",
      metadata:    b.metadata    ?? { source: "admin_api", triggered_by: "manual" },
    });
    res.json(log);
  });

  app.use("/api/v1", apiV1);

  // ── Step 11: Prometheus metrics ───────────────────────────────────────────
  app.get("/metrics", metricsHandler);

  // ── Step 12: Health + dashboard ───────────────────────────────────────────
  registerHealthRoutes(app, db, backupManager, startedAt);

  app.get("/dashboard", (_req, res) => {
    res.sendFile(require("path").resolve("public/index.html"));
  });

  app.get("/register", (_req, res) => {
    res.sendFile(require("path").resolve("public/register.html"));
  });

  // ── Step 13: 404 ──────────────────────────────────────────────────────────
  // Funnel unmatched routes through the same error pipeline as everything else,
  // so the response shape (error/code/request_id) stays consistent.
  app.use((_req, _res, next) => { next(AppError.notFound("Not Found")); });

  // ── Step 14: Global error handler ────────────────────────────────────────
  // Replaced by src/middleware/error-handler.ts (slice 2). Sanitization is
  // gated on NODE_ENV and app.locals.exposeErrors — see that module.
  app.use(errorHandler);

  return { app, db, backupManager, monitor, stopCron };
}

// ─── Server Bootstrap ─────────────────────────────────────────────────────────

export function startServer(ctx: AppContext): void {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  const server = ctx.app.listen(port, host, () => {
    pinoLogger.info(
      { host, port, env: process.env.NODE_ENV ?? "development" },
      "CaaS-Lite listening",
    );
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout   = 66_000;

  // Slice 3: graceful shutdown is now centralized in src/lib/shutdown.ts.
  // Teardown order: HTTP → cron → queue → WAL checkpoint → DB.
  // See that module for the rationale on ordering and signal handling.
  installShutdownHandlers({
    server,
    stopCron:  ctx.stopCron,
    stopQueue: () => getQueue().stop(),
    db:        ctx.db,
  });
}
