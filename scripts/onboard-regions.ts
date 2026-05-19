/**
 * scripts/onboard-regions.ts
 * Posts each regulatory framework in seeds/regulatory_frameworks_seed.json
 * to /api/v1/regulatory/onboard using the super admin's access token.
 *
 * Idempotent: if a framework already exists (HTTP 409 on framework_code),
 * the script reports it and continues rather than aborting. Other failures
 * abort with a non-zero exit so CI catches them.
 *
 * Requires:
 *   SEED_SUPER_ADMIN_PASSWORD    (required)
 *   SEED_SUPER_ADMIN_USERNAME    (optional, default: 'platform-admin')
 *   API_BASE_URL                 (optional, default: 'http://localhost:3000')
 *   SEED_FILE                    (optional, default: 'seeds/regulatory_frameworks_seed.json')
 *
 * Run:
 *   $env:SEED_SUPER_ADMIN_PASSWORD = "..."
 *   npx ts-node --project tsconfig.json scripts/onboard-regions.ts
 *
 * Phase 14 follow-up | depends on seed-super-admin.ts having run first
 */

import fs   from "fs";
import path from "path";

// ─── Constants ────────────────────────────────────────────────────────────────

const PLATFORM_TENANT = "__platform__";
const DEFAULT_USERNAME = "platform-admin";
const DEFAULT_BASE_URL = "http://localhost:3000";
const DEFAULT_SEED_PATH = "seeds/regulatory_frameworks_seed.json";

const LOGIN_PATH    = "/auth/login";
const ONBOARD_PATH  = "/api/v1/regulatory/onboard";

// ─── Types ────────────────────────────────────────────────────────────────────

interface LoginResponse {
  access_token:  string;
  refresh_token: string;
  expires_in:    number;
}

interface FrameworkSeed {
  framework_code: string;
  framework_name: string;
  region_code:    string;
  // ...rest passed through verbatim
  [key: string]: unknown;
}

// ─── HTTP Helpers ─────────────────────────────────────────────────────────────

async function postJson<T>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: T | { error?: string; [k: string]: unknown } }> {
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body:    JSON.stringify(body),
  });

  // Parse JSON if possible; tolerate empty/non-JSON error bodies.
  const text = await res.text();
  let parsed: unknown = {};
  if (text.length > 0) {
    try { parsed = JSON.parse(text); }
    catch { parsed = { error: text.slice(0, 200) }; }
  }
  return { status: res.status, body: parsed as T };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  if (!password) {
    console.error("[onboard-regions] SEED_SUPER_ADMIN_PASSWORD is not set.");
    process.exit(1);
  }

  const username = process.env.SEED_SUPER_ADMIN_USERNAME ?? DEFAULT_USERNAME;
  const baseUrl  = (process.env.API_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const seedPath = path.resolve(process.cwd(), process.env.SEED_FILE ?? DEFAULT_SEED_PATH);

  // ── Load seed file ────────────────────────────────────────────────────────
  if (!fs.existsSync(seedPath)) {
    console.error(`[onboard-regions] Seed file not found: ${seedPath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(seedPath, "utf-8");
  let frameworks: FrameworkSeed[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Seed root must be an array of framework objects.");
    }
    frameworks = parsed as FrameworkSeed[];
  } catch (err) {
    console.error(`[onboard-regions] Failed to parse seed: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`[onboard-regions] Loaded ${frameworks.length} framework(s) from ${seedPath}`);

  // ── Authenticate ──────────────────────────────────────────────────────────
  console.log(`[onboard-regions] Logging in as "${username}" @ ${PLATFORM_TENANT}...`);
  const loginRes = await postJson<LoginResponse>(
    `${baseUrl}${LOGIN_PATH}`,
    { username, password, tenant_id: PLATFORM_TENANT }
  );

  if (loginRes.status !== 200) {
    console.error(
      `[onboard-regions] Login failed (HTTP ${loginRes.status}):`,
      JSON.stringify(loginRes.body)
    );
    process.exit(1);
  }
  const { access_token } = loginRes.body as LoginResponse;
  if (!access_token) {
    console.error("[onboard-regions] Login response did not include access_token.");
    process.exit(1);
  }
  console.log(`[onboard-regions] ✓ authenticated`);

  // ── Onboard each framework ────────────────────────────────────────────────
  const auth = { Authorization: `Bearer ${access_token}` };
  let created = 0;
  let already = 0;
  let failed  = 0;

  for (const fw of frameworks) {
    const label = `${fw.framework_code} (${fw.region_code})`;
    process.stdout.write(`[onboard-regions] POST ${ONBOARD_PATH} → ${label} ... `);

    const res = await postJson(`${baseUrl}${ONBOARD_PATH}`, fw, auth);

    if (res.status === 201) {
      console.log("✓ 201");
      created++;
    } else if (res.status === 409) {
      // Already onboarded — treat as success for idempotency.
      console.log("↻ 409 (already exists, skipping)");
      already++;
    } else {
      console.log(`✗ ${res.status}`);
      console.error(`    response: ${JSON.stringify(res.body)}`);
      failed++;
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(
    `\n[onboard-regions] Done. created=${created} already=${already} failed=${failed}`
  );
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error("[onboard-regions] Fatal:", err);
  process.exit(1);
});
