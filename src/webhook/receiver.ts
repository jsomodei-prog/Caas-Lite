/**
 * receiver.ts — CaaS Lite Webhook Receiver
 *
 * Inbound edge of the CaaS Lite platform. Exposes an HTTP server that:
 *   1. Accepts signed POST requests from SaaS integrations
 *   2. Verifies HMAC-SHA256 signatures against WEBHOOK_SECRET
 *   3. Deduplicates events by ID using an in-memory seen-set (swap for Redis in prod)
 *   4. Validates and deserializes the payload into a typed DomainEvent
 *   5. Dispatches the DomainEvent to the VerificationEngine asynchronously
 *   6. Returns 202 Accepted immediately
 *
 * Signature convention (compatible with GitHub, Stripe, Okta webhook styles):
 *   X-CaaS-Signature: sha256=<hex-digest>
 *   X-CaaS-Event-Id:  <uuid-v4>
 *   X-CaaS-Timestamp: <unix-epoch-seconds>
 *
 * Usage:
 *   const receiver = new WebhookReceiver({ verificationEngine, policyEngine });
 *   const server   = receiver.createServer();
 *   server.listen(3000);
 */

import * as http from 'http';
import * as crypto from 'crypto';
import {
  type DomainEvent,
  type DomainEventActor,
  type EventType,
  type Result,
  ok,
  err,
} from '../types/domain';
import { type VerificationEngine } from '../engine/verification';
import { logger } from '../lib/logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum body size accepted (bytes). Prevents memory exhaustion. */
const MAX_BODY_BYTES = 1_048_576; // 1 MiB

/** Reject events whose timestamp deviates more than this from server time. */
const TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

/** How long to keep seen event IDs in the dedup set before pruning (ms). */
const DEDUP_TTL_MS = 10 * 60 * 1_000; // 10 minutes

// ---------------------------------------------------------------------------
// Deduplication store (in-process; replace with Redis for multi-instance)
// ---------------------------------------------------------------------------

interface SeenEntry {
  seenAt: number; // Date.now()
}

class InMemoryDedupStore {
  private readonly store = new Map<string, SeenEntry>();
  private pruneTimer: NodeJS.Timeout | null = null;

  /** Returns true if this is the first time we've seen this ID. */
  checkAndMark(id: string): boolean {
    if (this.store.has(id)) return false;
    this.store.set(id, { seenAt: Date.now() });
    this.schedulePrune();
    return true;
  }

  private schedulePrune(): void {
    if (this.pruneTimer) return;
    this.pruneTimer = setTimeout(() => {
      const cutoff = Date.now() - DEDUP_TTL_MS;
      for (const [id, entry] of this.store.entries()) {
        if (entry.seenAt < cutoff) this.store.delete(id);
      }
      this.pruneTimer = null;
    }, DEDUP_TTL_MS);
    this.pruneTimer.unref(); // Don't keep the process alive for this
  }

  get size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Raw payload shape (what we expect from the HTTP body)
// ---------------------------------------------------------------------------

interface RawWebhookPayload {
  id: string;
  type: string;
  occurredAt: string;
  source: string;
  actor: {
    id: string;
    name: string;
    kind: string;
    ipAddress?: string;
  };
  metadata?: Record<string, unknown>;
  environment?: string;
}

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

function validatePayload(body: unknown): Result<RawWebhookPayload> {
  if (typeof body !== 'object' || body === null) {
    return err(new Error('payload must be a JSON object'));
  }

  const p = body as Record<string, unknown>;

  if (typeof p['id'] !== 'string' || p['id'].trim() === '') {
    return err(new Error('payload.id must be a non-empty string'));
  }
  if (typeof p['type'] !== 'string' || p['type'].trim() === '') {
    return err(new Error('payload.type must be a non-empty string'));
  }
  if (typeof p['occurredAt'] !== 'string') {
    return err(new Error('payload.occurredAt must be an ISO-8601 string'));
  }
  if (typeof p['source'] !== 'string' || p['source'].trim() === '') {
    return err(new Error('payload.source must be a non-empty string'));
  }

  const actor = p['actor'];
  if (typeof actor !== 'object' || actor === null) {
    return err(new Error('payload.actor must be an object'));
  }
  const a = actor as Record<string, unknown>;
  if (typeof a['id'] !== 'string') return err(new Error('payload.actor.id must be a string'));
  if (typeof a['name'] !== 'string') return err(new Error('payload.actor.name must be a string'));
  if (!['human', 'service', 'system'].includes(a['kind'] as string)) {
    return err(new Error('payload.actor.kind must be "human", "service", or "system"'));
  }

  return ok(body as RawWebhookPayload);
}

// ---------------------------------------------------------------------------
// Payload → DomainEvent
// ---------------------------------------------------------------------------

function toDomainEvent(raw: RawWebhookPayload, receivedAt: string): DomainEvent {
  const actor: DomainEventActor = {
    id: raw.actor.id,
    name: raw.actor.name,
    kind: raw.actor.kind as DomainEventActor['kind'],
    ...(raw.actor.ipAddress ? { ipAddress: raw.actor.ipAddress } : {}),
  };

  return {
    id: raw.id,
    type: raw.type as EventType,
    occurredAt: raw.occurredAt,
    receivedAt,
    source: raw.source,
    actor,
    metadata: raw.metadata ?? {},
    environment: raw.environment ?? 'production',
  };
}

// ---------------------------------------------------------------------------
// WebhookReceiver
// ---------------------------------------------------------------------------

export interface WebhookReceiverOptions {
  verificationEngine: VerificationEngine;
  /**
   * Callback invoked after a successful verification batch completes.
   * Use this to write the evidence record to the vault and forward alerts.
   */
  onVerified?: (batch: import('../engine/verification.js').VerificationBatch) => Promise<void>;
  /** Override the HMAC secret (defaults to process.env.WEBHOOK_SECRET) */
  secret?: string;
}

export class WebhookReceiver {
  private readonly verificationEngine: VerificationEngine;
  private readonly onVerified?: WebhookReceiverOptions['onVerified'];
  private readonly secret: string;
  private readonly dedupStore = new InMemoryDedupStore();

  constructor(options: WebhookReceiverOptions) {
    this.verificationEngine = options.verificationEngine;
    this.onVerified = options.onVerified;

    const secret = options.secret ?? process.env['WEBHOOK_SECRET'];
    if (!secret) {
      throw new Error('WebhookReceiver requires WEBHOOK_SECRET env var or options.secret');
    }
    this.secret = secret;
  }

  // -------------------------------------------------------------------------
  // HTTP server factory
  // -------------------------------------------------------------------------

  createServer(): http.Server {
    return http.createServer((req: http.IncomingMessage, res: http.ServerResponse) => {
      void this.handleRequest(req, res);
    });
  }

  // -------------------------------------------------------------------------
  // Request handler
  // -------------------------------------------------------------------------

  async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Only accept POST /webhook
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const receivedAt = new Date().toISOString();

    // -- 1. Read body with size guard
    const bodyResult = await this.readBody(req);
    if (!bodyResult.ok) {
      logger.warn('receiver: body read failed', { reason: bodyResult.error.message });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: bodyResult.error.message }));
      return;
    }
    const rawBody = bodyResult.value;

    // -- 2. Verify timestamp (replay protection)
    const timestampHeader = req.headers['x-caas-timestamp'];
    const timestampResult = this.verifyTimestamp(timestampHeader);
    if (!timestampResult.ok) {
      logger.warn('receiver: timestamp verification failed', { reason: timestampResult.error.message });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: timestampResult.error.message }));
      return;
    }

    // -- 3. Verify HMAC signature
    const signatureHeader = req.headers['x-caas-signature'];
    const signatureResult = this.verifySignature(rawBody, signatureHeader);
    if (!signatureResult.ok) {
      logger.warn('receiver: signature verification failed', { reason: signatureResult.error.message });
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid signature' }));
      return;
    }

    // -- 4. Parse JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      return;
    }

    // -- 5. Validate schema
    const payloadResult = validatePayload(parsed);
    if (!payloadResult.ok) {
      logger.warn('receiver: payload validation failed', { reason: payloadResult.error.message });
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: payloadResult.error.message }));
      return;
    }
    const rawPayload = payloadResult.value;

    // -- 6. Deduplication
    if (!this.dedupStore.checkAndMark(rawPayload.id)) {
      logger.info('receiver: duplicate event ignored', { eventId: rawPayload.id });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'accepted', note: 'duplicate — already processed' }));
      return;
    }

    // -- 7. Build DomainEvent
    const event = toDomainEvent(rawPayload, receivedAt);

    logger.info('receiver: event accepted', {
      eventId: event.id,
      type: event.type,
      source: event.source,
      environment: event.environment,
      actor: event.actor.id,
    });

    // -- 8. Respond 202 immediately, then dispatch asynchronously
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted', eventId: event.id }));

    // Fire-and-forget (errors caught internally)
    void this.dispatch(event);
  }

  // -------------------------------------------------------------------------
  // Async dispatch to verification engine
  // -------------------------------------------------------------------------

  private async dispatch(event: DomainEvent): Promise<void> {
    const result = await this.verificationEngine.verify(event);

    if (!result.ok) {
      logger.error('receiver: verification engine error', {
        eventId: event.id,
        error: result.error.message,
      });
      return;
    }

    const batch = result.value;

    if (batch.alerts.length > 0) {
      for (const alert of batch.alerts) {
        logger.warn('receiver: compliance alert triggered', {
          alertId: alert.id,
          eventId: alert.eventId,
          policyId: alert.policyId,
          controlId: alert.controlId,
          severity: alert.severity,
          message: alert.message,
        });
      }
    }

    if (this.onVerified) {
      try {
        await this.onVerified(batch);
      } catch (e) {
        logger.error('receiver: onVerified callback threw', {
          eventId: event.id,
          error: (e as Error).message,
        });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async readBody(req: http.IncomingMessage): Promise<Result<string>> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;

      req.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_BYTES) {
          req.destroy();
          resolve(err(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`)));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        resolve(ok(Buffer.concat(chunks).toString('utf-8')));
      });

      req.on('error', (e: Error) => {
        resolve(err(new Error(`Stream error: ${e.message}`)));
      });
    });
  }

  private verifyTimestamp(header: string | string[] | undefined): Result<number> {
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw) {
      return err(new Error('Missing X-CaaS-Timestamp header'));
    }
    const ts = parseInt(raw, 10);
    if (isNaN(ts)) {
      return err(new Error('X-CaaS-Timestamp must be a unix epoch integer'));
    }
    const drift = Math.abs(Math.floor(Date.now() / 1000) - ts);
    if (drift > TIMESTAMP_TOLERANCE_SECONDS) {
      return err(new Error(`Timestamp drift of ${drift}s exceeds tolerance of ${TIMESTAMP_TOLERANCE_SECONDS}s`));
    }
    return ok(ts);
  }

  private verifySignature(body: string, header: string | string[] | undefined): Result<true> {
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw) {
      return err(new Error('Missing X-CaaS-Signature header'));
    }

    // Expected format: "sha256=<hex>"
    const [algo, provided] = raw.split('=');
    if (algo !== 'sha256' || !provided) {
      return err(new Error('X-CaaS-Signature must follow the format "sha256=<hex>"'));
    }

    const expected = crypto
      .createHmac('sha256', this.secret)
      .update(body, 'utf-8')
      .digest('hex');

    // Constant-time comparison to prevent timing attacks
    const expectedBuf = Buffer.from(expected, 'hex');
    const providedBuf = Buffer.from(provided, 'hex');

    if (
      expectedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(expectedBuf, providedBuf)
    ) {
      return err(new Error('HMAC signature mismatch'));
    }

    return ok(true);
  }
}
