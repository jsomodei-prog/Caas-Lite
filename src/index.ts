/**
 * index.ts — CaaS Lite platform entry point (Phase 5.1)
 *
 * New in Phase 5.1:
 *   - Metering: extracts X-Client-Id from webhook requests
 *   - Calls evidenceDb.incrementMeter(clientId, 'runs') after every
 *     successful verification so every run is accurately billed
 *
 * Carried forward from Phase 4:
 *   - API key authentication on /api/evidence and /dashboard
 *   - Alert forwarding via HTTP POST to ALERT_FORWARD_URL
 *   - Policy hot-reload via PolicyEngine.watch()
 */

import "dotenv/config";

import * as http from "http";
import * as fs   from "fs";
import * as path from "path";
import { PolicyEngine }      from "./engine/policy";
import { VerificationEngine } from "./engine/verification";
import { WebhookReceiver }   from "./webhook/receiver";
import { EvidenceDb }        from "./evidenceDb";
import { logger }            from "./lib/logger";

const PORT              = parseInt(process.env["PORT"] ?? "3000", 10);
const HEADER_API_KEY    = process.env["HEADER_API_KEY"]    ?? "";
const ALERT_FORWARD_URL = process.env["ALERT_FORWARD_URL"] ?? "";

/** Fallback client ID used when the caller omits X-Client-Id. */
const DEFAULT_CLIENT_ID = "default_client";

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!HEADER_API_KEY) {
    logger.warn("caas-lite: HEADER_API_KEY not set — protected endpoints are open");
    return true;
  }
  const provided = req.headers["x-api-key"];
  return provided === HEADER_API_KEY;
}

function rejectUnauthorized(res: http.ServerResponse): void {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized — valid X-Api-Key header required" }));
}

// ---------------------------------------------------------------------------
// Client ID extraction (Phase 5.1)
// ---------------------------------------------------------------------------

/**
 * Extracts the billing client ID from the request.
 * Reads X-Client-Id header; falls back to DEFAULT_CLIENT_ID if absent.
 * Always returns a non-empty string — safe to pass directly to incrementMeter().
 */
function extractClientId(req: http.IncomingMessage): string {
  const raw = req.headers["x-client-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (typeof value === "string" && value.trim().length > 0)
    ? value.trim()
    : DEFAULT_CLIENT_ID;
}

// ---------------------------------------------------------------------------
// Alert forwarder (Phase 4)
// ---------------------------------------------------------------------------

async function forwardAlert(batch: unknown): Promise<void> {
  if (!ALERT_FORWARD_URL) return;

  try {
    const { default: https } = await import("https");
    const { default: http }  = await import("http");

    const payload = Buffer.from(JSON.stringify({
      source:    "caas-lite",
      timestamp: new Date().toISOString(),
      batch,
    }));

    const url    = new URL(ALERT_FORWARD_URL);
    const client = url.protocol === "https:" ? https : http;

    await new Promise<void>((resolve, reject) => {
      const req = client.request(
        {
          hostname: url.hostname,
          port:     url.port || (url.protocol === "https:" ? 443 : 80),
          path:     url.pathname + url.search,
          method:   "POST",
          headers:  {
            "Content-Type":   "application/json",
            "Content-Length": payload.length,
            "X-Source":       "caas-lite",
          },
        },
        (res) => {
          res.resume();
          logger.info("caas-lite: alert forwarded", {
            url:    ALERT_FORWARD_URL,
            status: res.statusCode,
          });
          resolve();
        }
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  } catch (e) {
    logger.error("caas-lite: alert forward failed", { error: (e as Error).message });
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info("caas-lite: starting up");

  const evidenceDb = new EvidenceDb();

  const policyEngine = await PolicyEngine.create();
  logger.info("caas-lite: policy engine ready", { policies: policyEngine.size });

  policyEngine.watch();

  const verificationEngine = new VerificationEngine(policyEngine);

  // ---------------------------------------------------------------------------
  // HTTP server — webhook ingestion, API, dashboard
  // ---------------------------------------------------------------------------

  const server = http.createServer((req, res) => {

    // ── GET /api/evidence  (protected) ────────────────────────────────────────
    if (req.method === "GET" && req.url === "/api/evidence") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      try {
        const rows   = evidenceDb.getHistory(50);
        const parsed = rows.map((r) => ({
          id:        r.id,
          timestamp: r.timestamp,
          batch:     JSON.parse(r.batchData),
        }));
        res.writeHead(200, {
          "Content-Type":                "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(parsed));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    // ── GET /api/meters  (protected) — Phase 5.1 billing dashboard ────────────
    if (req.method === "GET" && req.url === "/api/meters") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      try {
        const meters = evidenceDb.getAllMeters();
        res.writeHead(200, {
          "Content-Type":                "application/json",
          "Access-Control-Allow-Origin": "*",
        });
        res.end(JSON.stringify(meters));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
      return;
    }

    // ── GET /dashboard  (protected) ───────────────────────────────────────────
    if (req.method === "GET" && req.url === "/dashboard") {
      if (!isAuthorized(req)) { rejectUnauthorized(res); return; }
      const dashPath = path.resolve(process.cwd(), "public", "index.html");
      if (!fs.existsSync(dashPath)) {
        res.writeHead(404);
        res.end("Dashboard not found. Create public/index.html.");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(dashPath));
      return;
    }

    // ── POST /webhook — metered ingestion (Phase 5.1) ─────────────────────────
    // Extract client ID before delegating so we can meter the run after
    // verification completes inside onVerified.
    // We attach it to the request object via a lightweight cast so the
    // onVerified callback can read it without coupling receiver.ts to billing.
    (req as http.IncomingMessage & { _clientId?: string })._clientId =
      extractClientId(req);

    void webhookReceiver.handleRequest(req, res);
  });

  // Build receiver after the server so onVerified can close over evidenceDb
  const webhookReceiver = new WebhookReceiver({
    verificationEngine,
    onVerified: async (batch, req) => {
      // ── Phase 5.1: meter the run ────────────────────────────────────────────
      const clientId =
        (req as http.IncomingMessage & { _clientId?: string } | undefined)
          ?._clientId ?? DEFAULT_CLIENT_ID;

      await evidenceDb.incrementMeter(clientId, "runs");

      logger.info("caas-lite: meter incremented", {
        clientId,
        eventId: batch.event.id,
      });

      // ── Phase 2: persist to evidence vault ──────────────────────────────────
      await evidenceDb.append(batch);

      // ── Phase 4: alert forwarding ───────────────────────────────────────────
      if (batch.overallOutcome === "fail" && batch.alerts.length > 0) {
        for (const alert of batch.alerts) {
          logger.warn(
            `[ALERT] Policy Violation Detected for Batch ${batch.event.id}`,
            {
              policyId:  alert.policyId,
              controlId: alert.controlId,
              severity:  alert.severity,
              message:   alert.message,
            }
          );
        }
        void forwardAlert(batch);
      }

      logger.info("caas-lite: batch appended to evidence vault", {
        eventId: batch.event.id,
        outcome: batch.overallOutcome,
        alerts:  batch.alerts.length,
      });
    },
  });

  server.listen(PORT, () => {
    logger.info("caas-lite: webhook receiver listening", { port: PORT });
    logger.info(`caas-lite: dashboard  → http://localhost:${PORT}/dashboard`);
    logger.info(`caas-lite: evidence   → http://localhost:${PORT}/api/evidence`);
    logger.info(`caas-lite: meters     → http://localhost:${PORT}/api/meters`);
  });

  const shutdown = () => {
    logger.info("caas-lite: shutting down");
    policyEngine.stopWatch();
    server.close(() => {
      evidenceDb.close();
      process.exit(0);
    });
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);
}

main().catch((e: unknown) => {
  logger.error("caas-lite: fatal startup error", { error: (e as Error).message });
  process.exit(1);
});
