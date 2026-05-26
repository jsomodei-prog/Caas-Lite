# CaaS Platform — Step-by-Step Sprint Roadmap
### Session Breakdown | Version 1.0 | 26 May 2026

---

## How to Read This

Each **Session** is a focused 2–4 hour working block with a single dominant goal. Sessions are ordered by dependency — each builds directly on the last. No session skips ahead without its predecessor being complete.

**Definition of Done** for each session: The listed acceptance criteria pass, the code is committed and pushed to `master`, and the Fly app is successfully redeployed (`fly deploy` returns clean).

---

## Session 0 — Environment Hardening
**Duration:** 1–2 hours | **Depends on:** Nothing | **PRD Reference:** P0.1

### Goal
Fix the three known production bugs that create noise and confusion, so every subsequent session starts on a clean foundation.

### Tasks

1. **Fix root-path 429 bug**
   - Add `app.get('/', (_req, res) => res.redirect(301, '/dashboard'))` before the rate limiter in `app.js`
   - Add `'/'` to `bypassPaths` as a safety net

2. **Fix limit-0 sentinel bug**
   - In `src/middleware/rateLimiter.ts`, function `evaluateRateLimit`:
     - When `resolveTier()` returns null and `allowUnknownTier` is false → return HTTP 400 `{"error":"Tier header required or invalid"}`
     - Remove the misleading `tier: "PAY_AS_YOU_GO"` from the 400 response
   - Remove `RATE_LIMIT_ALLOW_UNKNOWN_TIER=true` Fly secret once fix is deployed

3. **Fix dashboard ribbon role label**
   - Locate the dashboard HTML where `client partner` is hardcoded
   - Replace with the `plane_role` value from the decoded JWT returned on login
   - Store decoded user in `state.user` after login; render `state.user.plane_role` in the ribbon

4. **Set up staging environment**
   - `fly launch --no-deploy --name caas-lite-staging --region ord --copy-config`
   - Create a separate R2 bucket `caas-lite-staging-backups`
   - Set all secrets on the staging app
   - `fly deploy -a caas-lite-staging` — confirm staging is live at `caas-lite-staging.fly.dev/dashboard`

5. **Set up GitHub Actions CI/CD**
   - Create `.github/workflows/deploy.yml`:
     - On push to `master`: run `npm ci && npm run build && fly deploy -a caas-lite`
     - On push to `staging` branch: `fly deploy -a caas-lite-staging`
   - Add `FLY_API_TOKEN` to GitHub repo secrets

### Done When
- `GET https://caas-lite.fly.dev/` → 301 to `/dashboard`
- `GET https://api.aitwcloud.com/some-nonexistent-path` (no tier header) → 400 JSON, not 429
- Dashboard ribbon shows `client_executive` for `odeijsom` user
- Staging is accessible and mirrors production behaviour
- GitHub Actions deploys on push to `master`

---

## Session 1 — Database Migrations & API Key Auth
**Duration:** 2–3 hours | **Depends on:** Session 0 | **PRD Reference:** P0.2, P0.3

### Goal
Run the schema migrations that all future features depend on. Prove the API key auth path works end-to-end.

### Tasks

1. **Create migration runner**
   - Create `src/db/migrate.ts` — reads SQL files from `src/db/migrations/`, tracks applied migrations in a `schema_migrations` table, runs new ones at startup
   - Call `runMigrations()` at boot before `app.listen`

2. **Write and run migrations 001–004** (as defined in the Database Schema Blueprint)
   - `001_extend_accounts.sql` — add billing, run-count, referral columns
   - `002_extend_users.sql` — add `created_by`, `last_login_at`, deactivation columns
   - `003_new_tables.sql` — create all new tables with triggers and indexes
   - `004_seed_policies.sql` — insert the three starter JSON Policy Map rules

3. **Verify and fix API key auth path**
   - Search `dist/routes/auth.js` for `api_key_hash` usage; document what exists
   - If the verify path is incomplete: add middleware `src/middleware/apiKeyAuth.ts` that:
     - Reads `Authorization: Bearer aitw_<key>` header
     - Looks up `accounts` by `api_key_prefix` (first 12 chars), then calls `argon2.verify`
     - On success, sets `req.tenantId` and `req.authMethod = 'api_key'`
   - Apply this middleware to protected routes as an alternative to JWT auth

4. **Update `last_login_at`**
   - After successful login in `src/routes/auth.ts`, `UPDATE users SET last_login_at = ? WHERE id = ?`

5. **Write integration test** (manual, documented)
   - Use `akasiodei` user's API key: `curl -H "Authorization: Bearer aitw_<key>" https://api.aitwcloud.com/api/v1/dashboard/summary`
   - Expected: 200 with placeholder summary data (not 401)
   - Document this example in the repo `README.md` for the integration team

### Done When
- `sqlite3 /data/caas.db ".tables"` shows all new tables
- `sqlite3 /data/caas.db "SELECT check_name FROM json_policy_maps"` returns 3 rows
- API key auth works: `curl -H "Authorization: Bearer aitw_<key>" ...` → 200
- Migration runner logs "Applied 4 migrations" on first boot, "0 new migrations" on subsequent boots

---

## Session 2 — User & Tenant Management API + UI
**Duration:** 3–4 hours | **Depends on:** Session 1 | **PRD Reference:** P0.2

### Goal
Executives can manage users entirely through the UI. No more direct DB access needed for day-to-day operations.

### Tasks

1. **Build User Management API routes** (`src/routes/admin.ts`)
   ```
   GET    /api/v1/admin/users              — list all users in tenant
   POST   /api/v1/admin/users              — create user
   PATCH  /api/v1/admin/users/:id          — update role, deactivate, reactivate
   GET    /api/v1/admin/tenant             — view tenant account details + tier
   GET    /api/v1/admin/tenant/api-key     — reveal masked API key (prefix + "...")
   POST   /api/v1/admin/tenant/api-key/rotate — generate new API key
   ```
   - All routes gated to `plane_role IN ('client_super_admin', 'client_executive')`
   - All actions written to `audit_log`
   - User creation: generate UUID, argon2-hash the provided password, insert into `users` + `user_profiles`

2. **Upgrade Executive Dashboard frontend**
   - Set up Vite + React project in `frontend/` directory
   - Implement a basic layout: sidebar nav + main content area (Tailwind)
   - Implement screens:
     - **Users** — table of users, "New User" button → modal form, inline deactivate/reactivate toggle
     - **Account Settings** — tenant name, tier badge, API key display with masked reveal, copy button
   - Wire all screens to the new API endpoints via `fetch`

3. **Express serves the React build**
   - `vite build` outputs to `frontend/dist/`
   - Express: `app.use(express.static(path.join(__dirname, '../frontend/dist')))` (before rate limiter, so static assets bypass it)
   - `app.get(['/app', '/app/*'], (_, res) => res.sendFile('index.html', { root: 'frontend/dist' }))`

### Done When
- Executive can log in, navigate to Users, and create a new user with a role and password
- New user can log in using the password set by the Executive
- Deactivating a user prevents that user from logging in (401 on next attempt)
- Tenant API key is visible (masked) on the Account Settings screen
- No direct DB access required for any of the above

---

## Session 3 — Event Ingestion API (The "Hook")
**Duration:** 2–3 hours | **Depends on:** Session 1 | **PRD Reference:** P1.1

### Goal
The platform can receive AI decision events from client systems via a webhook.

### Tasks

1. **Build ingestion endpoint** (`src/routes/ingest.ts`)
   ```
   POST /api/v1/ingest/events
   ```
   - Accepts JWT auth OR API key auth
   - Validates payload: `model_id` (required), `decision_type` (required), `timestamp` (required ISO 8601), `output_summary` (optional), `input_hash` (optional), `metadata` (optional JSON)
   - Inserts into `scan_events` with `processing_status: 'pending'`
   - Denormalises `agent_id` from `accounts.referral_agent_id` onto the event row
   - Enqueues a job in `job_queue`: `{job_type: 'verification', payload: {event_id}}`
   - Returns 202 `{"event_id": "evt_...", "status": "accepted"}`

2. **Rate limit by tier**
   - Check `accounts.run_count_this_month >= run_limit_monthly` → if true, return 402 `{"error":"Monthly verification limit reached. Upgrade your plan."}`
   - On acceptance, `UPDATE accounts SET run_count_this_month = run_count_this_month + 1`
   - Reset `run_count_this_month` on the 1st of each month via a scheduled job

3. **Test with simulated client payload**
   ```bash
   curl -X POST https://api.aitwcloud.com/api/v1/ingest/events \
     -H "Authorization: Bearer <jwt>" \
     -H "X-CaaS-Tier: GROWTH" \
     -H "Content-Type: application/json" \
     -d '{
       "model_id": "credit-model-v2",
       "decision_type": "credit_scoring",
       "timestamp": "2026-05-26T09:00:00Z",
       "output_summary": "Loan approved based on income and credit history",
       "metadata": {"demographic_parity_ratio": 0.75}
     }'
   ```

### Done When
- The above `curl` returns 202 with an `event_id`
- A row exists in `scan_events` with `processing_status: 'pending'`
- A row exists in `job_queue` with `job_type: 'verification'`
- Sending a 6th event on a LITE account (limit 5 for test) returns 402

---

## Session 4 — Verification Engine + Evidence Vault
**Duration:** 3–4 hours | **Depends on:** Sessions 1, 3 | **PRD Reference:** P1.2, P1.3

### Goal
Events are automatically checked against policy rules. Results are stored in a tamper-evident vault.

### Tasks

1. **Build the Verification Engine worker** (`src/workers/verificationWorker.ts`)
   - Poll `job_queue` every 2 seconds for `job_type = 'verification'` jobs
   - For each job:
     - Fetch the `scan_event` by `event_id`
     - Load all active `json_policy_maps` from DB (cache in memory, refresh every 60s)
     - Run each check against the event:
       - `type_match`: `decision_type in check_config.values` → result
       - `keyword`: scan `output_summary` for any keyword in `check_config.keywords`
       - `threshold`: parse `metadata[field]` and compare with operator/value; if field absent → apply `missing_action`
     - Aggregate: any `FAIL` → result `FAIL`; any `WARN` (no FAIL) → `WARN`; all pass → `PASS`
     - Insert `verification_results` row
     - If `FAIL` or `WARN`, insert `compliance_alerts` row
     - Update `scan_events.processing_status = 'complete'`
     - Enqueue `vault_hash` job
     - Update `job_queue` row to `status: 'done'`

2. **Build the Vault Hash worker** (`src/workers/vaultHashWorker.ts`)
   - Receives `{result_id}` payload
   - Fetches the `verification_result` JSON, serialises deterministically
   - Computes `payload_hash = SHA256(JSON.stringify(result))`
   - Fetches the last `vault_records` row for this tenant (highest `sequence_num`)
   - Computes `chain_hash = SHA256(payload_hash + previous_chain_hash)`
   - Inserts new `vault_records` row
   - Updates `trust_badge_cache` for this tenant

3. **Build the Evidence Vault export endpoint** (`src/routes/vault.ts`)
   ```
   GET /api/v1/vault/export?from=YYYY-MM-DD&to=YYYY-MM-DD
   ```
   - Returns a PDF (using pdfkit) listing all vault records in date range
   - PDF includes: event ID, timestamp, model ID, decision type, result, payload hash, chain hash
   - Header: tenant name, export date, vault record count
   - Footer: chain root hash (first record's chain_hash), export generated by CaaS Hub

4. **Wire up alert creation → dashboard notification**
   - On `compliance_alerts` insert, update `trust_badge_cache`

### Done When
- After Session 3's test `curl`, within 5 seconds: a `verification_results` row exists with `result: WARN` (because `demographic_parity_ratio: 0.75` fails the 0.8 threshold check)
- A `vault_records` row exists with a valid `chain_hash`
- A `compliance_alerts` row exists
- `GET /api/v1/vault/export` returns a PDF with the event listed

---

## Session 5 — Live Executive Dashboard
**Duration:** 3–4 hours | **Depends on:** Sessions 2, 4 | **PRD Reference:** P1.4

### Goal
The Executive Dashboard shows real compliance data. The Shadow Scan cycle is complete.

### Tasks

1. **Build the dashboard summary API** (`src/routes/dashboard.ts`)
   ```
   GET /api/v1/dashboard/summary
   ```
   Returns:
   ```json
   {
     "compliance_score": 87.5,
     "total_runs": 48,
     "pass_count": 42,
     "warn_count": 4,
     "fail_count": 2,
     "unread_alerts": 2,
     "active_models": [
       {"model_id": "credit-model-v2", "last_seen": "...", "last_result": "WARN"}
     ],
     "drift_chart": [
       {"date": "2026-05-20", "pass": 8, "warn": 1, "fail": 0},
       ...
     ],
     "vault_stats": {"total_records": 48, "last_hash": "sha256...", "last_updated": "..."}
   }
   ```

2. **Build dashboard screens in React**
   - **Compliance Health Score** — large number widget, coloured by score (green ≥ 90%, amber 70–89%, red < 70%)
   - **7-Day Drift Chart** — Recharts `BarChart` with stacked PASS/WARN/FAIL bars
   - **Alert Feed** — list of unread `compliance_alerts` with reason codes; "Acknowledge" button
   - **Active Models** — table with model ID, last seen, result badge
   - **Vault Status** — record count, last hash (truncated), "Export PDF" button

3. **Alert acknowledge endpoint**
   ```
   POST /api/v1/dashboard/alerts/:id/acknowledge
   ```
   - Sets `acknowledged = 1`, `acknowledged_by = req.userId`, `acknowledged_at = now()`
   - Writes to `audit_log`

4. **Configure `app.aitwcloud.com` subdomain**
   - Add Cloudflare CNAME: `app.aitwcloud.com` → `caas-lite.fly.dev`
   - Update `CORS_ORIGINS` Fly secret to include `https://app.aitwcloud.com`
   - Verify TLS and login flow from `app.aitwcloud.com`

### Done When
- Dashboard at `app.aitwcloud.com` shows real compliance score and alert count for `odeijsom`
- Drift chart shows 7 days of data (even if mostly zeros for new tenants)
- Alert feed shows the WARN from Session 3's test event
- Acknowledging an alert decrements the unread count immediately
- PDF export button downloads a valid PDF

---

## Session 6 — Trust Badge + Payment Integration
**Duration:** 4–5 hours | **Depends on:** Session 5 | **PRD Reference:** P2.1, P2.2

### Goal
The platform can charge for its service and give clients a public proof of compliance.

### Tasks

1. **Trust Badge routes** (`src/routes/badge.ts`)
   - `GET /badge/:tenant_id` — returns SVG badge (reads from `trust_badge_cache`)
   - `GET /badge/:tenant_id/report` — returns HTML scorecard page (public, unauthenticated)
   - Both routes bypass auth middleware; they are rate-limited separately (30 req/min per IP)
   - SVG badge: shows score %, "Last verified" date, "CaaS Verified" mark, colour-coded ring

2. **Dashboard: Embed snippet screen**
   - New section in the React dashboard: "Trust Badge"
   - Shows live preview of the badge (iframe to `/badge/:tenant_id`)
   - Copy buttons for: `<img>` tag, `<script>` embed, and direct badge URL

3. **Paystack integration** (`src/routes/billing.ts`, `src/services/paystack.ts`)
   - `POST /api/v1/billing/subscribe` — initiates a Paystack subscription checkout; returns a `authorization_url` for redirect
   - `POST /api/v1/billing/webhook/paystack` — handles `subscription.create`, `invoice.payment_success`, `subscription.disable` events
   - On `invoice.payment_success`: update `accounts.status = 'active'`, `accounts.tier`, reset run count, log to `audit_log`
   - On `subscription.disable`: update `accounts.status = 'suspended'`
   - `GET /api/v1/billing/status` — returns current tier, status, next renewal date for the authenticated tenant

4. **Stripe integration** (parallel with Paystack)
   - `POST /api/v1/billing/webhook/stripe` — handles `payment_intent.succeeded`, `customer.subscription.deleted`
   - Same outcome mapping as Paystack handlers

5. **Kill Switch enforcement**
   - In `src/routes/ingest.ts`: before accepting any event, check `accounts.status`
   - If `status = 'suspended'` → 402 `{"error":"Subscription suspended. Please renew to continue."}`

### Done When
- `GET /badge/tenant-aitw-001` returns a valid SVG with the current compliance score
- `/badge/tenant-aitw-001/report` returns a readable HTML scorecard page
- Paystack checkout flow initiates from the dashboard (test mode)
- A simulated Paystack webhook (`invoice.payment_success`) updates the tenant tier in the DB
- A suspended account's event submission returns 402

---

## Session 7 — Partner Portal
**Duration:** 4–5 hours | **Depends on:** Sessions 5, 6 | **PRD Reference:** P2.3

### Goal
External partners can register, generate leads, and receive automatic commission payouts.

### Tasks

1. **Partner registration and management** (`src/routes/partner.ts`)
   - `POST /api/v1/partner/register` — public; inserts `partners` row with `status: 'pending'`; sends welcome email via Resend
   - `POST /api/v1/partner/login` — returns JWT for partner (separate from client JWT; `role: 'partner'`)
   - `GET /api/v1/partner/dashboard` — returns pipeline, commissions, referral code
   - `GET /api/v1/partner/commissions` — paginated commission ledger
   - Executive-only: `POST /api/v1/admin/partners/:id/approve` — sets status to `approved`, generates portal password, sends approval email

2. **"Lure Tool" — Pre-Audit Scan** (`src/routes/lure.ts`)
   - `POST /api/v1/partner/lure-scan` — accepts `{prospect_email, webhook_sample_payload[]}` (up to 10 sample events)
   - Runs the Verification Engine synchronously against the sample events (not stored in a client tenant's vault)
   - Returns a "Compliance Gap Report": list of failing checks, severity, regulation references
   - Generates a PDF of the report (pdfkit) and returns it as a download
   - Emails the report to `prospect_email` with the partner's referral link

3. **Referral link + tenant tagging**
   - Partner's `referral_code` is embedded in signup links: `https://app.aitwcloud.com/register?ref=CAAS-100-001`
   - On tenant creation, if `?ref=` is present and valid, set `accounts.referral_agent_id = partner.id`

4. **Commission Payout Engine** (`src/workers/payoutWorker.ts`)
   - Triggered when a `commissions` row transitions to `settled` (i.e., client payment has cleared)
   - Calls Paystack Transfer API: `POST https://api.paystack.co/transfer` with `amount`, `recipient_code`, `reason`
   - On success: update `commissions.status = 'paid'`, store `payout_reference`
   - On failure: retry up to 3 times via `job_queue`, then set `status: 'failed'` and alert operations

5. **Partner Portal React screens**
   - `/partner` route group in the React SPA (or a lightweight separate HTML page if time is tight)
   - Screens: Pipeline, Commission Ledger, Lure Tool, Profile/Payout Settings, Agent Badge display

6. **Partner CAAS-REF-ID generation**
   - Sequential: `CAAS-100-001`, `CAAS-100-002`, etc.
   - On approval: `SELECT COUNT(*) + 1 FROM partners WHERE status = 'approved'` → format as `CAAS-100-${n.toString().padStart(3, '0')}`

### Done When
- A partner can register at `/partner/register`, receive an approval email, log in, and view their dashboard
- The Lure Tool generates a Compliance Gap Report PDF from 3 sample events
- When a referred client's invoice is marked paid, the partner's `pending_balance` is credited
- A simulated Paystack payout webhook confirms the transfer reference is stored

---

## Session 8 — Hardening, Observability & Launch Prep
**Duration:** 3–4 hours | **Depends on:** All previous sessions

### Goal
The platform is production-hardened, monitored, and ready for the first pilot SMB.

### Tasks

1. **Resolve slice 7 hardening tracker** (21 open items → prioritise top 10)
   - API-key auth path verified (done in Session 1 — close this item)
   - Rate limiter fix (done in Session 0 — close)
   - Root redirect (done in Session 0 — close)
   - Self-registration posture: confirm `ENABLE_PUBLIC_REGISTRATION=false` on production
   - Static asset bypass for rate limiter (add `express.static` before rate limiter)
   - `aitw-ops` `kyc_tier` corrected to `enhanced`
   - Stale seed data audit: run `SELECT * FROM user_profiles` and clean up

2. **Set up observability**
   - Configure Prometheus metrics endpoint (already has `prom-client`) — expose at `/metrics` with a bearer token
   - Ship logs to Better Stack (or Logtail) via Fly's log shipper
   - Set up UptimeRobot to ping `/healthz` every 60s; alert to ops email on failure

3. **Write integration team handoff doc** (`docs/INTEGRATION.md`)
   - Dashboard URL, auth headers required, endpoint list, sample payloads
   - API key auth path example
   - Rate limiting guide

4. **30-day pilot onboarding runbook** (`docs/PILOT-RUNBOOK.md`)
   - Week 1: Connect webhook → confirm first event received
   - Week 2: Review Shadow Scan dashboard with client
   - Week 3: Export Evidence Vault, verify hash chain
   - Week 4: Present scorecard, issue Trust Badge embed code

5. **Perform restore drill**
   - Stop staging app, wipe volume, run Litestream restore, verify schema and data are intact
   - Document results in `DEPLOYMENT.md`

### Done When
- All P0 and P1 hardening items closed
- UptimeRobot monitor is live and paging on failure
- Integration team handoff doc is complete
- Pilot runbook is complete
- Staging restore drill is documented

---

## Milestone Summary

| Milestone | Session | What It Proves |
|---|---|---|
| Clean production baseline | 0 | No known bugs in the live system |
| Schema + API key auth | 1 | Data model is complete; SDKs can authenticate |
| User management | 2 | Platform is self-serviceable without DB access |
| Event ingestion | 3 | Client systems can send data to CaaS |
| Verification + Vault | 4 | Core compliance value delivered |
| Live dashboard | 5 | Executives can see and act on compliance data |
| Trust badge + billing | 6 | Platform generates revenue |
| Partner portal | 7 | Sales network is operational |
| Hardening + launch | 8 | First pilot SMB can be onboarded safely |
