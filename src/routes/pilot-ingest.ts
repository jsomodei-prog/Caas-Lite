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
 * Phase 15 slice 7:
 *   - DecisionPayloadSchema / IngestDecisionsBody / ListDecisionsQuery
 *     schemas applied via validate() middleware at mount time.
 *   - IngestDecisionsBody is a z.union of the single-vs-batch shapes.
 *     Per the enumeration doc NOTE 2, the schema enforces shape only;
 *     the `Array.isArray(body.decisions) ? batch : [single]` normalization
 *     stays in the handler so the handler sees req.body in its declared
 *     form.
 *
 * ⚠ CRITICAL — 413 SEMANTICS PRESERVED INLINE:
 *   Two inline checks are RETAINED on POST /decisions and must NOT be
 *   migrated into the schema:
 *
 *     1. Batch size cap (decisions.length > 50 → 413). Schema does NOT
 *        include `.max(50)` on the batch array. The 413 status carries
 *        client retry semantics distinct from 400: clients receiving
 *        413 should split-and-retry the batch, clients receiving 400
 *        should debug their payload structure. A schema `.max(50)`
 *        would emit 400 via validate(), conflating these contracts.
 *
 *     2. Per-payload byte cap (JSON.stringify(d.payload).byteLength
 *        > 8192 → 413). Not cleanly expressible in Zod (would require
 *        a .refine() that does the same byte-counting work). The 413
 *        semantics carry the same split-and-retry signal — a 30KB
 *        payload is one decision the client needs to trim, not a
 *        malformed request.
 *
 *   The slice 7 enumeration doc (Appendix C, "Schema vs. inline
 *   placement decisions") flags this as the highest-priority
 *   preservation in this file. Any future PR that tries to "simplify"
 *   by moving the cap into the schema is wrong — push back.
 *
 *   The `risk_score must be finite` check (formerly inline) IS absorbed
 *   by the schema's `z.number().finite()`. That one was 400 in both
 *   the legacy and slice 7 paths, so the migration is clean.
 *
 * Union-shape error UX note:
 *   `z.union([single, batch])` produces error messages that list both
 *   branch failures when a payload matches neither shape (e.g.
 *   `{decisions: "not-an-array"}`). A `z.discriminatedUnion` would be
 *   cleaner but requires a literal discriminator field, which the
 *   request shape doesn't have. Accepted error-UX cost.
 *
 * BEHAVIOR CHANGES from slice 7 (intentional):
 *   - POST /decisions: unknown top-level fields in single mode were
 *     silently ignored → now 400 (.strict() on DecisionPayloadSchema).
 *     Most relevant for SDK clients that historically sent debug flags
 *     or metadata fields outside the documented shape.
 *   - POST /decisions: unknown top-level fields in batch mode (anything
 *     other than `decisions`) → now 400 (.strict() on the batch wrapper).
 *   - GET /decisions: limit=<garbage> was parseInt→NaN→`|| 50`→50
 *     (silently masking bad input) → now 400. Per Appendix C tightening
 *     rationale: silent fallback hides client bugs.
 *   - GET /decisions: limit=0 was parseInt(0)→0→`|| 50`→50 (silently
 *     replaced with default) → now 400 (.min(1)). Behavior is now
 *     "0 is a client error" rather than "0 means 50."
 *   - GET /decisions: since=<malformed> was passed verbatim to SQL where
 *     it happened to work for ISO 8601 but mis-filtered garbage → now
 *     400 via z.string().datetime(). ⚠ Same caveat as insurance.ts
 *     coverage_ends_at: if fixtures use date-only "YYYY-MM-DD" form,
 *     this will 400 — switch to a regex .refine() in that case.
 *
 * NO BEHAVIOR CHANGES for:
 *   - requireApiKey middleware: prefix-vs-hash distinction is still
 *     collapsed into a single 401 to prevent api_key enumeration. The
 *     constant-time SHA-256 compare, the suspended/churned 403, and
 *     the {Authorization: Bearer caas_<64hex>} regex are byte-identical.
 *   - 413 batch size cap and 413 per-payload byte cap (see CRITICAL above).
 *   - Empty single-mode object `{}` is still accepted as "one decision"
 *     and inserted as a row with all NULL optional fields. (Schema's
 *     all-optional `DecisionPayloadSchema` matches {} the same way the
 *     legacy `[body as DecisionPayload]` wrap did.)
 *   - The atomic db.transaction() batch INSERT — half-commit prevention.
 *   - payload_hash SHA-256 fingerprinting (tenant_id-salted).
 *   - ip / user_agent capture from req.
 *   - 202 Accepted contract (latency-critical: NO synchronous downstream
 *     work added; the schema runs in-process and is sub-millisecond).
 *
 * Pre-merge checks the implementation session should run:
 *   - npm test (all 143 existing tests must stay green)
 *   - ⚠ Especially check any /decisions test that sends extra body fields:
 *     `.strict()` will 400 them. The fix is the fixture, not loosening
 *     the schema.
 *   - Check any GET /decisions test that sends `?limit=0` and expects
 *     the default 50; the new behavior is 400.
 *   - Check `?since=` fixtures use RFC 3339 form
 *     (e.g. "2026-06-01T00:00:00Z"), not date-only "2026-06-01".
 *   - Verify the 413 contract: a batch of 51 decisions must still return
 *     413, NOT 400. If a test asserts 400 on oversize batch, that test
 *     was wrong before slice 7 — fix the assertion.
 *
 * TODO(phase15): factor the API-key middleware to src/middleware/apiKeyAuth.ts
 *   once the badge route also needs it.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import crypto from "crypto";
import type { Database as DB } from "better-sqlite3";
import { validate } from "../middleware/validate";
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

// ─── Schemas ──────────────────────────────────────────────────────────────────

/**
 * Schema for a single DecisionPayload.
 *
 * All fields optional — this matches the current handler, which inserts
 * NULL for any absent optional. The empty-object `{}` case is therefore
 * a valid (if minimally informative) single-mode payload.
 *
 * `payload`: z.record(z.unknown()) is INTENTIONAL, not a placeholder.
 * The field is designed to accept arbitrary client-supplied JSON for
 * later analytics — schema enforcement of its inner shape would defeat
 * the purpose. The 8KB byte cap on the serialized form stays inline
 * (see ingestDecisions handler) because Zod can't express byte-counted
 * limits without a .refine() that does the same work the inline check
 * already does.
 *
 * `risk_score`: .finite() rejects NaN, ±Infinity. This is the only
 * inline 400 check from the legacy handler that the schema absorbs —
 * the others (batch size 413, payload bytes 413) stay inline because
 * of the 413 semantic, not because they can't be schemed.
 */
const DecisionPayloadSchema = z.object({
  client_decision_id: z.string().min(1).optional(),
  decision_class:     z.string().min(1).optional(),
  risk_score:         z.number().finite().optional(),
  payload:            z.record(z.unknown()).optional(),
}).strict();

/**
 * Body schema for POST /decisions.
 *
 * Union of single-vs-batch shapes. The schema enforces "one of the two
 * shapes was sent" — full stop. The Array.isArray normalization stays
 * in the handler.
 *
 * ⚠ NO `.max(50)` on the batch array. The 50-batch cap returns 413,
 * not 400, and stays inline. See file header "CRITICAL — 413 SEMANTICS
 * PRESERVED INLINE" for the full rationale; do not migrate.
 *
 * `.min(1)` on the batch array IS in the schema — an explicit empty
 * batch `{decisions: []}` is a malformed request (400), not a "too
 * large" case (413). The single-mode `{}` empty-object case is
 * separately handled by DecisionPayloadSchema's all-optional shape.
 */
const IngestDecisionsBody = z.union([
  DecisionPayloadSchema,
  z.object({
    decisions: z.array(DecisionPayloadSchema).min(1),
  }).strict(),
]);

/**
 * Query schema for GET /decisions.
 *
 * - limit: BEHAVIOR CHANGE — was `parseInt(...) || 50` then `Math.min(..., 500)`.
 *   That idiom silently replaced 0 and NaN with 50, masking caller bugs.
 *   Schema's .int().min(1).max(500).default(50) rejects 0 and garbage
 *   with 400; .default(50) preserves the documented omitted-param case.
 *
 * - since: BEHAVIOR CHANGE — z.string().datetime() enforces RFC 3339 /
 *   ISO 8601. The legacy handler passed any string straight to the SQL
 *   `received_at > ?` comparator; SQLite's lexicographic comparison
 *   happens to work for ISO 8601 strings but silently mis-filters
 *   garbage. ⚠ Same caveat as insurance.ts coverage_ends_at: if
 *   fixtures send date-only "YYYY-MM-DD", this 400s — switch to a
 *   regex .refine() in that case.
 */
const ListDecisionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  since: z.string().datetime().optional(),
}).strict();

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
 *
 * After validate({ body: IngestDecisionsBody }):
 *   - The body is one of the two declared shapes (single object, or
 *     {decisions: [...]} with at least one entry).
 *   - All per-field shape checks (risk_score finite, payload as record,
 *     ids/classes as non-empty strings) are absorbed.
 *
 * The 413 batch-size cap and 413 per-payload-byte cap stay inline —
 * see file header "CRITICAL — 413 SEMANTICS PRESERVED INLINE".
 */
async function ingestDecisions(req: Request, res: Response): Promise<void> {
  const account = req.account!;
  const db      = getDb(req);
  const now     = new Date().toISOString();

  // Normalize single vs batch into an array. Per enumeration doc NOTE 2,
  // the schema enforces shape only; this normalization is the handler's
  // job. The cast is to the inferred union type from the schema.
  const body = req.body as z.infer<typeof IngestDecisionsBody>;
  const decisions: DecisionPayload[] = "decisions" in body && Array.isArray(body.decisions)
    ? body.decisions
    : [body as DecisionPayload];

  // ⚠ INLINE 413 — DO NOT MIGRATE TO SCHEMA. See file header.
  // Schema's batch min(1) covers the empty-batch 400 case; this is
  // the upper-bound 413 case with split-and-retry client semantics.
  if (decisions.length > MAX_BATCH_SIZE) {
    res.status(413).json({
      error: `Batch too large (max ${MAX_BATCH_SIZE})`,
      received: decisions.length,
    });
    return;
  }

  // ⚠ INLINE 413 — DO NOT MIGRATE TO SCHEMA. See file header.
  // Per-payload byte cap. The risk_score finite check that used to
  // live in this loop is now absorbed by the schema's .finite().
  for (const [i, d] of decisions.entries()) {
    const payloadStr = JSON.stringify(d.payload ?? {});
    if (Buffer.byteLength(payloadStr, "utf-8") > MAX_PAYLOAD_BYTES) {
      res.status(413).json({
        error: `decisions[${i}].payload exceeds ${MAX_PAYLOAD_BYTES} bytes`,
      });
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
 *
 * After validate({ query: ListDecisionsQuery }):
 *   - limit is a clamped int (1..500) with default 50. The legacy
 *     `parseInt(...) || 50` silently-replace-on-bad-input footgun is gone.
 *   - since, if present, is a validated RFC 3339 datetime string. If
 *     absent, the unfiltered SELECT path is used.
 */
async function listDecisions(req: Request, res: Response): Promise<void> {
  const account = req.account!;
  const db      = getDb(req);

  const { limit, since } =
    req.query as unknown as z.infer<typeof ListDecisionsQuery>;

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

  // Ordering: requireApiKey (router-level) → validate → async_(handler).
  // requireApiKey runs first so an unauthenticated caller sending a
  // malformed body gets 401, not 400 — consistent with the slice 7
  // ordering pattern (requireAccessToken → requireRole → validate).
  router.post("/decisions", validate({ body:  IngestDecisionsBody }),  async_(ingestDecisions));
  router.get("/decisions",  validate({ query: ListDecisionsQuery }),   async_(listDecisions));

  return router;
}

// Exported for tests that want to assert the schemas directly without
// constructing an Express request. DecisionPayloadSchema is exported
// alongside IngestDecisionsBody because the union shape makes direct
// per-decision testing useful (e.g. "verify a single risk_score=NaN
// payload fails before the union wrapping").
export {
  DecisionPayloadSchema,
  IngestDecisionsBody,
  ListDecisionsQuery,
};

export default createPilotIngestRouter;
