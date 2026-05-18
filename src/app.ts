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
 *   12. /health + /dashboard endpoints
 *   13. 404 handler
 *   14. Global error handler
 *   15. Graceful-shutdown hooks
 *
 * Phase 12-13 build-out | Commit baseline: cc20b1a
 * Phase 14 update      | Dynamic regulatory ingestion replaces hardcoded compliance profiles.
 */

import "express-async-errors";
import express, { type Express, type Request, type Response, type NextFunction } from "express";
import helmet      from "helmet";
import cors        from "cors";
import compression from "compression";
import * as cron   from "node-cron";
import path        from "path";
import type { Database as DB } from "better-sqlite3";

import { openDatabase }           from "./db/migrate";
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
  const jobs: ReturnType<typeof cron.schedule>[] = [];

  const backupSchedule = process.env.BACKUP_CRON_SCHEDULE ?? "0 2 * * *";

  jobs.push(cron.schedule(backupSchedule, async () => {
    console.info("[cron] Starting scheduled backup...");
    const start = Date.now();
    try {
      const manifest = await backupManager.runBackup();
      backupDurationHistogram.observe({ status: manifest.status }, (Date.now() - start) / 1000);
      backupSizeGauge.set(manifest.size_bytes);
      console.info(`[cron] Backup complete: ${manifest.status} (${(manifest.size_bytes / 1048576).toFixed(2)} MiB)`);
    } catch (err) {
      backupDurationHistogram.observe({ status: "failed" }, (Date.now() - start) / 1000);
      console.error("[cron] Backup failed:", err);
    }
  }, { timezone: "UTC" }));

  jobs.push(cron.schedule("0 * * * *", () => {
    try {
      const result = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[];
      console.debug("[cron] WAL checkpoint:", result[0]);
    } catch (err) { console.error("[cron] WAL checkpoint failed:", err); }
  }, { timezone: "UTC" }));

  jobs.push(cron.schedule("0 3 * * 0", () => {
    try { db.prepare("ANALYZE").run(); console.info("[cron] ANALYZE complete."); }
    catch (err) { console.error("[cron] ANALYZE failed:", err); }
  }, { timezone: "UTC" }));

  jobs.push(cron.schedule("0 1 * * *", () => {
    try {
      const removed = monitor.purgeSlowQueryLog(7);
      console.debug(`[cron] Slow-query log pruned: ${removed} entries.`);
    } catch (err) { console.error("[cron] Slow-query prune failed:", err); }
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
    } catch (err) { console.error("[cron] FX refresh queue failed:", err); }
  }, { timezone: "UTC" }));

  // Phase 11: daily job queue purge (keep 7 days of completed jobs)
  jobs.push(cron.schedule("30 1 * * *", () => {
    try {
      const queue = getQueue();
      const removed = queue.purge(7);
      console.debug(`[cron] Job queue purged: ${removed} completed/dead entries.`);
    } catch (err) { console.error("[cron] Queue purge failed:", err); }
  }, { timezone: "UTC" }));

  console.info(
    `[cron] Scheduled: backup (${backupSchedule} UTC), WAL checkpoint (hourly), ` +
    `ANALYZE (Sunday 03:00 UTC), slow-query prune (daily 01:00 UTC), ` +
    `FX refresh (daily 06:00 UTC), queue purge (daily 01:30 UTC)`
  );

  return () => { for (const job of jobs) job.stop(); };
}

// ─── CORS Configuration ───────────────────────────────────────────────────────

function buildCorsOptions(): cors.CorsOptions {
  const allowedOrigins = (process.env.CORS_ORIGINS ?? "")
    .split(",").map((o) => o.trim()).filter(Boolean);

  if (allowedOrigins.length === 0 && process.env.NODE_ENV === "production") {
    console.warn("[app] CORS_ORIGINS is not set — all origins allowed in dev mode.");
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

function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const { randomUUID } = require("crypto") as typeof import("crypto");
  const id = (req.headers["x-request-id"] as string | undefined) ?? randomUUID();
  req.headers["x-request-id"] = id;
  res.setHeader("X-Request-ID", id);
  next();
}

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
        connectSrc:    ["'self'", "http://127.0.0.1:3000", "http://localhost:3000"],
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
      "/health", "/health/db", "/health/performance", "/metrics",
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
  apiV1.post("/payouts/sweep", async (req, res) => {
    const { runPayoutSweep } = await import("./services/payout");
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    if (!tenantId) { res.status(400).json({ error: "X-Tenant-ID header is required" }); return; }
    const summary = await monitor.track("payout_sweep", () => runPayoutSweep(tenantId, db));
    res.json(summary);
  });

  apiV1.get("/payouts", async (req, res) => {
    const { getPayoutHistory } = await import("./services/payout");
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    if (!tenantId) { res.status(400).json({ error: "X-Tenant-ID header is required" }); return; }
    const limit  = Math.min(parseInt((req.query.limit  as string) ?? "100", 10), 500);
    const offset = parseInt((req.query.offset as string) ?? "0", 10);
    res.json({ data: monitor.track("payout_history", () => getPayoutHistory(db, tenantId, limit, offset)), limit, offset });
  });

  // Anomalies
  apiV1.get("/anomalies", async (req, res) => {
    const { queryAnomalyLogs, getAnomalyStats } = await import("./analytics/anomaly");
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    if (!tenantId) { res.status(400).json({ error: "X-Tenant-ID header is required" }); return; }
    const since = req.query.since as string | undefined;
    res.json({
      stats: monitor.track("anomaly_stats", () => getAnomalyStats(db, tenantId, since)),
      data:  monitor.track("anomaly_logs",  () => queryAnomalyLogs(db, tenantId, {
        risk_level: req.query.risk_level as "low" | "medium" | "high" | "critical" | undefined,
        since,
        limit:  Math.min(parseInt((req.query.limit  as string) ?? "100", 10), 500),
        offset: parseInt((req.query.offset as string) ?? "0", 10),
      })),
    });
  });

  // FX rates
  apiV1.get("/fx/rates/:currency", async (req, res) => {
    const { getRate, getRateHistory } = await import("./services/fx");
    const currency = String(req.params.currency).toUpperCase();
    const rate     = await getRate(db, currency);
    fxRateGauge.set({ currency: rate.target, provider: rate.provider }, rate.mid_rate);
    res.json({ current: rate, recent: getRateHistory(db, currency, 10) });
  });

  // Admin — backups
  apiV1.get("/admin/backups", (_req, res) => {
    res.json({ failover: backupManager.getFailoverState(), manifests: backupManager.getManifestHistory() });
  });

  apiV1.post("/admin/backups", async (_req, res) => {
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

  apiV1.post("/admin/queue/enqueue", (req, res) => {
    const { type, payload, priority, idempotencyKey } = req.body as {
      type: string; payload: unknown; priority?: string; idempotencyKey?: string;
    };
    if (!type || !payload) { res.status(400).json({ error: "type and payload are required" }); return; }
    const id = queue.enqueue({ type: type as Parameters<typeof queue.enqueue>[0]["type"], payload, priority: priority as "normal", idempotencyKey });
    res.status(202).json({ job_id: id, message: "Job enqueued" });
  });

  apiV1.post("/admin/queue/retry/:jobId", (req, res) => {
    const retried = queue.retryDead(req.params.jobId);
    res.json({ retried, job_id: req.params.jobId });
  });

  apiV1.get("/admin/queue/job/:jobId", (req, res) => {
    const job = queue.getJob(req.params.jobId);
    if (!job) { res.status(404).json({ error: "Job not found" }); return; }
    res.json(job);
  });

  // Admin — receipts (Phase 11)
  apiV1.get("/admin/receipts", (req, res) => {
    const { getReceiptLog, ensureReceiptLogTable } = require("./services/taxReceipt");
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    if (!tenantId) { res.status(400).json({ error: "X-Tenant-ID header is required" }); return; }
    ensureReceiptLogTable(db);
    res.json({ data: getReceiptLog(db, tenantId) });
  });

  apiV1.post("/admin/receipts/bulk-statement", async (req, res) => {
    const { generateBulkStatement, buildBulkStatementFromDB } = await import("./services/taxReceipt");
    const { tenantId, countryCode, periodStart, periodEnd } = req.body as {
      tenantId: string; countryCode: string; periodStart: string; periodEnd: string;
    };
    const stmt = buildBulkStatementFromDB(db, tenantId, countryCode, periodStart, periodEnd);
    if (!stmt) { res.status(404).json({ error: "No WHT payouts found for the specified period and country" }); return; }
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
  apiV1.post("/admin/notify/test", async (req, res) => {
    const { notifyIncident } = await import("./services/notifications");
    const tenantId = (req.headers["x-tenant-id"] as string) ?? "test-tenant";
    const log = await notifyIncident({
      type:        "anomaly_high",
      severity:    "high",
      tenant_id:   tenantId,
      title:       "Test Notification",
      description: "This is a test notification fired from the admin API.",
      metadata:    { source: "admin_api", triggered_by: "manual" },
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
  app.use((_req, res) => { res.status(404).json({ error: "Not Found" }); });

  // ── Step 14: Global error handler ────────────────────────────────────────
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    const requestId = req.headers["x-request-id"] as string | undefined;
    console.error(`[app] Unhandled error [${requestId}]:`, err);
    const status =
      (err as { status?: number; statusCode?: number }).status ??
      (err as { status?: number; statusCode?: number }).statusCode ?? 500;
    res.status(status).json({
      error: process.env.NODE_ENV === "production" ? "Internal Server Error" : err.message,
      request_id: requestId,
    });
  });

  return { app, db, backupManager, monitor, stopCron };
}

// ─── Server Bootstrap ─────────────────────────────────────────────────────────

export function startServer(ctx: AppContext): void {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST ?? "0.0.0.0";

  const server = ctx.app.listen(port, host, () => {
    console.info(`[app] CaaS-Lite listening on ${host}:${port} (${process.env.NODE_ENV ?? "development"})`);
  });

  server.keepAliveTimeout = 65_000;
  server.headersTimeout   = 66_000;

  function shutdown(signal: string): void {
    console.info(`[app] ${signal} received — shutting down gracefully...`);
    server.close(async () => {
      console.info("[app] HTTP server closed.");
      await getQueue().stop();
      console.info("[app] Queue stopped.");
      ctx.stopCron();
      console.info("[app] Cron jobs stopped.");
      ctx.db.close();
      console.info("[app] Database closed. Goodbye.");
      process.exit(0);
    });
    setTimeout(() => { console.error("[app] Graceful shutdown timed out — forcing exit."); process.exit(1); }, 15_000);
  }

  process.on("SIGTERM",            () => shutdown("SIGTERM"));
  process.on("SIGINT",             () => shutdown("SIGINT"));
  process.on("uncaughtException",  (err) => { console.error("[app] Uncaught exception:", err); shutdown("uncaughtException"); });
  process.on("unhandledRejection", (r)   => { console.error("[app] Unhandled rejection:", r); shutdown("unhandledRejection"); });
}
