/**
 * src/lib/shutdown.ts
 *
 * Centralized shutdown orchestrator.
 *
 * Design notes (slice 3):
 *   - Teardown order matters because some components write to others during
 *     stop. Correct order is:
 *
 *       1. HTTP server  — refuse new connections, drain in-flight requests
 *       2. Cron         — stop scheduling new jobs (existing handlers complete)
 *       3. Queue        — drain in-flight jobs, flush state (may write to DB)
 *       4. WAL checkpoint — collapse the WAL so next boot starts clean
 *       5. Database     — close last; everything above may write
 *
 *     The previous inline shutdown in app.ts ran queue.stop() BEFORE stopCron().
 *     If a cron tick fires between those two calls, it enqueues a job into an
 *     already-stopped queue. We fix the ordering here.
 *
 *   - HTTP draining: Express 5's server.close() refuses new connections and
 *     resolves only when all in-flight requests finish. The 15-second forced
 *     exit is a backstop — if a handler is genuinely stuck, we'd rather lose
 *     it than wedge the process.
 *
 *   - Signal handling is once-only: a second SIGTERM during shutdown should
 *     not start a parallel teardown. We track state with `shuttingDown`.
 *
 *   - uncaughtException / unhandledRejection are wired here too, mirroring
 *     the previous behavior. Slice 6 review: consider whether unhandledRejection
 *     should still shut down the process or just be logged loudly. Node's
 *     default in v20+ is to crash; we preserve that. Flag for revisit.
 */

import type { Server } from "http";
import type { Database as DB } from "better-sqlite3";
import type { Logger } from "pino";

import { childLogger, logError } from "./pino";

export interface ShutdownDeps {
  server: Server;
  stopCron: () => void;
  /** Returns a promise that resolves once the queue has flushed. */
  stopQueue: () => Promise<void>;
  db: DB;
}

const FORCE_EXIT_TIMEOUT_MS = 15_000;

let shuttingDown = false;

export function installShutdownHandlers(deps: ShutdownDeps): void {
  const log: Logger = childLogger("shutdown");

  async function shutdown(signal: string, exitCode = 0): Promise<void> {
    if (shuttingDown) {
      log.warn({ signal }, "shutdown already in progress — ignoring duplicate signal");
      return;
    }
    shuttingDown = true;
    log.info({ signal }, "shutdown initiated");

    // Backstop: if any stage hangs, force exit so we don't wedge under an
    // orchestrator that's already moved on (k8s SIGKILL grace window, etc.).
    const forceTimer = setTimeout(() => {
      log.error({ timeoutMs: FORCE_EXIT_TIMEOUT_MS }, "graceful shutdown timed out — forcing exit");
      process.exit(1);
    }, FORCE_EXIT_TIMEOUT_MS);
    // Don't let this timer itself keep the event loop alive past a normal exit.
    forceTimer.unref();

    try {
      // ── 1. HTTP — stop accepting new connections, drain in-flight ──────────
      await new Promise<void>((resolve) => {
        deps.server.close((err) => {
          if (err) logError(log, "http server close errored (continuing)", err);
          else    log.info("http server closed");
          resolve();
        });
      });

      // ── 2. Cron — no new ticks. Synchronous, no flush required. ────────────
      try {
        deps.stopCron();
        log.info("cron stopped");
      } catch (err) {
        logError(log, "cron stop errored (continuing)", err);
      }

      // ── 3. Queue — drain in-flight jobs, flush state to DB. ────────────────
      try {
        await deps.stopQueue();
        log.info("queue stopped");
      } catch (err) {
        logError(log, "queue stop errored (continuing)", err);
      }

      // ── 4. WAL checkpoint — collapse the WAL so next boot is clean. ───────
      // SQLite-specific; safe to call even if WAL is empty. We TRUNCATE
      // instead of PASSIVE so the WAL file is reset to zero length.
      try {
        const result = deps.db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[];
        log.info({ checkpoint: result[0] }, "wal checkpoint complete");
      } catch (err) {
        logError(log, "wal checkpoint errored (continuing)", err);
      }

      // ── 5. Database — close last. Everything above may have written. ──────
      try {
        deps.db.close();
        log.info("database closed");
      } catch (err) {
        logError(log, "database close errored (continuing)", err);
      }

      log.info({ exitCode }, "shutdown complete");
      clearTimeout(forceTimer);
      // process.exitCode rather than process.exit so any pending stdout from
      // pino's async writes can flush before Node tears down.
      process.exitCode = exitCode;
    } catch (err) {
      logError(log, "shutdown encountered unexpected error", err);
      clearTimeout(forceTimer);
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
  process.on("SIGINT",  () => { void shutdown("SIGINT"); });

  process.on("uncaughtException", (err) => {
    logError(log, "uncaught exception — initiating shutdown", err);
    void shutdown("uncaughtException", 1);
  });

  process.on("unhandledRejection", (reason) => {
    logError(log, "unhandled rejection — initiating shutdown", reason);
    void shutdown("unhandledRejection", 1);
  });
}
