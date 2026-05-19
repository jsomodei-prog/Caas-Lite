/**
 * src/routes/pilot-ingest.ts
 * Phase 15 — Listen Mode ingest endpoint for the client SDK.
 *
 * Endpoints (API-key authenticated, NOT JWT):
 *   POST  /api/v1/pilot/decisions       record one decision (or batch of <= 50)
 *   GET   /api/v1/pilot/decisions       list recent decisions for the account
 *
 * Auth model:
 *   - Header: Authorization: Bearer caas_<64hex>
 *   - Middleware looks up account by api_key_prefix (first 12 chars), then
 *     verifies sha256(raw) === api_key_hash. Constant-time compare.
 *   - On success, req.account is populated; on failure, 401.
 *
 * Latency contract (per spec):
 *   - Handler does shape validation + single INSERT + return 202.
 *   - No synchronous policy evaluation, no anomaly scoring, no downstream
 *     calls. Async processing (which writes processed_at) is a separate
 *     job — TODO(phase15).
 *
 * TODO(phase15): factor the API-key middleware to src/middleware/apiKeyAuth.ts
 *   once the badge route also needs it.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import type { AccountTier, AccountStatus } from "./provisioning";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AccountAuthRow {
  id:             string;
  tenant_id:      string;
  tier:           AccountTier;
  status:         AccountStatus;
  api_key_hash:   string;
}

interface DecisionPayload {
  client_decision_id?: string;
  decision_class?:     string;
  risk_score?:         number;
  payload?:            Record<string, unknown>;
}

// Extend Express Request with the authenticated account, set by middleware.
declare module "express-serve-static-core" {
  interface Request {
    account?: AccountAuthRow;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 8_192;   // 8KB hard cap per decision
const MAX_BATCH_SIZE    = 50;
const API_KEY_PREFIX_LEN = 12;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDb(req: Request): DB {
  return (req.app.locals as { db: DB }).db;
}

/**
 * Constant-time comparison of two hex strings. Falls back to false on
 * length mismatch (which itself short-circuits — but the caller should
 * never compare hashes of different lengths in practice).
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ─── API Key Middleware ───────────────────────────────────────────────────────

/**
 * Validates Authorization: Bearer caas_<64hex>. On success attaches
 * req.account; on failure returns 401 with a generic message (no leak
 * about whether the prefix was found vs the hash mismatched).
 */
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? "";
  const match  = /^Bearer\s+(caas_[a-f0-9]{64})$/i.exec(header);

  if (!match) {
    res.status(401).json({ error: "Missing or malformed API key" });
    return;
  }
  const rawKey = match[1];
  const prefix = rawKey.slice(0, API_KEY_PREFIX_LEN);
  const hash   = crypto.createHash("sha256").update(rawKey).digest("hex");

  const account = getDb(req)
    .prepare(`
      SELECT id, tenant_id, tier, status, api_key_hash
      FROM accounts
      WHERE api_key_prefix = ?
    `)
    .get(prefix) as AccountAuthRow | undefined;

  if (!account || !safeEqual(account.api_key_hash, hash)) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }
  if (account.status === "suspended" || account.status === "churned") {
    res.status(403).json({ error: `Account ${account.status}` });
    return;
  }

  req.account = account;
  next();
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/pilot/decisions
 * Body: single DecisionPayload OR { decisions: DecisionPayload[] } (batch).
 * Returns 202 on success — the SDK does not wait for downstream processing.
 */
async function ingestDecisions(req: Request, res: Response): Promise<void> {
  const account = req.account!;
  const db      = getDb(req);
  const now     = new Date().toISOString();

  // Normalize single vs batch into an array
  const body = req.body as DecisionPayload | { decisions?: DecisionPayload[] };
  const decisions: DecisionPayload[] = Array.isArray((body as { decisions?: unknown[] }).decisions)
    ? (body as { decisions: DecisionPayload[] }).decisions
    : [body as DecisionPayload];

  if (decisions.length === 0) {
    res.status(400).json({ error: "No decisions in request body" });
    return;
  }
  if (decisions.length > MAX_BATCH_SIZE) {
    res.status(413).json({
      error: `Batch too large (max ${MAX_BATCH_SIZE})`,
      received: decisions.length,
    });
    return;
  }

  // Validate each entry before any writes so we don't half-commit a batch.
  for (const [i, d] of decisions.entries()) {
    const payloadStr = JSON.stringify(d.payload ?? {});
    if (Buffer.byteLength(payloadStr, "utf-8") > MAX_PAYLOAD_BYTES) {
      res.status(413).json({
        error: `decisions[${i}].payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
      });
      return;
    }
    if (d.risk_score !== undefined && (typeof d.risk_score !== "number" || !Number.isFinite(d.risk_score))) {
      res.status(400).json({ error: `decisions[${i}].risk_score must be a finite number` });
      return;
    }
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? null;
  const ua = req.headers["user-agent"] ?? null;

  const insert = db.prepare(`
    INSERT INTO pilot_decisions (
      id, tenant_id, account_id,
      client_decision_id, decision_class, risk_score,
      decision_payload, payload_hash,
      ip_address, user_agent, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertedIds: string[] = [];
  db.transaction(() => {
    for (const d of decisions) {
      const id          = crypto.randomUUID();
      const payloadStr  = JSON.stringify(d.payload ?? {});
      const payloadHash = crypto.createHash("sha256")
        .update(account.tenant_id + payloadStr)
        .digest("hex");

      insert.run(
        id, account.tenant_id, account.id,
        d.client_decision_id ?? null,
        d.decision_class     ?? null,
        d.risk_score         ?? null,
        payloadStr, payloadHash,
        ip, ua, now
      );
      insertedIds.push(id);
    }
  })();

  // 202 Accepted: queued for async processing, no result yet.
  res.status(202).json({
    accepted:    insertedIds.length,
    received_at: now,
    ids:         insertedIds,
  });
}

/**
 * GET /api/v1/pilot/decisions?limit=50&since=<iso>
 * Returns decisions for the authenticated account. Strictly tenant-scoped:
 * the API key already binds the request to one account_id.
 */
async function listDecisions(req: Request, res: Response): Promise<void> {
  const account = req.account!;
  const db      = getDb(req);

  const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 500);
  const since = typeof req.query.since === "string" ? req.query.since : null;

  const rows = since
    ? db.prepare(`
        SELECT id, client_decision_id, decision_class, risk_score,
               decision_payload, received_at, processed_at
        FROM pilot_decisions
        WHERE account_id = ? AND received_at > ?
        ORDER BY received_at DESC
        LIMIT ?
      `).all(account.id, since, limit)
    : db.prepare(`
        SELECT id, client_decision_id, decision_class, risk_score,
               decision_payload, received_at, processed_at
        FROM pilot_decisions
        WHERE account_id = ?
        ORDER BY received_at DESC
        LIMIT ?
      `).all(account.id, limit);

  res.json({ data: rows, total: (rows as unknown[]).length });
}

// ─── Router Assembly ──────────────────────────────────────────────────────────

export function createPilotIngestRouter(): Router {
  const router = Router();

  const async_ = (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) =>
      fn(req, res).catch(next);

  router.use(requireApiKey);

  router.post("/decisions", async_(ingestDecisions));
  router.get("/decisions",  async_(listDecisions));

  return router;
}

export default createPilotIngestRouter;
