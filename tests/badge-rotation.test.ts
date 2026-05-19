/**
 * tests/badge-rotation.test.ts
 * Tests for badge HMAC secret rotation behaviour.
 *
 * Three things this validates:
 *   1. verifyBadgeSignature accepts both _CURRENT and _PREVIOUS secrets.
 *   2. detectAndApplyRotation correctly identifies "first boot", "unchanged",
 *      and "rotated" states.
 *   3. Boot-time rotation resigns all badges and writes audit log entries.
 */

import fs      from "fs";
import os      from "os";
import path    from "path";
import crypto  from "crypto";
import type { Database as DB } from "better-sqlite3";
import { mintSuperAdminToken, createTestApp } from "./helpers/auth";
import {
  signBadgeState,
  verifyBadgeSignature,
  invalidateCache,
} from "../src/lib/badge-secrets";
import { detectAndApplyRotation } from "../src/lib/badge-rotation";

// ─── Env shuffling helpers ────────────────────────────────────────────────────

/**
 * Sets env vars and clears the badge-secrets cache. Returns a teardown
 * function that restores the prior env. Use in beforeEach/afterEach.
 */
function withSecrets(opts: {
  current?:  string | null;
  previous?: string | null;
  legacy?:   string | null;
}): () => void {
  const priorCurrent  = process.env.BADGE_HMAC_SECRET_CURRENT;
  const priorPrevious = process.env.BADGE_HMAC_SECRET_PREVIOUS;
  const priorLegacy   = process.env.BADGE_HMAC_SECRET;

  const apply = (key: string, val: string | null | undefined) => {
    if (val === undefined) return;
    if (val === null) delete process.env[key];
    else              process.env[key] = val;
  };
  apply("BADGE_HMAC_SECRET_CURRENT",  opts.current);
  apply("BADGE_HMAC_SECRET_PREVIOUS", opts.previous);
  apply("BADGE_HMAC_SECRET",          opts.legacy);

  invalidateCache();

  return () => {
    process.env.BADGE_HMAC_SECRET_CURRENT  = priorCurrent  ?? "";
    process.env.BADGE_HMAC_SECRET_PREVIOUS = priorPrevious ?? "";
    process.env.BADGE_HMAC_SECRET          = priorLegacy   ?? "";
    if (!priorCurrent)  delete process.env.BADGE_HMAC_SECRET_CURRENT;
    if (!priorPrevious) delete process.env.BADGE_HMAC_SECRET_PREVIOUS;
    if (!priorLegacy)   delete process.env.BADGE_HMAC_SECRET;
    invalidateCache();
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("badge-secrets: signature verification with two secrets", () => {
  let teardown: () => void;
  afterEach(() => teardown?.());

  test("signature minted under _CURRENT verifies as 'current'", () => {
    teardown = withSecrets({ current: "secret-A", previous: "secret-B" });
    const sig = signBadgeState("tenant1", "green", "2026-05-19T00:00:00Z");
    expect(verifyBadgeSignature(sig, "tenant1", "green", "2026-05-19T00:00:00Z"))
      .toBe("current");
  });

  test("signature minted under _PREVIOUS verifies as 'previous'", () => {
    // Mint with secret B as current
    teardown = withSecrets({ current: "secret-B", previous: null });
    const sig = signBadgeState("tenant1", "green", "2026-05-19T00:00:00Z");

    // Now rotate: secret-A is current, secret-B is previous
    teardown();
    teardown = withSecrets({ current: "secret-A", previous: "secret-B" });

    expect(verifyBadgeSignature(sig, "tenant1", "green", "2026-05-19T00:00:00Z"))
      .toBe("previous");
  });

  test("signature minted under unrelated secret verifies as 'invalid'", () => {
    teardown = withSecrets({ current: "secret-A", previous: "secret-B" });
    // A signature random hex value of right length:
    const fakeSig = crypto.createHmac("sha256", "secret-Z")
      .update("tenant1|green|2026-05-19T00:00:00Z").digest("hex");
    expect(verifyBadgeSignature(fakeSig, "tenant1", "green", "2026-05-19T00:00:00Z"))
      .toBe("invalid");
  });

  test("legacy BADGE_HMAC_SECRET works as current when rotation vars unset", () => {
    teardown = withSecrets({ current: null, previous: null, legacy: "legacy-secret" });
    const sig = signBadgeState("tenant1", "green", "2026-05-19T00:00:00Z");
    expect(verifyBadgeSignature(sig, "tenant1", "green", "2026-05-19T00:00:00Z"))
      .toBe("current");
  });
});

// ─── Boot-time rotation detection ─────────────────────────────────────────────

describe("badge-rotation: detectAndApplyRotation", () => {
  let app: ReturnType<typeof createTestApp>;
  let dbPath: string;
  let teardown: () => void;
  let JWT: string;

  beforeAll(async () => {
    teardown = withSecrets({ current: "boot-secret-A", previous: null });
    dbPath = path.join(os.tmpdir(), `caas-rotation-${Date.now()}.db`);
    app    = createTestApp(dbPath);
    JWT    = await mintSuperAdminToken(app);
  });

  afterAll(() => {
    teardown?.();
    try { fs.unlinkSync(dbPath); } catch { /* fine */ }
  });

  function getDb(): DB { return (app.locals as { db: DB }).db; }

  test("first boot establishes fingerprint without resigning", () => {
    // The test app's createApp already ran detectAndApplyRotation as part of
    // boot, so the first-boot 'established' path has happened. Verify the
    // secret_state row exists.
    const row = getDb().prepare(
      "SELECT * FROM secret_state WHERE secret_name = 'BADGE_HMAC_SECRET'"
    ).get() as { fingerprint: string; metadata: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.fingerprint).toBe(
      crypto.createHash("sha256").update("boot-secret-A").digest("hex")
    );
    expect(JSON.parse(row!.metadata).event).toBe("established");
  });

  test("running again with same secret is a no-op", () => {
    const result = detectAndApplyRotation(getDb());
    expect(result.outcome).toBe("unchanged");
    expect(result.badges_resigned).toBe(0);
  });

  test("running with a NEW secret triggers a rotation and resigns badges", async () => {
    // Provision an account so there's at least one badge row to resign
    const acct = await (await import("supertest")).default(app)
      .post("/api/v1/accounts")
      .set("Authorization", `Bearer ${JWT}`)
      .send({ tenant_id: "tenant_rotation_test", display_name: "x", tier: "LITE" });
    expect(acct.status).toBe(201);

    // Capture the signature from before rotation
    const beforeSig = (getDb().prepare(
      "SELECT state_signature FROM trust_badge_registry WHERE tenant_id = ?"
    ).get("tenant_rotation_test") as { state_signature: string }).state_signature;

    // Rotate: change the env var, invalidate cache, run detection
    teardown();
    teardown = withSecrets({ current: "boot-secret-B", previous: "boot-secret-A" });

    const result = detectAndApplyRotation(getDb());
    expect(result.outcome).toBe("rotated");
    expect(result.badges_resigned).toBeGreaterThanOrEqual(1);

    // Signature should now differ
    const afterSig = (getDb().prepare(
      "SELECT state_signature FROM trust_badge_registry WHERE tenant_id = ?"
    ).get("tenant_rotation_test") as { state_signature: string }).state_signature;
    expect(afterSig).not.toBe(beforeSig);

    // Audit log should have at least one secret_rotation entry
    const auditCount = (getDb().prepare(
      "SELECT COUNT(*) as c FROM commercial_audit_log WHERE action = 'secret_rotation'"
    ).get() as { c: number }).c;
    expect(auditCount).toBeGreaterThanOrEqual(1);
  });

  test("re-running after rotation is a no-op (fingerprint matches)", () => {
    const result = detectAndApplyRotation(getDb());
    expect(result.outcome).toBe("unchanged");
    expect(result.badges_resigned).toBe(0);
  });
});
