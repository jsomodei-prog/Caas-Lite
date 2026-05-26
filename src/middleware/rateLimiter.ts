/**
 * src/middleware/rateLimiter.ts
 * Enterprise API rate limiting with dynamic tier-based throttling and
 * leaky-bucket (token bucket) burst cushioning.
 *
 * Tiers:
 *   PAY_AS_YOU_GO  60  req/min   burst  15
 *   GROWTH         300 req/min   burst  75
 *   ENTERPRISE     1 500 req/min burst  300
 *
 * Algorithm: Token Bucket (commonly called "leaky bucket" in API contexts).
 *   - Each client identity (tenant_id + IP) gets a bucket with a fixed capacity.
 *   - Tokens refill continuously at the tier's req/min rate.
 *   - Each request consumes one token.
 *   - When the bucket is empty the request is rejected with HTTP 429.
 *   - Burst headroom absorbs sudden spikes from automation tools
 *     (Zapier, MuleSoft, n8n) without penalising steady-state traffic.
 *
 * Response headers (RFC 6585 / IETF draft-ietf-httpapi-ratelimit-headers):
 *   X-RateLimit-Limit      Tier request-per-minute ceiling
 *   X-RateLimit-Remaining  Tokens left in the current window
 *   X-RateLimit-Reset      Unix epoch second when the bucket is full again
 *   Retry-After            Seconds to wait before retrying (only on 429)
 *
 * Phase 10 build-out  |  Commit baseline: a4f5db6
 */

import type { Request, Response, NextFunction } from "express";
import { rateLimitCounter } from "../analytics/performance";
import type { LabelValues } from "prom-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ApiTier = "PAY_AS_YOU_GO" | "GROWTH" | "ENTERPRISE";

export interface TierConfig {
  /** Maximum sustained requests per minute. */
  requestsPerMinute: number;
  /** Maximum burst size (token bucket capacity). */
  burstCapacity: number;
  /** Human-readable display label. */
  label: string;
}

export interface RateLimitResult {
  allowed: boolean;
  tier: ApiTier;
  limit: number;
  remaining: number;
  /** Unix epoch second when the bucket will be completely refilled. */
  resetEpoch: number;
  /** Seconds the client should wait before retrying (only set when !allowed). */
  retryAfterSeconds: number | null;
  bucketKey: string;
  /**
   * True when the request was rejected because the tier header was absent or
   * unrecognised — NOT because a rate limit was exceeded. The middleware uses
   * this flag to return HTTP 400 (bad request) instead of HTTP 429 (too many
   * requests), which is the semantically correct status for a missing header.
   */
  invalidTier?: boolean;
}

export interface RateLimiterOptions {
  /**
   * Header name from which the tier is read (default: X-CaaS-Tier).
   * The auth middleware must set this after JWT verification.
   */
  tierHeader?: string;
  /**
   * Header name for the tenant identifier (default: X-Tenant-ID).
   */
  tenantHeader?: string;
  /**
   * When true, requests from unknown tiers are treated as PAY_AS_YOU_GO.
   * When false (default), they are rejected with HTTP 400.
   */
  allowUnknownTier?: boolean;
  /**
   * Maximum number of distinct bucket keys to hold in memory.
   * LRU eviction occurs when this limit is exceeded.
   * Default: 50 000.
   */
  maxBuckets?: number;
  /**
   * Custom tier overrides — merged with TIER_CONFIGS.
   * Use this to give specific tenants non-standard limits without
   * changing the global table.
   */
  tierOverrides?: Partial<Record<ApiTier, Partial<TierConfig>>>;
  /**
   * Routes that bypass rate limiting entirely (exact path matches).
   * Always includes /health and /metrics.
   */
  bypassPaths?: string[];
}

// ─── Tier Configurations ──────────────────────────────────────────────────────

export const TIER_CONFIGS: Record<ApiTier, TierConfig> = {
  PAY_AS_YOU_GO: {
    requestsPerMinute: 60,
    burstCapacity: 15,
    label: "Pay-As-You-Go",
  },
  GROWTH: {
    requestsPerMinute: 300,
    burstCapacity: 75,
    label: "Growth",
  },
  ENTERPRISE: {
    requestsPerMinute: 1_500,
    burstCapacity: 300,
    label: "Enterprise",
  },
};

const ALWAYS_BYPASS = new Set(["/health", "/health/db", "/metrics", "/favicon.ico"]);

// ─── Token Bucket ─────────────────────────────────────────────────────────────

/**
 * Token Bucket implementation.
 *
 * Refill is continuous (not windowed) — a client that sends 1 req/s against
 * a 60 req/min bucket always has tokens, whereas a windowed counter would
 * reset every 60 s and allow a burst at the boundary.  Continuous refill
 * provides smoother, fairer limiting.
 *
 * Thread safety: JavaScript's single-threaded event loop makes this safe
 * without locks.
 */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  /** Tokens added per millisecond. */
  private readonly refillRatePerMs: number;

  constructor(
    /** Maximum number of tokens (burst capacity). */
    private readonly capacity: number,
    /** Sustained tokens per minute. */
    requestsPerMinute: number
  ) {
    // Start full so new clients aren't immediately throttled.
    this.tokens         = capacity;
    this.lastRefillMs   = Date.now();
    this.refillRatePerMs = requestsPerMinute / 60_000;
  }

  /**
   * Attempts to consume `count` tokens.
   * Returns true if the request is allowed, false if the bucket is empty.
   */
  consume(count = 1): boolean {
    this.refill();
    if (this.tokens >= count) {
      this.tokens -= count;
      return true;
    }
    return false;
  }

  private refill(): void {
    const now     = Date.now();
    const elapsed = now - this.lastRefillMs;
    const added   = elapsed * this.refillRatePerMs;
    this.tokens       = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = now;
  }

  /** Floored token count — the value surfaced in X-RateLimit-Remaining. */
  get remaining(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Unix epoch second when the bucket will be at full capacity.
   * If already full, returns the current second.
   */
  get resetEpoch(): number {
    if (this.tokens >= this.capacity) {
      return Math.floor(Date.now() / 1000);
    }
    const secondsToFull = (this.capacity - this.tokens) / (this.refillRatePerMs * 1000);
    return Math.ceil(Date.now() / 1000 + secondsToFull);
  }

  /**
   * Seconds until at least one token is available.
   * Returns 0 if tokens are already available.
   */
  get retryAfterSeconds(): number {
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / (this.refillRatePerMs * 1000));
  }
}

// ─── Bucket Store ─────────────────────────────────────────────────────────────

/**
 * In-memory LRU store for token buckets.
 *
 * Uses a Map (insertion-order iteration) to implement O(1) LRU eviction:
 * on every access the key is deleted and re-inserted, pushing it to the end.
 * When the store exceeds maxBuckets the oldest (first) entry is evicted.
 *
 * For multi-process or multi-instance deployments, replace this with
 * a Redis-backed store using the same interface.
 */
class BucketStore {
  private readonly store = new Map<string, TokenBucket>();

  constructor(private readonly maxBuckets: number) {}

  get(key: string): TokenBucket | undefined {
    const bucket = this.store.get(key);
    if (bucket) {
      // Move to end (most recently used).
      this.store.delete(key);
      this.store.set(key, bucket);
    }
    return bucket;
  }

  set(key: string, bucket: TokenBucket): void {
    if (this.store.size >= this.maxBuckets) {
      // Evict the oldest (first) entry.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, bucket);
  }

  getOrCreate(
    key: string,
    capacity: number,
    requestsPerMinute: number
  ): TokenBucket {
    let bucket = this.get(key);
    if (!bucket) {
      bucket = new TokenBucket(capacity, requestsPerMinute);
      this.set(key, bucket);
    }
    return bucket;
  }

  size(): number {
    return this.store.size;
  }

  /** Removes all entries — useful in test teardown. */
  clear(): void {
    this.store.clear();
  }
}

// ─── Tier Resolution ──────────────────────────────────────────────────────────

const VALID_TIERS = new Set<ApiTier>(["PAY_AS_YOU_GO", "GROWTH", "ENTERPRISE"]);

function resolveTier(
  req: Request,
  tierHeader: string,
  allowUnknown: boolean
): ApiTier | null {
  const raw = req.headers[tierHeader.toLowerCase()] as string | undefined;
  if (!raw) return allowUnknown ? "PAY_AS_YOU_GO" : null;
  const upper = raw.toUpperCase() as ApiTier;
  if (VALID_TIERS.has(upper)) return upper;
  return allowUnknown ? "PAY_AS_YOU_GO" : null;
}

function resolveTierConfig(
  tier: ApiTier,
  overrides: Partial<Record<ApiTier, Partial<TierConfig>>>
): TierConfig {
  const base = TIER_CONFIGS[tier];
  const override = overrides[tier] ?? {};
  return { ...base, ...override };
}

function buildBucketKey(
  req: Request,
  tenantHeader: string
): string {
  const tenantId = req.headers[tenantHeader.toLowerCase()] as string | undefined;
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0].trim() ??
    req.socket?.remoteAddress ??
    "unknown";
  return tenantId ? `t:${tenantId}` : `ip:${ip}`;
}

/**
 * Detects well-known automation user-agent strings.
 * These clients often produce burst traffic that should be absorbed by
 * the burst capacity rather than immediately rejected.
 */
function isAutomationClient(req: Request): boolean {
  const ua = (req.headers["user-agent"] ?? "").toLowerCase();
  return (
    ua.includes("zapier") ||
    ua.includes("mulesoft") ||
    ua.includes("n8n") ||
    ua.includes("make.com") ||
    ua.includes("workato") ||
    ua.includes("tray.io") ||
    ua.includes("pipedream")
  );
}

// ─── Core Rate-Limit Logic ────────────────────────────────────────────────────

function evaluateRateLimit(
  req: Request,
  store: BucketStore,
  opts: Required<RateLimiterOptions>
): RateLimitResult {
  const tier = resolveTier(req, opts.tierHeader, opts.allowUnknownTier);

  if (!tier) {
    // The tier header is absent or unrecognised and allowUnknownTier is false.
    // Return invalidTier: true so the middleware emits HTTP 400 (bad request)
    // rather than HTTP 429 (too many requests). A missing header is a client
    // configuration error — not a rate-limit event. The previous limit: 0
    // response was indistinguishable from a genuine 429 and caused ops
    // confusion. Fixed in Session 0. See DEPLOYMENT-update-2026-05-25.md.
    return {
      allowed: false,
      tier: "PAY_AS_YOU_GO",
      limit: 0,
      remaining: 0,
      resetEpoch: Math.floor(Date.now() / 1000),
      retryAfterSeconds: null,
      bucketKey: "invalid",
      invalidTier: true,
    };
  }

  const config     = resolveTierConfig(tier, opts.tierOverrides);
  const bucketKey  = buildBucketKey(req, opts.tenantHeader);

  // Automation clients share a per-key bucket but are tagged in logs.
  const automation = isAutomationClient(req);

  const bucket = store.getOrCreate(
    bucketKey,
    config.burstCapacity,
    config.requestsPerMinute
  );

  const allowed = bucket.consume(1);

  if (!allowed && automation) {
    // Log burst from automation client — helps ops tune burst capacity.
    console.warn(
      `[rateLimiter] Automation client burst from ${bucketKey} ` +
        `(tier=${tier}, ua=${req.headers["user-agent"]?.slice(0, 60)})`
    );
  }

  return {
    allowed,
    tier,
    limit: config.requestsPerMinute,
    remaining: bucket.remaining,
    resetEpoch: bucket.resetEpoch,
    retryAfterSeconds: allowed ? null : bucket.retryAfterSeconds,
    bucketKey,
  };
}

// ─── Middleware Factory ────────────────────────────────────────────────────────

/**
 * Creates and returns an Express rate-limiting middleware.
 *
 * Usage in src/app.ts:
 *   import { createRateLimiter } from "./middleware/rateLimiter";
 *   app.use(createRateLimiter({ allowUnknownTier: true }));
 */
export function createRateLimiter(
  options: RateLimiterOptions = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const opts: Required<RateLimiterOptions> = {
    tierHeader:       options.tierHeader       ?? "X-CaaS-Tier",
    tenantHeader:     options.tenantHeader     ?? "X-Tenant-ID",
    allowUnknownTier: options.allowUnknownTier ?? false,
    maxBuckets:       options.maxBuckets       ?? 50_000,
    tierOverrides:    options.tierOverrides    ?? {},
    bypassPaths:      options.bypassPaths      ?? [],
  };

  const bypassSet = new Set([
    ...ALWAYS_BYPASS,
    ...opts.bypassPaths,
  ]);

  const store = new BucketStore(opts.maxBuckets);

  return function rateLimiterMiddleware(
    req: Request,
    res: Response,
    next: NextFunction
  ): void {
    // Bypass for health/metrics routes.
    if ([...bypassSet].some(p => req.path === p || req.path.startsWith(p + "/"))) {
      next();
      return;
    }

    const result = evaluateRateLimit(req, store, opts);

    setRateLimitHeaders(res, result);

    if (!result.allowed) {
      const tenantId =
        (req.headers[opts.tenantHeader.toLowerCase()] as string | undefined) ??
        "unknown";

      // Bug fix (Session 0): distinguish a missing/invalid tier header from a
      // genuine rate-limit event. Previously both produced HTTP 429 with
      // limit: 0, which was semantically wrong and confused clients and ops.
      if (result.invalidTier) {
        res.status(400).json({
          error: "Tier header required or invalid",
          hint: `Send X-CaaS-Tier: LITE | GROWTH | ENTERPRISE on every authenticated request.`,
          path: req.path,
        });
        return;
      }

      rateLimitCounter.inc({
        tier: result.tier,
        tenant_id: tenantId,
      } as LabelValues<"tier" | "tenant_id">);

      res.status(429).json({
        error: "Too Many Requests",
        tier: result.tier,
        limit: result.limit,
        retry_after_seconds: result.retryAfterSeconds,
        reset_at: new Date(result.resetEpoch * 1000).toISOString(),
      });
      return;
    }

    next();
  };
}

// ─── Header Helpers ───────────────────────────────────────────────────────────

function setRateLimitHeaders(res: Response, result: RateLimitResult): void {
  res.setHeader("X-RateLimit-Limit", result.limit);
  res.setHeader("X-RateLimit-Remaining", result.remaining);
  res.setHeader("X-RateLimit-Reset", result.resetEpoch);
  res.setHeader("X-RateLimit-Policy", `${result.limit};w=60`);
  if (result.retryAfterSeconds !== null) {
    res.setHeader("Retry-After", result.retryAfterSeconds);
  }
}

// ─── Per-Tenant Tier Override Helpers ────────────────────────────────────────

/**
 * Builds a tierOverrides map from environment variables.
 * Useful for giving specific enterprise tenants higher limits without
 * redeploying.
 *
 * Environment variable format:
 *   TIER_OVERRIDE_ENTERPRISE_RPM=3000
 *   TIER_OVERRIDE_ENTERPRISE_BURST=600
 *   TIER_OVERRIDE_GROWTH_RPM=500
 */
export function buildTierOverridesFromEnv(): Partial<
  Record<ApiTier, Partial<TierConfig>>
> {
  const overrides: Partial<Record<ApiTier, Partial<TierConfig>>> = {};

  const tiers: ApiTier[] = ["PAY_AS_YOU_GO", "GROWTH", "ENTERPRISE"];
  for (const tier of tiers) {
    const key = tier.replace(/_/g, "_");
    const rpm   = process.env[`TIER_OVERRIDE_${key}_RPM`];
    const burst = process.env[`TIER_OVERRIDE_${key}_BURST`];
    if (rpm || burst) {
      overrides[tier] = {};
      if (rpm)   overrides[tier]!.requestsPerMinute = parseInt(rpm, 10);
      if (burst) overrides[tier]!.burstCapacity     = parseInt(burst, 10);
    }
  }

  return overrides;
}

/**
 * Returns a snapshot of current bucket states for monitoring/debugging.
 * Only call from admin-authenticated routes.
 */
export function inspectBuckets(
  store: BucketStore
): { size: number } {
  return { size: store.size() };
}
