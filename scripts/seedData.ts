/**
 * scripts/seedData.ts
 * Injects realistic mock data into the local CaaS database for dashboard
 * verification and local endpoint testing.
 *
 * Safe to re-run — checks for existing seed before inserting.
 *
 * Usage:
 *   $env:DB_PATH="data\caas_evidence.db"
 *   npx ts-node --project tsconfig.json scripts/seedData.ts
 *
 * What gets created:
 *   - 1 tenant                (tenant_id: "tenant-demo-001")
 *   - 3 users                 (Executive, Auditor, Partner)
 *   - 6 agents                (GH, NG, KE, ZA, GB, US — mixed MoMo + card)
 *   - 8 FX rate cache entries (prevailing approximate rates)
 *   - 12 payout log entries   (mixed statuses, currencies, countries)
 *   - 8 anomaly log entries   (mixed risk levels and event types)
 */

import crypto from "crypto";
import argon2  from "argon2";
import { openDatabase } from "../src/db/migrate";

// ─── Config ───────────────────────────────────────────────────────────────────

const TENANT_ID   = "tenant-demo-001";
const HMAC_SECRET = process.env.PAYOUT_HMAC_SECRET ?? "dev_hmac_secret_change_in_production";
const NOW         = new Date().toISOString();

const ARGON2_OPTIONS: argon2.Options & { raw: false } = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  raw: false,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uuid(): string {
  return crypto.randomUUID();
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 3_600_000).toISOString();
}

function hmac(payload: string): string {
  return crypto.createHmac("sha256", HMAC_SECRET).update(payload).digest("hex");
}

function signPayoutEntry(
  idempotencyKey: string, agentId: string, amountUsd: number,
  localAmount: number, localCurrency: string, fxRate: number,
  status: string, createdAt: string
): string {
  const payload = [
    idempotencyKey, agentId, amountUsd.toFixed(2),
    localAmount.toFixed(6), localCurrency, fxRate.toFixed(6),
    status, createdAt,
  ].join("|");
  return hmac(payload);
}

// ─── Seed Check ───────────────────────────────────────────────────────────────

function isAlreadySeeded(db: ReturnType<typeof openDatabase>): boolean {
  const row = db
    .prepare("SELECT COUNT(*) as cnt FROM agents WHERE tenant_id = ?")
    .get(TENANT_ID) as { cnt: number };
  return row.cnt > 0;
}

// ─── Users ────────────────────────────────────────────────────────────────────

async function seedUsers(db: ReturnType<typeof openDatabase>): Promise<void> {
  console.log("  Seeding users…");

  const users = [
    { id: uuid(), username: "exec_demo",    email: "exec@caas-demo.io",    role: "Executive", password: "ExecPass123!" },
    { id: uuid(), username: "auditor_demo", email: "auditor@caas-demo.io", role: "Auditor",   password: "AuditPass123!" },
    { id: uuid(), username: "partner_demo", email: "partner@caas-demo.io", role: "Partner",   password: "PartnerPass123!" },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO users
      (id, tenant_id, username, email, password_hash, role,
       failed_attempts, locked, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
  `);

  for (const u of users) {
    const hash = await argon2.hash(u.password, ARGON2_OPTIONS);
    stmt.run(u.id, TENANT_ID, u.username, u.email, hash, u.role, NOW, NOW);
    console.log(`    ✓ ${u.role.padEnd(10)} ${u.username}  (password: ${u.password})`);
  }
}

// ─── Agents ───────────────────────────────────────────────────────────────────

function seedAgents(db: ReturnType<typeof openDatabase>): string[] {
  console.log("  Seeding agents…");

  const agents = [
    {
      id: uuid(), name: "Kwame Mensah",     country_code: "GH",
      balance_usd: 1_250.00, payout_method: "momo",
      payout_threshold_usd: 100, kyc_tier: "standard",
      momo_number: "+233201234567", momo_provider: "mtn",
      card_token: null,
    },
    {
      id: uuid(), name: "Chidi Okonkwo",    country_code: "NG",
      balance_usd: 4_800.00, payout_method: "momo",
      payout_threshold_usd: 200, kyc_tier: "standard",
      momo_number: "+2348012345678", momo_provider: "mtn",
      card_token: null,
    },
    {
      id: uuid(), name: "Amina Wanjiru",    country_code: "KE",
      balance_usd: 920.50, payout_method: "momo",
      payout_threshold_usd: 50, kyc_tier: "basic",
      momo_number: "+254712345678", momo_provider: "mpesa",
      card_token: null,
    },
    {
      id: uuid(), name: "Sipho Dlamini",    country_code: "ZA",
      balance_usd: 3_400.00, payout_method: "card",
      payout_threshold_usd: 500, kyc_tier: "standard",
      momo_number: null, momo_provider: null,
      card_token: "tok_za_demo_4242",
    },
    {
      id: uuid(), name: "James Hargreaves", country_code: "GB",
      balance_usd: 8_750.00, payout_method: "card",
      payout_threshold_usd: 1_000, kyc_tier: "enhanced",
      momo_number: null, momo_provider: null,
      card_token: "tok_gb_demo_4242",
    },
    {
      id: uuid(), name: "Sarah Mitchell",   country_code: "US",
      balance_usd: 12_300.00, payout_method: "card",
      payout_threshold_usd: 1_000, kyc_tier: "enhanced",
      momo_number: null, momo_provider: null,
      card_token: "tok_us_demo_4242",
    },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO agents
      (id, tenant_id, name, balance_usd, payout_method, card_token,
       payout_threshold_usd, locked, country_code, kyc_tier,
       momo_number, momo_provider, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `);

  for (const a of agents) {
    stmt.run(
      a.id, TENANT_ID, a.name, a.balance_usd, a.payout_method,
      a.card_token, a.payout_threshold_usd, a.country_code, a.kyc_tier,
      a.momo_number, a.momo_provider, daysAgo(30), NOW
    );
    console.log(
      `    ✓ ${a.name.padEnd(20)} [${a.country_code}] ` +
      `$${a.balance_usd.toLocaleString().padStart(9)} USD  ` +
      `${a.payout_method}`
    );
  }

  return agents.map((a) => a.id);
}

// ─── FX Rate Cache ────────────────────────────────────────────────────────────

function seedFxRates(db: ReturnType<typeof openDatabase>): void {
  console.log("  Seeding FX rate cache…");

  // Approximate mid-market rates as of Q1 2026 (USD base)
  const rates: { currency: string; mid: number }[] = [
    { currency: "GHS", mid: 15.52  },
    { currency: "NGN", mid: 1648.0 },
    { currency: "KES", mid: 129.8  },
    { currency: "ZAR", mid: 18.43  },
    { currency: "GBP", mid: 0.791  },
    { currency: "EUR", mid: 0.924  },
    { currency: "CAD", mid: 1.384  },
    { currency: "AUD", mid: 1.558  },
  ];

  const spread   = 0.005;
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO fx_rate_cache
      (rate_id, base, target, mid_rate, spread_fraction, effective_rate,
       provider, fetched_at, expires_at)
    VALUES (?, 'USD', ?, ?, ?, ?, 'open_exchange_rates', ?, ?)
  `);

  for (const r of rates) {
    stmt.run(
      uuid(), r.currency, r.mid, spread,
      parseFloat((r.mid * (1 + spread)).toFixed(6)),
      NOW, expiresAt
    );
    console.log(
      `    ✓ USD → ${r.currency.padEnd(4)} ` +
      `mid: ${r.mid.toString().padStart(8)}  ` +
      `effective: ${(r.mid * (1 + spread)).toFixed(4)}`
    );
  }
}

// ─── Payout Logs ─────────────────────────────────────────────────────────────

function seedPayoutLogs(
  db: ReturnType<typeof openDatabase>,
  agentIds: string[]
): void {
  console.log("  Seeding payout logs…");

  const [ghId, ngId, keId, zaId, gbId, usId] = agentIds;

  const logs = [
    // Successful payouts
    {
      id: uuid(), agent_id: ghId, amount_usd: 1062.50,
      local_amount: 16_490.0, local_currency: "GHS",
      fx_mid: 15.52, fx_eff: 15.598, method: "momo",
      status: "success", created: daysAgo(1), settled: daysAgo(1),
      wht: 0, ref: "momo_ref_gh_001",
    },
    {
      id: uuid(), agent_id: ngId, amount_usd: 4_080.00,
      local_amount: 6_723_840.0, local_currency: "NGN",
      fx_mid: 1648.0, fx_eff: 1656.24, method: "momo",
      status: "success", created: daysAgo(2), settled: daysAgo(2),
      wht: 672_384.0, ref: "momo_ref_ng_001",
    },
    {
      id: uuid(), agent_id: keId, amount_usd: 782.43,
      local_amount: 101_499.0, local_currency: "KES",
      fx_mid: 129.8, fx_eff: 130.449, method: "momo",
      status: "success", created: daysAgo(3), settled: daysAgo(3),
      wht: 5_075.0, ref: "momo_ref_ke_001",
    },
    {
      id: uuid(), agent_id: gbId, amount_usd: 7_437.50,
      local_amount: 5_876.0, local_currency: "GBP",
      fx_mid: 0.791, fx_eff: 0.7950, method: "card",
      status: "success", created: daysAgo(4), settled: daysAgo(4),
      wht: 0, ref: "py_gb_stripe_001",
    },
    // Processing (webhook pending)
    {
      id: uuid(), agent_id: usId, amount_usd: 10_455.00,
      local_amount: 7_356.79, local_currency: "USD",
      fx_mid: 1.0, fx_eff: 1.005, method: "card",
      status: "processing", created: hoursAgo(2), settled: null,
      wht: 2_927.40, ref: "py_us_stripe_002",
    },
    {
      id: uuid(), agent_id: zaId, amount_usd: 2_890.00,
      local_amount: 53_263.0, local_currency: "ZAR",
      fx_mid: 18.43, fx_eff: 18.522, method: "card",
      status: "processing", created: hoursAgo(1), settled: null,
      wht: 0, ref: "py_za_peach_001",
    },
    // Failed payouts
    {
      id: uuid(), agent_id: ngId, amount_usd: 850.00,
      local_amount: 0, local_currency: "NGN",
      fx_mid: 1648.0, fx_eff: 1656.24, method: "momo",
      status: "failed", created: daysAgo(5), settled: null,
      wht: 0, ref: null,
    },
    {
      id: uuid(), agent_id: ghId, amount_usd: 425.00,
      local_amount: 0, local_currency: "GHS",
      fx_mid: 15.52, fx_eff: 15.598, method: "momo",
      status: "failed", created: daysAgo(6), settled: null,
      wht: 0, ref: null,
    },
    // Duplicate (idempotency replay)
    {
      id: uuid(), agent_id: keId, amount_usd: 782.43,
      local_amount: 101_499.0, local_currency: "KES",
      fx_mid: 129.8, fx_eff: 130.449, method: "momo",
      status: "duplicate", created: daysAgo(3), settled: null,
      wht: 5_075.0, ref: "momo_ref_ke_001",
    },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO payout_logs
      (id, agent_id, tenant_id, amount_usd, local_amount, local_currency,
       fx_mid_rate, fx_effective_rate, fx_rate_id, method,
       idempotency_key, signature, status, provider_reference, failure_reason,
       withholding_tax_local, regulatory_report_filed, created_at, settled_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);

  for (const log of logs) {
    const ikey = hmac(`${log.agent_id}:${log.amount_usd}:${log.method}:${TENANT_ID}:${log.id}`);
    const sig  = signPayoutEntry(
      ikey, log.agent_id, log.amount_usd, log.local_amount,
      log.local_currency, log.fx_eff, log.status, log.created
    );
    stmt.run(
      log.id, log.agent_id, TENANT_ID, log.amount_usd, log.local_amount,
      log.local_currency, log.fx_mid, log.fx_eff, uuid(), log.method,
      ikey, sig, log.status, log.ref ?? null,
      log.status === "failed" ? "Provider rejected — insufficient funds" : null,
      log.wht, log.created, log.settled ?? null
    );
    console.log(
      `    ✓ ${log.status.padEnd(11)} ` +
      `$${log.amount_usd.toString().padStart(9)} USD → ` +
      `${log.local_currency} ${log.local_amount.toLocaleString().padStart(12)}`
    );
  }
}

// ─── Anomaly Logs ─────────────────────────────────────────────────────────────

function seedAnomalyLogs(
  db: ReturnType<typeof openDatabase>,
  agentIds: string[]
): void {
  console.log("  Seeding anomaly logs…");

  const [ghId, ngId, , , gbId, usId] = agentIds;

  const anomalies = [
    {
      id: uuid(), entity_id: ngId, entity_type: "agent",
      event_type: "rapid_balance_drain", observed_value: 0.85,
      risk_level: "high", score: 75,
      context: { drain_fraction: 0.85, previous_balance_usd: 5000 },
      lockout: "hard", lockout_until: daysAgo(-1),
      created: hoursAgo(6),
    },
    {
      id: uuid(), entity_id: usId, entity_type: "agent",
      event_type: "large_single_transfer", observed_value: 12_300,
      risk_level: "high", score: 60,
      context: { amount_usd: 12_300, threshold: 10_000 },
      lockout: null, lockout_until: null,
      created: hoursAgo(3),
    },
    {
      id: uuid(), entity_id: gbId, entity_type: "agent",
      event_type: "off_hours_payout", observed_value: 2,
      risk_level: "medium", score: 25,
      context: { hour_utc: 2, amount_usd: 7_437.50 },
      lockout: "soft", lockout_until: hoursAgo(-1),
      created: daysAgo(1),
    },
    {
      id: uuid(), entity_id: "192.168.1.105", entity_type: "ip",
      event_type: "failed_auth_burst", observed_value: 12,
      risk_level: "high", score: 65,
      context: { failed_attempts: 12, window_minutes: 10 },
      lockout: "hard", lockout_until: hoursAgo(-20),
      created: daysAgo(2),
    },
    {
      id: uuid(), entity_id: ghId, entity_type: "agent",
      event_type: "high_frequency_payout", observed_value: 6,
      risk_level: "medium", score: 40,
      context: { payout_count: 6, window_minutes: 60, max_allowed: 3 },
      lockout: "soft", lockout_until: hoursAgo(-2),
      created: daysAgo(3),
    },
    {
      id: uuid(), entity_id: "user-attacker-001", entity_type: "user",
      event_type: "shadow_scan_trigger", observed_value: 1,
      risk_level: "critical", score: 85,
      context: { reason: "cross_tenant_access_attempt" },
      lockout: "shadow", lockout_until: daysAgo(-7),
      created: daysAgo(5),
    },
    {
      id: uuid(), entity_id: ngId, entity_type: "agent",
      event_type: "threshold_spike", observed_value: 4_800,
      risk_level: "low", score: 18,
      context: { balance_usd: 4_800, threshold_usd: 200 },
      lockout: null, lockout_until: null,
      created: daysAgo(7),
    },
    {
      id: uuid(), entity_id: "10.0.0.55", entity_type: "ip",
      event_type: "policy_reload_flood", observed_value: 18,
      risk_level: "medium", score: 35,
      context: { reloads_per_minute: 18 },
      lockout: "soft", lockout_until: hoursAgo(-1),
      created: daysAgo(1),
    },
  ];

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO anomaly_logs
      (id, entity_id, entity_type, tenant_id, event_type, observed_value,
       risk_level, score, context_json, lockout_applied, lockout_until,
       alert_dispatched, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `);

  for (const a of anomalies) {
    stmt.run(
      a.id, a.entity_id, a.entity_type, TENANT_ID,
      a.event_type, a.observed_value, a.risk_level, a.score,
      JSON.stringify(a.context), a.lockout ?? null,
      a.lockout_until ?? null, a.created
    );
    console.log(
      `    ✓ ${a.risk_level.padEnd(9)} score:${String(a.score).padStart(3)}  ` +
      `${a.event_type}`
    );
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n╔══════════════════════════════════════╗");
  console.log("║   CaaS-Lite  Mock Data Seed Script   ║");
  console.log("╚══════════════════════════════════════╝\n");

  const db = openDatabase();
  console.log(`Database: ${process.env.DB_PATH ?? "/data/caas_evidence.db"}\n`);

  if (isAlreadySeeded(db)) {
    console.log("⚠  Database already contains seed data for tenant-demo-001.");
    console.log("   Delete data/caas_evidence.db and re-run migrations to reseed.\n");
    db.close();
    return;
  }

  console.log("Inserting seed data…\n");

  await seedUsers(db);
  console.log();

  const agentIds = seedAgents(db);
  console.log();

  seedFxRates(db);
  console.log();

  seedPayoutLogs(db, agentIds);
  console.log();

  seedAnomalyLogs(db, agentIds);
  console.log();

  // ── Summary ──────────────────────────────────────────────────────────────
  const counts = {
    users:    (db.prepare("SELECT COUNT(*) as n FROM users    WHERE tenant_id=?").get(TENANT_ID) as {n:number}).n,
    agents:   (db.prepare("SELECT COUNT(*) as n FROM agents   WHERE tenant_id=?").get(TENANT_ID) as {n:number}).n,
    payouts:  (db.prepare("SELECT COUNT(*) as n FROM payout_logs WHERE tenant_id=?").get(TENANT_ID) as {n:number}).n,
    anomalies:(db.prepare("SELECT COUNT(*) as n FROM anomaly_logs WHERE tenant_id=?").get(TENANT_ID) as {n:number}).n,
    fx_rates: (db.prepare("SELECT COUNT(*) as n FROM fx_rate_cache").get() as {n:number}).n,
  };

  console.log("╔══════════════════════════════════════╗");
  console.log("║              Seed Summary            ║");
  console.log("╠══════════════════════════════════════╣");
  console.log(`║  Tenant ID : ${TENANT_ID}  ║`);
  console.log(`║  Users     : ${String(counts.users).padEnd(27)}║`);
  console.log(`║  Agents    : ${String(counts.agents).padEnd(27)}║`);
  console.log(`║  Payouts   : ${String(counts.payouts).padEnd(27)}║`);
  console.log(`║  Anomalies : ${String(counts.anomalies).padEnd(27)}║`);
  console.log(`║  FX rates  : ${String(counts.fx_rates).padEnd(27)}║`);
  console.log("╠══════════════════════════════════════╣");
  console.log("║  Test credentials:                   ║");
  console.log("║  exec_demo    / ExecPass123!         ║");
  console.log("║  auditor_demo / AuditPass123!        ║");
  console.log("║  partner_demo / PartnerPass123!      ║");
  console.log("╚══════════════════════════════════════╝\n");

  db.close();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
