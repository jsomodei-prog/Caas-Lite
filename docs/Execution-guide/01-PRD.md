# CaaS Platform — Product Requirements Document (PRD)
### MVP Definition | Version 1.0 | 26 May 2026

---

## 1. Context & Current Baseline

The backend is live. As of 25 May 2026, the following is confirmed deployed and working at `caas-lite.fly.dev`:

| Component | Status |
|---|---|
| Node.js/TypeScript + Express API | ✅ Live |
| SQLite + Litestream → Cloudflare R2 | ✅ Live, replicating |
| argon2 + JWT auth (login/refresh) | ✅ Proven in production |
| Basic HTML Executive Dashboard | ✅ Served at `/dashboard` |
| Multi-tenant `accounts` + `users` schema | ✅ Live (3 users, 1 tenant) |
| Health/readiness endpoints | ✅ Live |
| Rate limiter (with known limit-0 bug) | ⚠️ Live but buggy |
| User management UI | ❌ Not built |
| Verification Engine | ❌ Not built |
| Evidence Vault UI | ❌ Not built |
| Shadow Scan / Compliance Gap Report | ❌ Not built |
| Trust Badge | ❌ Not built |
| Partner Portal | ❌ Not built |
| Payment integration | ❌ Not built |

The MVP must activate the core value loop: **Connect → Scan → Report → Badge → Monetise.**

---

## 2. MVP Scope: What We Are Building

### The Core Value Loop
```
SMB connects webhook → Shadow Scan runs (non-blocking) → 
Gap Report generated → Evidence Vault logs it → 
Trust Badge issued → Subscription offered
```

### What Is Explicitly OUT of MVP Scope
- Kubernetes Production Monitor sidecars (Enterprise tier feature)
- Full CI/CD Compliance Gates (Growth tier, post-MVP)
- Multi-region JSON Policy Maps beyond EU AI Act + GDPR
- White-label multi-tenancy UI (reseller configuration)
- AI Bill of Materials (AI-BoM) module
- Scenario Modelling / Predictive Analytics
- Insurance Partner API integration (partnership negotiated separately)
- Fraud detection integrations (Sift, Feedzai)

---

## 3. MVP Features (Prioritised)

### P0 — Must Ship (Blocks Everything Else)

#### P0.1 — Critical Bug Fixes (Session 1)
**Problem:** Three production bugs block clean operation.
- `limit-0` sentinel: rate limiter returns fake 429 when `X-CaaS-Tier` header is absent → returns HTTP 400 with `{"error":"Tier header required"}`
- Root path `/` returns JSON 429 instead of redirecting → `app.get('/', (_,res) => res.redirect('/dashboard'))`
- Dashboard ribbon shows hardcoded `client partner` regardless of logged-in role

**Acceptance Criteria:**
- `GET /` returns 302 → `/dashboard`
- Any request missing `X-CaaS-Tier` returns 400, not 429
- Ribbon reflects the actual `plane_role` of the authenticated user

#### P0.2 — User & Tenant Management UI (Session 2)
**Problem:** Executives cannot create or manage users without direct DB access.

**Features:**
- Executive can view list of all users in their tenant
- Executive can create a new user (username, email, role, password set by admin)
- Executive can deactivate/reactivate a user
- Executive can change a user's role
- Executive can view their tenant's tier and API key (masked, with a "Reveal" action)
- Tenant's `accounts` row automatically created on first user bootstrap if absent

**Acceptance Criteria:**
- All CRUD actions available via UI without touching the DB directly
- All actions written to audit log
- No self-registration endpoint exposed publicly (controlled by `ENABLE_PUBLIC_REGISTRATION`)

#### P0.3 — API Key Auth Path (Session 2)
**Problem:** The `api_key_hash` column exists but the verify code path is unconfirmed.

**Features:**
- `Authorization: Bearer aitw_<key>` header on any authenticated endpoint resolves to the tenant
- Returns 401 with clear error if key is invalid or tenant is suspended
- Integration team documented with working Postman/cURL example

**Acceptance Criteria:**
- A request using the integration test user's API key returns 200 on a protected endpoint
- An invalid key returns `{"error":"Invalid API key"}` with 401

---

### P1 — Core Product (The Reason Clients Sign Up)

#### P1.1 — Configuration API / Webhook Hook (Session 3)
**Problem:** No mechanism exists to receive client AI decision logs.

**Features:**
- `POST /api/v1/ingest/events` — authenticated endpoint accepting a JSON payload of AI decision events
- Payload schema: `{ model_id, decision_type, input_hash, output_summary, timestamp, metadata }`
- Validates structure, tags the event to the tenant and the originating partner's `agent_id` (if applicable)
- Stores raw event in `scan_events` table
- Emits an internal queue job for the Verification Engine to process

**Acceptance Criteria:**
- A `curl` POST with a valid JWT returns 202 with an `event_id`
- A malformed payload returns 400 with field-level validation errors
- Events appear in the `scan_events` table tagged with `tenant_id`

#### P1.2 — Verification Engine (Session 4)
**Problem:** No automated compliance checking exists.

**Features:**
- Background worker (in-process queue, BullMQ or similar) picks up events from P1.1
- Runs a set of JSON Policy Map checks against each event:
  - **GDPR Check:** Was PII present in output? (keyword scan on `output_summary`)
  - **EU AI Act — High Risk Check:** Does `decision_type` match a configured high-risk category (credit, hiring, medical)?
  - **Fairness Check:** Is a `demographic_parity_ratio` field present and above 0.8?
- Produces a `verification_result`: `PASS | WARN | FAIL` with a reason code
- Stores result in `verification_results` table linked to `event_id`
- If `FAIL`, creates an alert in `compliance_alerts` table

**Acceptance Criteria:**
- A submitted event with `decision_type: "credit_scoring"` produces a verification result within 5 seconds
- A `FAIL` result creates a visible alert in the Executive Dashboard
- Verification latency P95 < 2 seconds (per brief success metrics)

#### P1.3 — Immutable Evidence Vault (Session 4)
**Problem:** No tamper-evident audit trail exists.

**Features:**
- Every `verification_result` is hashed (SHA-256 of the JSON payload) and the hash stored alongside the record
- Hash chain: each record's hash includes the previous record's hash (append-only ledger)
- `GET /api/v1/vault/export` — authenticated endpoint returning a signed PDF of the Evidence Vault log for the tenant's date range
- Vault records are never updated, only appended

**Acceptance Criteria:**
- An exported PDF shows: event ID, timestamp, model ID, decision type, result, hash
- Modifying a vault record in the DB breaks the hash chain (detectable by the engine on next run)
- Export works for the pilot SMB scenario: "100% traceability for every loan decision"

#### P1.4 — Shadow Scan Dashboard (Session 5)
**Problem:** Executive Dashboard shows no real data.

**Features (replacing the current static HTML dashboard):**
- **Compliance Health Score** — percentage of PASS results over the last 30 days
- **Real-time Drift Map** — chart of PASS/WARN/FAIL counts per day (7-day rolling)
- **Alert Feed** — list of FAIL events with reason codes, unread badge count
- **Model Activity** — table of active `model_id` values with last-seen timestamp and result status
- **Vault Status** — total records, last hash, export button
- Dashboard data served from `GET /api/v1/dashboard/summary` (tenant-scoped)

**Acceptance Criteria:**
- Dashboard shows real data from submitted events within 30 seconds of ingestion
- All data is scoped to the authenticated user's `tenant_id`; no cross-tenant data leakage
- "One-click export" of the Evidence Vault PDF from the dashboard

---

### P2 — Monetisation & Growth (What Turns the Pilot Into Revenue)

#### P2.1 — Trust Badge (Session 6)
**Problem:** No public-facing proof of compliance exists.

**Features:**
- `GET /badge/:tenant_id` — public, unauthenticated route returning an SVG badge
- Badge displays: Compliance Health Score, last verified timestamp, "Powered by CaaS" mark
- Badge is dynamic (score updates in real time)
- Clicking the badge opens `GET /badge/:tenant_id/report` — a read-only HTML page showing the Executive Scorecard (aggregated, no raw event data)
- Each tenant gets an embeddable `<script>` snippet and an `<img>` tag to put on their website

**Acceptance Criteria:**
- Badge loads in < 500ms
- Report page accessible without login
- Tenant cannot see another tenant's badge report

#### P2.2 — Payment Integration (Session 6)
**Problem:** No billing mechanism exists; the platform cannot generate revenue.

**Features:**
- **Paystack** integration (primary — supports GHS/NGN/KES MoMo and cards)
- **Stripe** integration (secondary — international cards)
- Subscription tiers enforced at the API level:
  - `LITE` — 1 active model, 500 verification runs/month, 1-year vault
  - `GROWTH` — 5 models, 5,000 runs/month, 3-year vault
  - `ENTERPRISE` — unlimited models, unlimited runs, 7-year vault
- Subscription engine: Chargebee or Stripe Billing manages tier, trial, invoicing
- "Kill Switch": Configuration API checks billing status before allowing a Verification Engine run; suspended accounts receive `402 Payment Required`
- Webhook handlers for: `payment.success`, `payment.failed`, `subscription.cancelled`

**Acceptance Criteria:**
- A LITE tenant that exhausts their 500 runs receives 402 on the 501st run
- A successful Paystack payment upgrades the tenant's `tier` in the `accounts` table
- A cancelled subscription triggers `status: suspended` within 24 hours

#### P2.3 — Partner / Freelancer Portal (Session 7)
**Problem:** No mechanism to onboard or pay external sales agents.

**Features:**
- `/partner/register` — public onboarding form: name, email, country, MoMo/bank details
- On approval, system generates `CAAS-REF-ID` and sends a welcome email with Partner Portal link
- Partner Portal (`/partner/dashboard`):
  - View referred clients and their subscription status
  - Run "Lure Tool" (lightweight Pre-Audit Scan): submits a prospect's webhook URL, runs a 7-day shadow scan, generates a Compliance Gap Report PDF
  - View commission ledger: pending, settled, total earned
- **Payout Engine:**
  - 15% commission on first payment from a referred client
  - Commission calculated automatically when a client's invoice is settled
  - Payout pushed to partner's MoMo or bank via Paystack Transfer API
- Each partner gets a unique `referral_code`; clients signing up with it are permanently tagged

**Acceptance Criteria:**
- A partner can register, receive their ID, log in to the Partner Portal, and generate a Gap Report for a prospect
- When a referred client pays invoice #1, the partner's `pending_balance` is credited within 5 minutes
- Payout is initiated automatically once client payment clears (Paystack settlement window)

---

## 4. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Verification latency | P95 < 2 seconds |
| API uptime | 99.5% monthly |
| Evidence Vault integrity | 100% hash chain valid at all times |
| Cross-tenant data isolation | Zero leakage — enforced at query level by `WHERE tenant_id = ?` on every query |
| Auth token expiry | Access: 15 min, Refresh: 7 days |
| Rate limiting (post-fix) | LITE: 60 req/min, GROWTH: 300 req/min, ENTERPRISE: 1000 req/min |
| Backup RPO | < 5 seconds (Litestream continuous replication) |
| Backup RTO | < 30 minutes (Litestream restore from R2) |

---

## 5. Success Metrics for MVP Launch

| Metric | Target |
|---|---|
| First paying SMB | Within 30 days of MVP completion |
| Pilot completions (30-day shadow scan) | 3 SMBs through full cycle |
| Partner agents onboarded | 10 certified agents |
| Compliance Health Score displayed | 100% of dashboards |
| Evidence Vault exports | Working for all active tenants |
| Bug count (P0/P1 severity) | 0 open at launch |
