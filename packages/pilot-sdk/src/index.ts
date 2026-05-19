/**
 * @caas/pilot-sdk
 * CaaS Pilot SDK — Listen Mode shadow ingest client.
 *
 * Source of truth: packages/pilot-sdk/src/index.ts
 *
 * Design contract (Shadow Governance Safety Gate):
 *   1. Never throw into the host process. All errors are swallowed
 *      and routed to an optional onError callback.
 *   2. Never block the host. record() returns synchronously after
 *      enqueueing; the HTTP send happens on a background timer.
 *   3. Bounded memory. The in-memory queue has a hard cap; oldest
 *      entries are dropped (FIFO) when the queue fills.
 *   4. No external dependencies. Pure Node built-ins only — adding
 *      a fetch lib would impose a transitive dep on the host project.
 *
 * Usage:
 *
 *   import { CaaSPilot } from "@caas/pilot-sdk";
 *
 *   const pilot = new CaaSPilot({
 *     apiKey:  process.env.CAAS_API_KEY!,
 *     baseUrl: "https://pilot.caas.example.com",
 *   });
 *
 *   // ... wherever your AI decisions happen ...
 *   pilot.record({
 *     decision_class:     "fraud_score",
 *     risk_score:         0.83,
 *     client_decision_id: txnId,
 *     payload:            { reason: "velocity", flagged_fields: [...] },
 *   });
 *
 *   // On graceful shutdown:
 *   process.on("SIGTERM", async () => { await pilot.flush(); process.exit(0); });
 *
 * TODO(phase15): publish as @caas/pilot-sdk on npm, with a dist build
 * that includes both CJS and ESM. This file is the source of truth.
 */

import http  from "http";
import https from "https";
import { URL } from "url";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PilotDecision {
  client_decision_id?: string;
  decision_class?:     string;
  risk_score?:         number;
  payload?:            Record<string, unknown>;
}

export interface CaaSPilotConfig {
  /** Required. API key issued at account provisioning (caas_<64hex>). */
  apiKey: string;
  /** Required. Base URL of the CaaS pilot endpoint, no trailing slash. */
  baseUrl: string;
  /** Per-request timeout in ms. Default 2000. */
  timeoutMs?: number;
  /** Background flush interval in ms. Default 1000. */
  flushIntervalMs?: number;
  /** Max queue size before oldest entries are dropped. Default 1000. */
  maxQueueSize?: number;
  /** Max decisions sent in a single HTTP request. Default 50. */
  batchSize?: number;
  /** Optional error sink for visibility. Never propagates exceptions. */
  onError?: (err: Error, context: string) => void;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS       = 2000;
const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_MAX_QUEUE_SIZE   = 1000;
const DEFAULT_BATCH_SIZE       = 50;
const SHUTDOWN_FLUSH_BUDGET_MS = 5000;

export class CaaSPilot {
  private readonly apiKey:          string;
  private readonly baseUrl:         string;
  private readonly timeoutMs:       number;
  private readonly flushIntervalMs: number;
  private readonly maxQueueSize:    number;
  private readonly batchSize:       number;
  private readonly onError:         (err: Error, context: string) => void;

  private readonly queue:  PilotDecision[] = [];
  private          timer:  ReturnType<typeof setInterval> | null = null;
  private          stopped = false;

  constructor(config: CaaSPilotConfig) {
    // Validate inputs but never throw — surface to onError and disable
    // the SDK silently. This is the right call: a misconfigured SDK
    // should be invisible to the host, not crash it.
    if (!config.apiKey || !config.baseUrl) {
      this.apiKey  = "";
      this.baseUrl = "";
      this.timeoutMs       = DEFAULT_TIMEOUT_MS;
      this.flushIntervalMs = DEFAULT_FLUSH_INTERVAL_MS;
      this.maxQueueSize    = DEFAULT_MAX_QUEUE_SIZE;
      this.batchSize       = DEFAULT_BATCH_SIZE;
      this.onError = config.onError ?? (() => { /* noop */ });
      this.stopped = true;
      this.onError(
        new Error("CaaSPilot disabled: apiKey and baseUrl are required"),
        "constructor"
      );
      return;
    }

    this.apiKey          = config.apiKey;
    this.baseUrl         = config.baseUrl.replace(/\/+$/, "");
    this.timeoutMs       = config.timeoutMs       ?? DEFAULT_TIMEOUT_MS;
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.maxQueueSize    = config.maxQueueSize    ?? DEFAULT_MAX_QUEUE_SIZE;
    this.batchSize       = config.batchSize       ?? DEFAULT_BATCH_SIZE;
    this.onError         = config.onError         ?? (() => { /* noop */ });

    this.startBackgroundFlush();
  }

  /**
   * Records a decision. Returns synchronously after enqueueing.
   * Never throws.
   */
  record(decision: PilotDecision): void {
    if (this.stopped) return;
    try {
      if (this.queue.length >= this.maxQueueSize) {
        this.queue.shift();  // drop oldest (FIFO)
      }
      this.queue.push(decision);
    } catch (err) {
      this.safeOnError(err, "record");
    }
  }

  /**
   * Drains the queue with a longer time budget. Intended for graceful
   * shutdown (SIGTERM handler). Returns within SHUTDOWN_FLUSH_BUDGET_MS
   * regardless of network state.
   */
  async flush(): Promise<void> {
    if (this.stopped) return;
    const deadline = Date.now() + SHUTDOWN_FLUSH_BUDGET_MS;
    let firstCycle = true;

    // Each flushOnce() can take up to timeoutMs before failing. Don't start
    // a new cycle if it can't complete within the remaining budget — this
    // makes SHUTDOWN_FLUSH_BUDGET_MS a hard ceiling rather than approximate.
    // Always allow at least one cycle, even when timeoutMs >= budget, so
    // queued decisions get one attempt before shutdown.
    while (
      this.queue.length > 0 &&
      (firstCycle || (deadline - Date.now()) > this.timeoutMs)
    ) {
      firstCycle = false;
      await this.flushOnce().catch(err => this.safeOnError(err, "flush"));
    }
    this.stop();
  }

  /**
   * Stops the background timer. Idempotent. Use only when you know
   * the queue is empty or you've called flush() first.
   */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private startBackgroundFlush(): void {
    this.timer = setInterval(() => {
      this.flushOnce().catch(err => this.safeOnError(err, "background_flush"));
    }, this.flushIntervalMs);
    // Don't keep the event loop alive on the host's behalf.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private async flushOnce(): Promise<void> {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.batchSize);

    try {
      await this.postBatch(batch);
    } catch (err) {
      // Re-queue at the front so retry order is preserved. If the queue
      // is now over capacity, the oldest get dropped — same FIFO rule.
      this.queue.unshift(...batch);
      while (this.queue.length > this.maxQueueSize) {
        this.queue.shift();
      }
      this.safeOnError(err, "post_batch");
    }
  }

  private postBatch(batch: PilotDecision[]): Promise<void> {
    return new Promise((resolve, reject) => {
      let url: URL;
      try {
        url = new URL(`${this.baseUrl}/api/v1/pilot/decisions`);
      } catch (err) {
        reject(err);
        return;
      }

      const body = JSON.stringify({ decisions: batch });
      const lib  = url.protocol === "https:" ? https : http;

      const req = lib.request(
        {
          method:  "POST",
          hostname: url.hostname,
          port:    url.port || (url.protocol === "https:" ? 443 : 80),
          path:    url.pathname + url.search,
          headers: {
            "Content-Type":   "application/json",
            "Content-Length": Buffer.byteLength(body),
            "Authorization":  `Bearer ${this.apiKey}`,
          },
          timeout: this.timeoutMs,
        },
        (resp) => {
          // Drain the response so the socket can be reused / closed.
          resp.on("data", () => { /* discard */ });
          resp.on("end", () => {
            if (resp.statusCode && resp.statusCode >= 200 && resp.statusCode < 300) {
              resolve();
            } else {
              reject(new Error(`Ingest failed: HTTP ${resp.statusCode}`));
            }
          });
        }
      );

      req.on("timeout", () => {
        req.destroy(new Error(`Ingest timed out after ${this.timeoutMs}ms`));
      });
      req.on("error", (err) => reject(err));

      req.write(body);
      req.end();
    });
  }

  private safeOnError(err: unknown, context: string): void {
    try {
      const e = err instanceof Error ? err : new Error(String(err));
      this.onError(e, context);
    } catch {
      // Even the error handler is allowed to fail without disrupting
      // the host process. There is no further fallback.
    }
  }
}

export default CaaSPilot;
