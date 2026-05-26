# CaaS Platform — Technical Architecture Stack
### Definitive Technology Registry | Version 1.0 | 26 May 2026

---

## Guiding Principle: Build On What Exists

The live stack is Node.js/TypeScript + Express + SQLite on Fly.io. The MVP does NOT migrate databases, runtimes, or hosting providers. Every technology decision below extends the existing deployment rather than replacing it.

---

## 1. Full Stack Map

```
┌─────────────────────────────────────────────────────────────────┐
│  CLIENT LAYER                                                    │
│  Browser (app.aitwcloud.com) ─── Partner Browser (/partner)    │
│  Embedded Badge (<img> / <script> on client websites)           │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS
┌────────────────────────▼────────────────────────────────────────┐
│  EDGE / DNS LAYER                                               │
│  Cloudflare DNS (aitwcloud.com)                                 │
│  Grey-cloud: api.aitwcloud.com → Fly.io                        │
│  (Future: orange-cloud for WAF/DDoS on public badge routes)     │
└────────────────────────┬────────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────────┐
│  APPLICATION LAYER  (Fly.io — single machine, ord region)       │
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Node.js 20 / TypeScript  ─── Express 4                  │  │
│  │                                                           │  │
│  │  Route Groups:                                            │  │
│  │  /api/v1/auth          JWT login, refresh, logout        │  │
│  │  /api/v1/ingest        Webhook event receiver            │  │
│  │  /api/v1/vault         Evidence Vault CRUD + export      │  │
│  │  /api/v1/dashboard     Aggregated summary data           │  │
│  │  /api/v1/admin         User/tenant CRUD (Executive only) │  │
│  │  /api/v1/partner       Partner portal API                │  │
│  │  /api/v1/billing       Paystack/Stripe webhooks          │  │
│  │  /api/v1/fx            FX rates (existing)               │  │
│  │  /badge/:tenant_id     Public badge SVG                  │  │
│  │  /badge/:tenant_id/report  Public scorecard HTML         │  │
│  │  /dashboard            Executive Dashboard (HTML)        │  │
│  │  /partner/register     Partner onboarding form           │  │
│  │  /healthz  /readyz     Health checks                     │  │
│  │                                                           │  │
│  │  Middleware Stack (in order):                             │  │
│  │  tini (PID 1) → Litestream → Node                        │  │
│  │  helmet → CORS → express-rate-limit → auth JWT           │  │
│  │  → route handlers → 404 catch-all                        │  │
│  │                                                           │  │
│  │  Background Workers (in-process):                        │  │
│  │  BullMQ (Redis-less mode via SQLite queue table)         │  │
│  │  VerificationWorker — processes scan_events              │  │
│  │  PayoutWorker       — processes commission payouts       │  │
│  │  VaultHashWorker    — maintains hash chain integrity     │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  DATA LAYER                                             │    │
│  │  SQLite (single file: /data/caas.db)                   │    │
│  │  Litestream → Cloudflare R2 (continuous WAL repl.)     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘

EXTERNAL SERVICES
├── Paystack          — Primary payment (MoMo, cards, Africa/EM)
├── Stripe            — Secondary payment (international cards)
├── Resend            — Transactional email (welcome, alerts)
├── Cloudflare R2     — Litestream backup destination (existing)
└── Bitwarden (ops)   — Secrets management (ops convention)
```

---

## 2. Technology Decisions — Layer by Layer

### 2.1 Runtime & Framework

| Technology | Version | Role | Decision Rationale |
|---|---|---|---|
| Node.js | 20 LTS | Runtime | Already deployed; LTS until 2026-04-30 |
| TypeScript | 5.x | Language | Already in use; `src/` compiles to `dist/` |
| Express | 4.x | HTTP framework | Already in use; no migration needed |
| tini | Latest | PID 1 | Already in Dockerfile; correct signal handling |

**No migration to Next.js or Bun for MVP.** The frontend will be upgraded from vanilla HTML to a compiled React SPA served as static files from the same Express app. This avoids a second deployment target and keeps the architecture simple for MVP.

### 2.2 Frontend

| Technology | Version | Role |
|---|---|---|
| React | 18 | UI component library |
| Vite | 5.x | Build tool (fast, zero-config) |
| React Router | 6 | Client-side routing (SPA) |
| Tailwind CSS | 3.x | Utility-first styling |
| Recharts | 2.x | Compliance charts / drift maps |
| SWR | 2.x | Data fetching / cache / revalidation |

**Build output:** `vite build` produces a `dist/` folder. Express serves `dist/index.html` for all non-API routes via `express.static`. This approach replaces the current inline-HTML dashboard with a proper SPA at `app.aitwcloud.com` (once the subdomain is configured) while keeping zero additional deployments.

**The `app.aitwcloud.com` subdomain** will serve the same Fly app once a Cloudflare CNAME is added pointing to `caas-lite.fly.dev`. The frontend talks to `api.aitwcloud.com`. CORS config already supports multiple origins.

### 2.3 Database

| Technology | Role |
|---|---|
| SQLite (better-sqlite3) | Primary database — already deployed, single file |
| Litestream | Continuous WAL replication to R2 — already deployed |
| Cloudflare R2 | Backup destination — already deployed |

**No migration to PostgreSQL/Supabase for MVP.** SQLite is sufficient for single-tenant MVP load. The schema is designed with clear `tenant_id` partitioning so a future migration to PostgreSQL is mechanical, not architectural.

**Worker Queue:** Rather than adding Redis (a new infrastructure dependency), the background worker queue is implemented as a `job_queue` SQLite table polled every 2 seconds. This is adequate for MVP throughput (< 1,000 verification runs/day). BullMQ with Redis is the upgrade path when throughput demands it.

### 2.4 Authentication & Security

| Technology | Role |
|---|---|
| argon2 (0.44.0) | Password hashing — already deployed |
| jsonwebtoken | JWT access (15 min) + refresh (7 days) tokens — already deployed |
| express-rate-limit | Per-route rate limiting — already deployed (being fixed) |
| helmet | Security headers — already in middleware |
| crypto (Node built-in) | API key generation (`randomBytes(24).toString('base64url')`) |

### 2.5 Payment & Billing

| Technology | Role | When |
|---|---|---|
| Paystack Node SDK | Primary: MoMo (MTN/Vodafone/Airtel), card payments, Africa | Session 6 |
| Paystack Transfer API | Partner commission payouts to MoMo/bank | Session 7 |
| Stripe Node SDK | Secondary: international card processing | Session 6 |
| Chargebee (or Stripe Billing) | Subscription lifecycle management (tiers, trials, invoicing) | Session 6 |

**Paystack is the primary gateway** because the target market (Africa/EM) and partner network are MoMo-first. Stripe handles overflow international clients.

### 2.6 Email

| Technology | Role |
|---|---|
| Resend | Transactional email (partner welcome, compliance alerts, invoice notifications) |

Resend is chosen over SendGrid for its developer-friendly API and generous free tier. Integration is a single `npm install resend` and one API key secret.

### 2.7 PDF Generation (Evidence Vault Export)

| Technology | Role |
|---|---|
| Puppeteer (headless Chrome) | Renders the vault export HTML → PDF |

Puppeteer is already a common pattern for PDF generation in Node. The vault export endpoint renders an HTML template of the audit log and uses Puppeteer to produce a cryptographically-signable PDF. Alternative: `pdfkit` (lighter, no headless browser needed) — use pdfkit first; escalate to Puppeteer only if complex formatting is required.

### 2.8 Document Signing (Evidence Vault)

| Technology | Role |
|---|---|
| node-forge | SHA-256 hash generation for vault records + hash chain |

No external PKI needed for MVP. The hash chain itself is the tamper-evidence mechanism. A signed PDF export adds the tenant name, export timestamp, and chain root hash as metadata.

### 2.9 Deployment & Infrastructure

| Technology | Role | Status |
|---|---|---|
| Fly.io | Application hosting | ✅ Live |
| Fly Volumes | SQLite persistent storage | ✅ Live |
| Cloudflare DNS | Domain management | ✅ Live |
| Cloudflare R2 | Litestream backup destination | ✅ Live |
| GitHub | Source control | Assumed (from git workflow) |
| GitHub Actions | CI/CD (lint, test, deploy) | To be configured |

**Staging environment:** A second Fly app (`caas-lite-staging`) with a separate R2 bucket. Identical config; different secrets. To be created alongside Session 1 work.

---

## 3. How the Components Connect

```
Browser SPA (React/Vite)
    │
    ├─ GET /api/v1/dashboard/summary   ← Executive Dashboard data
    ├─ POST /api/v1/ingest/events      ← Client AI system sends events
    ├─ GET /api/v1/vault/export        ← PDF download
    ├─ POST /api/v1/admin/users        ← Create/manage users
    └─ POST /api/v1/billing/subscribe  ← Initiate subscription
           │
           ▼
    Express API (Node/TS)
           │
    ├─ better-sqlite3 ──→ /data/caas.db ──→ Litestream ──→ R2
    │
    ├─ Job Queue (SQLite table: job_queue)
    │       │
    │       ├─ VerificationWorker ──→ verification_results table
    │       ├─ VaultHashWorker   ──→ vault_records table (hash chain)
    │       └─ PayoutWorker      ──→ Paystack Transfer API
    │
    ├─ Paystack SDK ──→ Paystack API (payments + payouts)
    ├─ Stripe SDK   ──→ Stripe API (international cards)
    ├─ Resend SDK   ──→ Resend API (transactional email)
    └─ node-forge   ──→ SHA-256 hashing (in-process)

Public Routes (no auth):
    /badge/:tenant_id        ──→ SVG from dashboard/summary
    /badge/:tenant_id/report ──→ HTML scorecard
```

---

## 4. Environment Variables (Complete List)

All set via `fly secrets set`. Never committed to the repo.

```bash
# Existing (already set)
JWT_ACCESS_SECRET
JWT_REFRESH_SECRET
LITESTREAM_BUCKET
LITESTREAM_REGION
LITESTREAM_ACCESS_KEY_ID
LITESTREAM_SECRET_ACCESS_KEY
CORS_ORIGINS
RATE_LIMIT_ALLOW_UNKNOWN_TIER    # workaround; remove after bug fix

# To add (Session 1)
APP_URL=https://app.aitwcloud.com
API_URL=https://api.aitwcloud.com

# To add (Session 5)
RESEND_API_KEY

# To add (Session 6)
PAYSTACK_SECRET_KEY
PAYSTACK_WEBHOOK_SECRET
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
CHARGEBEE_SITE
CHARGEBEE_API_KEY

# Optional (observability — not MVP blocking)
PROMETHEUS_METRICS_TOKEN
LOGTAIL_SOURCE_TOKEN
```

---

## 5. Local Development Setup

```bash
# Clone and install
git clone <repo>
npm install

# Build frontend
cd frontend && npm install && npm run build && cd ..

# Local dev (hot reload API + Vite dev server)
npm run dev           # starts Express on :8080
cd frontend && npm run dev   # starts Vite on :5173

# Run the compiled output (mirrors production)
npm run build && node dist/index.js

# SQLite inspection
sqlite3 data/caas.db ".tables"
sqlite3 data/caas.db ".schema users"
```

**docker-compose.yml** already exists for local convenience. Extend it with a `frontend` service running `vite preview` to test the full production build locally.
