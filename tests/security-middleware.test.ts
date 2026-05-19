/**
 * tests/security-middleware.test.ts
 * Tests for slice 1 hardening: rate limiters, helmet headers, CORS.
 *
 * Two test groups:
 *   1. Headers (helmet) — verify production-relevant headers are set.
 *   2. CORS — verify allow-list behaviour and permissive badge route.
 *
 * Rate limiter behaviour is intentionally NOT tested here. The limiters
 * are disabled via NODE_ENV=test (see rate-limits.ts), so testing them
 * would require either flipping env mid-test (flaky) or relying on the
 * upstream library's own test suite (which already covers it).
 *
 * For a real load test of rate limits, a separate integration test
 * environment with NODE_ENV unset would be appropriate.
 */

import request from "supertest";
import fs      from "fs";
import os      from "os";
import path    from "path";
import { createTestApp, mintSuperAdminToken } from "./helpers/auth";
import { invalidateCorsCache } from "../src/middleware/cors";

// ─── Setup ────────────────────────────────────────────────────────────────────

let app: ReturnType<typeof createTestApp>;
let dbPath: string;

beforeAll(async () => {
  dbPath = path.join(os.tmpdir(), `caas-security-${Date.now()}.db`);
  // Note: NODE_ENV is "test" by default under jest, which disables rate
  // limits. That's intentional — see file header.
  process.env.CORS_ALLOWED_ORIGINS = "https://allowed.example.com,https://staging.example.com";
  invalidateCorsCache();
  app = createTestApp(dbPath);
  await mintSuperAdminToken(app);  // ensure DB is fully migrated
});

afterAll(() => {
  delete process.env.CORS_ALLOWED_ORIGINS;
  invalidateCorsCache();
  try { fs.unlinkSync(dbPath); } catch { /* fine */ }
});

// ─── Helmet headers ───────────────────────────────────────────────────────────

describe("Helmet security headers", () => {

  test("X-Content-Type-Options: nosniff is set", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  test("Referrer-Policy is set restrictively", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["referrer-policy"]).toBeDefined();
  });

  test("X-Frame-Options blocks iframes by default", async () => {
    const res = await request(app).get("/healthz");
    // Helmet default is SAMEORIGIN. Either that or DENY is acceptable.
    expect(["SAMEORIGIN", "DENY"]).toContain(res.headers["x-frame-options"]);
  });

  test("Content-Security-Policy is restrictive on API responses", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  test("HSTS is NOT set in non-production mode", async () => {
    // process.env.NODE_ENV is "test" during jest runs
    const res = await request(app).get("/healthz");
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });
});

// ─── CORS — strict allow-list ────────────────────────────────────────────────

describe("CORS — strict allow-list (default)", () => {

  test("allowed origin gets echoed in Access-Control-Allow-Origin", async () => {
    const res = await request(app)
      .get("/healthz")
      .set("Origin", "https://allowed.example.com");
    expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["vary"]).toContain("Origin");
  });

  test("disallowed origin does NOT get Allow-Origin header", async () => {
    const res = await request(app)
      .get("/healthz")
      .set("Origin", "https://evil.example.com");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("no Origin header → no CORS headers (server-to-server)", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  test("preflight (OPTIONS) from allowed origin returns 204", async () => {
    const res = await request(app)
      .options("/healthz")
      .set("Origin", "https://allowed.example.com")
      .set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(204);
  });

  test("preflight from disallowed origin returns 403", async () => {
    const res = await request(app)
      .options("/healthz")
      .set("Origin", "https://evil.example.com")
      .set("Access-Control-Request-Method", "GET");
    expect(res.status).toBe(403);
  });
});

// ─── CORS — permissive badge route ───────────────────────────────────────────

describe("CORS — permissive badge route", () => {

  test("badge endpoint accepts any origin", async () => {
    // The badge endpoint returns 404 without a valid signature, but the
    // CORS headers should still be set on the response.
    const res = await request(app)
      .get("/api/v1/badge/some-tenant?sig=invalid")
      .set("Origin", "https://random-customer-site.com");

    expect(res.headers["access-control-allow-origin"]).toBe("*");
    // Does NOT set Allow-Credentials with *, to prevent credentialed
    // cross-origin reads.
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  test("badge endpoint serves OPTIONS preflight permissively", async () => {
    const res = await request(app)
      .options("/api/v1/badge/some-tenant")
      .set("Origin", "https://random-customer-site.com")
      .set("Access-Control-Request-Method", "GET");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

// ─── Rate-limit headers ───────────────────────────────────────────────────────

describe("Rate-limit response headers", () => {

  test("standard RateLimit-* headers are present", async () => {
    const res = await request(app).get("/healthz");
    // Even with limits effectively disabled in test mode, the headers are
    // still emitted. This proves the middleware is mounted.
    expect(res.headers["ratelimit-limit"] ?? res.headers["x-ratelimit-limit"])
      .toBeDefined();
  });

  test("legacy X-RateLimit-* headers are NOT emitted", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["x-ratelimit-limit"]).toBeUndefined();
  });
});
