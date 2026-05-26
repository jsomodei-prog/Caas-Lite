# CaaS Platform — AI Prompt Playbook
### Copy-and-Paste Prompts for Each Sprint Session | Version 1.0 | 26 May 2026

---

## How to Use This Playbook

Each prompt below is designed to be pasted directly into a new Claude conversation (or used with Claude Code via `claude` in the terminal). Before pasting any prompt:

1. Open your project repository in your editor
2. Have the relevant source files available to share (the prompt will tell you which ones to attach)
3. Paste the prompt, attach the files listed under "Attach these files", then send

The prompts assume Claude has already read this execution guide. For best results, paste the relevant PRD section and Tech Stack into the conversation context alongside the prompt.

---

## Session 0 — Environment Hardening

### Prompt S0-A: Fix the Three Production Bugs

```
I have a deployed Node.js/TypeScript + Express application (caas-lite on Fly.io). There are three 
known bugs to fix in one PR. Here is the context and the exact fixes needed:

**Bug 1 — Root path returns 429 instead of redirecting**
File: src/app.ts (or wherever app.get routes are registered)
Fix: Add this route BEFORE the rate limiter middleware:
  app.get('/', (_req, res) => res.redirect(301, '/dashboard'))
Also add '/' to the bypassPaths array in the rate limiter configuration.

**Bug 2 — Rate limiter returns fake 429 when X-CaaS-Tier header is missing**
File: src/middleware/rateLimiter.ts
Locate the function `evaluateRateLimit` (or equivalent). Find where the code currently returns 
HTTP 429 with {"error":"Too Many Requests","tier":"PAY_AS_YOU_GO","limit":0} when resolveTier() 
returns null. 
Change this path to return HTTP 400 with: {"error":"Tier header required or invalid","hint":"Send 
X-CaaS-Tier: LITE|GROWTH|ENTERPRISE on authenticated requests"}
Remove the misleading tier field from the error response.

**Bug 3 — Dashboard ribbon shows hardcoded 'client partner' regardless of logged-in role**
File: public/index.html (or the dashboard HTML file served at /dashboard)
The ribbon text is hardcoded. Find it and replace it so it renders state.user.plane_role (from the 
decoded JWT stored after login). The login response includes the user's plane_role — store it in 
the client-side state object and reference it in the ribbon render function.

Please:
1. Show me the exact line(s) you are changing in each file before making the change
2. Make all three changes
3. Write a brief comment above each change explaining why it was made
4. Do not change any other code
```

**Attach these files:** `src/middleware/rateLimiter.ts`, `src/app.ts` (or main app file), `public/index.html`

---

### Prompt S0-B: GitHub Actions CI/CD Setup

```
Set up GitHub Actions CI/CD for a Node.js/TypeScript project deployed on Fly.io.

Requirements:
- On push to `master` branch: run npm ci, npm run build, then fly deploy -a caas-lite
- On push to a `staging` branch: run npm ci, npm run build, then fly deploy -a caas-lite-staging
- The workflow should fail fast if the build step fails (don't attempt deploy)
- Use flyctl/setup-flyio action for Fly deployment
- The FLY_API_TOKEN is stored in GitHub repo secrets as FLY_API_TOKEN

Create the file at: .github/workflows/deploy.yml

The project:
- Uses Node.js 20
- Has a build script: npm run build (TypeScript compilation)
- Has a test script: npm test (run tests before deploy if tests exist)
- package.json is at the repo root

Output the complete YAML file content.
```

**Attach these files:** `package.json`, `fly.toml`

---

## Session 1 — Database Migrations & API Key Auth

### Prompt S1-A: Migration Runner

```
I need a TypeScript database migration runner for a SQLite project using better-sqlite3. 

Requirements:
- Migration files are SQL files stored in src/db/migrations/ named like 001_description.sql
- Track applied migrations in a schema_migrations table (columns: id INTEGER PK, name TEXT UNIQUE, 
  applied_at TEXT)
- At startup, read all migration files in order, skip ones already in schema_migrations, run new ones
- Each migration runs in a transaction — if it fails, roll back and throw an error with the 
  migration filename in the message
- Export a single function: runMigrations(db: Database): void
- This function is called once at app startup before app.listen()
- Log each migration as it applies: console.log(`[migration] Applied: 001_extend_accounts.sql`)
- If 0 new migrations: console.log('[migration] Schema up to date')

The db connection is a better-sqlite3 Database instance. Show me:
1. src/db/migrate.ts — the migration runner
2. Where in the existing startup code to call runMigrations(db)
3. The content of src/db/migrations/001_extend_accounts.sql (ALTER TABLE statements only — 
   use IF NOT EXISTS pattern where SQLite supports it, or wrap in a transaction with error handling)
```

**Attach these files:** `src/db/index.ts` (or wherever the DB connection is initialised), `src/index.ts` (startup file)

---

### Prompt S1-B: API Key Authentication Middleware

```
I need to add API key authentication to an existing Express/TypeScript API that currently only 
supports JWT authentication. The project uses better-sqlite3 and argon2.

Context:
- The database has an `accounts` table with columns: tenant_id, api_key_hash, api_key_prefix, 
  tier, status
- API keys are generated as: 'aitw_' + crypto.randomBytes(24).toString('base64url')
- The first 12 characters of the raw key are stored in api_key_prefix for fast lookup
- The full key is hashed with argon2 and stored in api_key_hash
- Client sends: Authorization: Bearer aitw_<key> in the header

Build:
1. src/middleware/apiKeyAuth.ts — middleware that:
   - Checks for Authorization header starting with 'Bearer aitw_'
   - Extracts the key, takes the first 12 chars as the prefix
   - Queries: SELECT * FROM accounts WHERE api_key_prefix = ? AND status != 'suspended'
   - Calls argon2.verify(row.api_key_hash, providedKey) 
   - On match: sets req.tenantId = row.tenant_id, req.authMethod = 'api_key', req.tier = row.tier
   - On failure: returns 401 {"error":"Invalid API key"}
   - If no 'Bearer aitw_' header present: calls next() without setting req.tenantId (fall through 
     to JWT auth)

2. Show me how to compose this middleware with the existing JWT auth middleware so that a request 
   can be authenticated by EITHER a valid JWT OR a valid API key (not both required)

3. Write a cURL test command that demonstrates API key auth working against a protected endpoint

The existing JWT middleware sets req.userId and req.tenantId. The API key middleware should set 
req.tenantId but not req.userId (since there's no user — it's tenant-level auth).
```

**Attach these files:** `src/middleware/` (full directory), `src/routes/auth.ts`

---

## Session 2 — User & Tenant Management

### Prompt S2-A: User Management API

```
Build a User Management API for a multi-tenant Express/TypeScript application using better-sqlite3.

Database tables (relevant columns):
- users: id (TEXT PK, UUID format), username, email, tenant_id, plane_role, password_hash, 
  is_active (INTEGER 0/1), created_at, created_by, last_login_at, deactivated_at, deactivated_by
- user_profiles: user_id (PK), display_name, kyc_tier
- accounts: tenant_id (PK), tier, status, api_key_hash, api_key_prefix, display_name, contact_email
- audit_log: id (AUTOINCREMENT), tenant_id, user_id, action, target_id, details (JSON), ip_address, 
  created_at

Build src/routes/admin.ts with these endpoints (all require plane_role IN ('client_super_admin', 
'client_executive')):

GET /api/v1/admin/users
- Returns all users in req.tenantId (scoped by tenant_id — no exceptions)
- Include: id, username, email, plane_role, is_active, last_login_at, display_name (from user_profiles)
- Never return password_hash

POST /api/v1/admin/users
- Body: {username, email, plane_role, password, display_name}
- Validate: username unique within tenant, password min 12 chars, plane_role in allowed list
- Hash password with argon2
- Generate user id: 'usr_' + crypto.randomBytes(12).toString('hex')
- Insert into users AND user_profiles in a single transaction
- Write to audit_log: {action: 'user.create', target_id: newUser.id, details: {username, plane_role}}
- Return 201 with the new user (without password_hash)

PATCH /api/v1/admin/users/:id
- Body (all optional): {plane_role, is_active, display_name}
- Verify the target user belongs to req.tenantId before any update
- If is_active transitions to 0: set deactivated_at = now(), deactivated_by = req.userId
- If is_active transitions to 1: clear deactivated_at, deactivated_by
- Write to audit_log for each field changed
- Executives cannot change their own plane_role (return 403)

GET /api/v1/admin/tenant
- Returns accounts row for req.tenantId
- Include: tenant_id, display_name, tier, status, contact_email, api_key_prefix + '...'
- Do NOT return api_key_hash

POST /api/v1/admin/tenant/api-key/rotate
- Generate new API key: 'aitw_' + crypto.randomBytes(24).toString('base64url')
- Hash with argon2, store hash and prefix (first 12 chars)
- Update accounts row
- Write to audit_log: {action: 'api_key.rotate'}
- Return 200 with the plaintext key ONCE — it will not be retrievable again
- Add a warning in the response body: "Save this key now. It will not be shown again."
```

**Attach these files:** `src/routes/` (directory listing), `src/middleware/auth.ts`, `src/db/index.ts`

---

### Prompt S2-B: React Frontend Setup + User Management Screen

```
Set up a React 18 + Vite + Tailwind CSS single-page application for a compliance dashboard.

Project structure to create (inside a frontend/ directory at the repo root):
- frontend/package.json
- frontend/vite.config.ts
- frontend/tailwind.config.js
- frontend/src/main.tsx
- frontend/src/App.tsx
- frontend/src/lib/api.ts (fetch wrapper that adds Authorization header from localStorage)
- frontend/src/pages/Users.tsx
- frontend/src/pages/AccountSettings.tsx
- frontend/src/components/Layout.tsx (sidebar + main area)

The API base URL comes from an environment variable: VITE_API_URL (default: window.location.origin)

Requirements for Users.tsx:
- Fetch GET /api/v1/admin/users on mount and display in a table
- Columns: Username, Email, Role (badge coloured by role), Status (Active/Inactive toggle), 
  Last Login, Actions
- "New User" button opens a modal with fields: Username, Email, Role (select), Display Name, 
  Password (with strength indicator)
- On submit, POST /api/v1/admin/users; on success, refresh the table
- Deactivate/Reactivate: clicking the Status toggle sends PATCH /api/v1/admin/users/:id with 
  {is_active: 0 or 1}; optimistic update on the row

Requirements for AccountSettings.tsx:
- Show tenant name, tier (badge: LITE=grey, GROWTH=blue, ENTERPRISE=gold), status
- Show API key: "aitw_abc123......" with a "Copy prefix" button
- "Rotate API Key" button → confirmation modal → POST /api/v1/admin/tenant/api-key/rotate → 
  show the returned plaintext key in a modal with a "Copy" button and warning text

Use Tailwind utility classes for all styling. No component library. Keep it clean and professional 
(dark sidebar, white main area, subtle borders). Output all files.
```

---

## Session 3 — Event Ingestion

### Prompt S3-A: Ingestion Endpoint + Job Queue

```
Build an event ingestion endpoint and an in-process job queue for a Node.js/TypeScript + Express 
app using better-sqlite3.

Part 1: Job Queue (src/db/jobQueue.ts)
The job queue uses a SQLite table called job_queue (already created by migration):
  id INTEGER PK AUTOINCREMENT, job_type TEXT, payload TEXT (JSON), status TEXT 
  (pending/processing/done/failed), attempts INTEGER, max_attempts INTEGER, error_message TEXT, 
  created_at TEXT, updated_at TEXT, run_after TEXT

Build:
- enqueueJob(db, jobType: string, payload: object): number — inserts a pending job, returns id
- claimJob(db): {id, job_type, payload_parsed} | null — atomically claims the next pending job 
  (UPDATE ... WHERE id = (SELECT id FROM job_queue WHERE status='pending' AND 
  (run_after IS NULL OR run_after <= datetime('now')) ORDER BY id LIMIT 1)), returns null if none
- completeJob(db, id: number): void — sets status='done'
- failJob(db, id: number, error: string, retryDelaySecs?: number): void — increments attempts; 
  if attempts >= max_attempts sets status='failed'; else sets status='pending' and run_after = 
  datetime('now', '+N seconds')
- startWorkerLoop(db, handlers: Record<string, (payload) => Promise<void>>, intervalMs = 2000): 
  NodeJS.Timer — polls every intervalMs, claims a job, calls the matching handler, completes or fails it

Part 2: Ingestion Endpoint (src/routes/ingest.ts)
POST /api/v1/ingest/events
- Auth: accepts JWT or API key (via req.tenantId set by middleware)
- Validate body: model_id (required, string), decision_type (required, string), timestamp (required, 
  valid ISO 8601), output_summary (optional, string, max 1000 chars), input_hash (optional, string), 
  metadata (optional, valid JSON object)
- Check run limit: SELECT run_count_this_month, run_limit_monthly FROM accounts WHERE tenant_id = ?
  If run_count_this_month >= run_limit_monthly → 402 {"error":"Monthly limit reached","limit":N}
- Insert into scan_events (fetch referral_agent_id from accounts to denormalise onto the event)
- INCREMENT run_count_this_month in accounts
- enqueueJob(db, 'verification', {event_id: newEvent.id})
- Return 202 {"event_id": "evt_...", "status":"accepted", "queued_at": "ISO timestamp"}

Also build: GET /api/v1/ingest/events/:id — returns a single scan_event with its verification_result 
if processing is complete, or {"status":"pending"} if still queued.
```

---

## Session 4 — Verification Engine + Evidence Vault

### Prompt S4-A: Verification Engine Worker

```
Build a Verification Engine worker for a compliance platform in Node.js/TypeScript.

The worker processes jobs of type 'verification' from a job queue. Here is the full spec:

Input: {event_id: string} from the job payload

Database tables involved:
- scan_events: id, tenant_id, model_id, decision_type, output_summary, metadata (JSON string), 
  processing_status
- json_policy_maps: check_name, check_type, check_config (JSON), severity, active
- verification_results: id, event_id, tenant_id, result, checks_run (JSON), checks_failed (JSON), 
  reason_codes (JSON array of {code, message}), latency_ms, verified_at
- compliance_alerts: id, tenant_id, result_id, event_id, severity, reason_codes, created_at
- job_queue: (for enqueuing downstream jobs)

Build src/workers/verificationWorker.ts:

function runChecks(event: ScanEvent, policies: PolicyMap[]): CheckResult

For each active policy, run the check based on check_type:
- 'type_match': parse check_config.values (array); check if event.decision_type is in the array
- 'keyword': parse check_config.keywords (array); check if any keyword appears (case-insensitive) 
  in event.output_summary. If output_summary is null, result = PASS
- 'threshold': parse check_config.field (dot-notation path into event.metadata JSON), 
  check_config.operator (gte, lte, eq, neq), check_config.value (number). 
  If field is absent in metadata: apply check_config.missing_action ('WARN' or 'PASS')

Aggregate: if any check produces 'FAIL' → overall result is 'FAIL'. 
If any check produces 'WARN' (and no FAIL) → 'WARN'. All pass → 'PASS'.

async function handleVerificationJob(db, payload): Promise<void>
1. Fetch the scan_event by event_id; verify it belongs to the right tenant
2. Load all active json_policy_maps (cache in module-level Map, refresh every 60s by checking 
   a lastLoaded timestamp)
3. Record start time
4. Run runChecks(event, policies)
5. Insert verification_result
6. If result is FAIL or WARN: insert compliance_alert
7. Update scan_events.processing_status = 'complete'
8. Enqueue a 'vault_hash' job with {result_id: newResult.id, tenant_id}
9. Update trust_badge_cache for this tenant (upsert: increment total, pass/warn/fail counts, 
   recalculate score as ROUND(100.0 * pass_count / total_runs, 1), set last_verified_at)

Export the handler so startWorkerLoop can call it.
```

---

### Prompt S4-B: Vault Hash Worker + PDF Export

```
Build two components for the Evidence Vault of a compliance platform in Node.js/TypeScript.

Part 1: Vault Hash Worker (src/workers/vaultHashWorker.ts)

Input job payload: {result_id: string, tenant_id: string}

Tables:
- verification_results: all columns
- vault_records: id, tenant_id, sequence_num, result_id, payload_hash, chain_hash, previous_id, created_at

async function handleVaultHashJob(db, payload): Promise<void>
1. Fetch the verification_result row by result_id
2. Serialise it to a canonical JSON string (keys sorted alphabetically, no pretty-print)
3. Compute payload_hash = SHA-256 of the canonical JSON (use Node.js crypto.createHash('sha256'))
4. Fetch the last vault_records row for this tenant: 
   SELECT * FROM vault_records WHERE tenant_id = ? ORDER BY sequence_num DESC LIMIT 1
5. Compute chain_hash = SHA-256 of (payload_hash + previous_chain_hash)
   If no previous row exists: chain_hash = SHA-256 of (payload_hash + '')
6. Get next sequence_num = (previous row's sequence_num + 1) or 1 if first
7. Insert the vault_records row
   IMPORTANT: this table has triggers preventing UPDATE and DELETE — the insert must be correct 
   the first time
8. Log: console.log(`[vault] Record vlt_xxx seq=${sequence_num} hash=${chain_hash.slice(0,16)}...`)

Part 2: Evidence Vault PDF Export (src/routes/vault.ts)

GET /api/v1/vault/export
- Auth: JWT required, plane_role must be client_executive or client_super_admin or client_auditor
- Query params: from (YYYY-MM-DD), to (YYYY-MM-DD). Defaults: last 30 days
- Fetch all vault_records for this tenant in date range, joined with verification_results and 
  scan_events
- Generate a PDF using pdfkit (install: npm install pdfkit @types/pdfkit)
- PDF structure:
  HEADER: "CaaS Compliance Evidence Vault" | Tenant: [display_name] | Export Date: [now]
  SUBTITLE: "Records: N | Period: from to to | Chain Root Hash: [first chain_hash truncated to 32 chars]"
  TABLE: one row per vault record — columns: Seq#, Timestamp, Model ID, Decision Type, Result 
    (PASS/WARN/FAIL), Hash (first 16 chars + "...")
  FOOTER on each page: "Generated by CaaS Hub | Cryptographically signed audit trail"
  
- Set Content-Type: application/pdf
- Set Content-Disposition: attachment; filename="caas-vault-[tenantId]-[date].pdf"
- Pipe the pdfkit document stream directly to res

Also add: GET /api/v1/vault/integrity-check
- Verifies the hash chain for the authenticated tenant
- Returns {"valid": true, "record_count": N} or {"valid": false, "broken_at_sequence": N, 
  "message": "Chain hash mismatch at record vlt_xxx"}
```

---

## Session 5 — Live Dashboard

### Prompt S5-A: Dashboard Summary API

```
Build a dashboard summary API endpoint for a multi-tenant compliance platform.

GET /api/v1/dashboard/summary

Auth: JWT required (any plane_role)
Scope: ALL queries must be WHERE tenant_id = req.tenantId — absolutely no cross-tenant data

Return this JSON shape:
{
  "compliance_score": 87.5,        // from trust_badge_cache.compliance_score
  "total_runs": 48,                // from trust_badge_cache.total_runs
  "pass_count": 42,
  "warn_count": 4,
  "fail_count": 2,
  "unread_alerts": 3,             // COUNT from compliance_alerts WHERE acknowledged=0
  "active_models": [               // distinct model_ids seen in last 30 days
    {
      "model_id": "credit-model-v2",
      "last_seen": "2026-05-26T09:00:00Z",
      "last_result": "WARN",
      "run_count": 24
    }
  ],
  "drift_chart": [                 // last 7 days, one entry per day
    {
      "date": "2026-05-20",
      "pass": 8,
      "warn": 1,
      "fail": 0
    }
  ],
  "vault_stats": {
    "total_records": 48,
    "last_hash": "a3f2b1...",     // last chain_hash, truncated to 32 chars
    "last_updated": "2026-05-26T09:00:00Z"
  },
  "recent_alerts": [               // last 5 unacknowledged alerts
    {
      "id": "alt_...",
      "severity": "WARN",
      "model_id": "credit-model-v2",
      "decision_type": "credit_scoring",
      "reason_codes": [{"code":"fairness_ratio_check","message":"Ratio below 0.8"}],
      "created_at": "2026-05-26T09:00:00Z"
    }
  ]
}

Build this using better-sqlite3 prepared statements. Use a single DB call per logical query group 
(no N+1 queries). The drift_chart should be computed with a date series — generate the last 7 dates 
in JavaScript, then match against a GROUP BY date(verified_at) query result.

Also build: POST /api/v1/dashboard/alerts/:id/acknowledge
- Verify alert belongs to req.tenantId
- Set acknowledged=1, acknowledged_by=req.userId, acknowledged_at=now()
- Write to audit_log
- Return 200 {"acknowledged": true}
```

---

### Prompt S5-B: React Dashboard Screens

```
Build the main Executive Dashboard screens in React 18 + Tailwind CSS + Recharts.

The API base URL is from VITE_API_URL env var. Auth token is in localStorage as 'caas_token'.
The api() helper adds Authorization: Bearer <token> and X-CaaS-Tier: <tier> headers.

Build these components:

src/pages/Dashboard.tsx — main dashboard, fetches /api/v1/dashboard/summary on mount

Layout: 3-column grid on desktop (1 column mobile)
- Top row: 4 stat cards side by side — Compliance Score (big number, coloured ring), 
  Total Runs, Unread Alerts (badge), Active Models count
- Middle: DriftChart component (takes drift_chart array as prop)
- Bottom left: AlertFeed component (takes recent_alerts array, onAcknowledge callback)
- Bottom right: VaultStats component (takes vault_stats, link to Export PDF)

src/components/DriftChart.tsx
- Recharts BarChart, stacked bars
- X axis: date (formatted as MMM DD)
- Y axis: count
- Series: pass (green #22c55e), warn (amber #f59e0b), fail (red #ef4444)
- Height: 250px
- Tooltip showing PASS/WARN/FAIL breakdown on hover

src/components/AlertFeed.tsx  
- List of alert cards, each showing: severity badge (WARN=amber, FAIL=red), model_id, 
  decision_type, reason (first reason_code.message), timestamp (relative: "2 hours ago")
- "Acknowledge" button on each card → calls POST .../acknowledge → removes card from list 
  (optimistic update)
- Empty state: "✓ No active alerts" (green)

src/components/ComplianceScore.tsx
- Large circular score display (use SVG, not a library)
- 0-100 score rendered as a ring (stroke-dasharray trick)
- Colour: green if ≥ 90, amber if 70-89, red if < 70
- Label below: "EU AI Act Readiness"

All components should handle loading state (skeleton placeholder) and error state (red banner).
```

---

## Session 6 — Trust Badge + Payments

### Prompt S6-A: Trust Badge SVG + Public Scorecard

```
Build a dynamic Trust Badge system for a compliance platform in Node.js/TypeScript + Express.

Part 1: Badge Route (src/routes/badge.ts)

GET /badge/:tenant_id
- NO authentication required — this is a public route
- Fetch from trust_badge_cache where tenant_id = :tenant_id
- If not found: return a "Pending" badge (grey, score: "--")
- Return Content-Type: image/svg+xml with Cache-Control: public, max-age=300
- Rate limit: 30 req/min per IP (separate from API rate limiter)

Return an SVG badge with these elements:
- Outer rounded rectangle (width: 200px, height: 60px, rx: 8)
- Left panel (dark blue #1e3a5f, 40% width): "CaaS" in white, small text
- Right panel (white): "{score}%" in large bold text, "VERIFIED" below in small caps
- Bottom strip: thin coloured bar — green if score>=90, amber if 70-89, red if <70
- "Last checked: {date}" in 9px grey text at the bottom
- Inline SVG — no external resources, no JavaScript in the SVG

GET /badge/:tenant_id/report
- NO authentication required
- Returns an HTML page (not React — plain server-rendered HTML template string)
- Shows: Tenant display_name, Compliance Score (large), Total Runs, Pass/Warn/Fail breakdown, 
  list of last 5 verification results (model_id, result, date), last vault hash (truncated)
- Simple, clean HTML with inline CSS — professional, minimal
- CaaS branding in the header

Part 2: Badge Embed in Dashboard
Add to the React dashboard (src/pages/TrustBadge.tsx):
- Live preview: <img src={`${apiUrl}/badge/${tenantId}`} /> in a card
- Three copy snippets with syntax highlighting (just a <pre> block):
  1. Image tag: <img src="https://api.aitwcloud.com/badge/TENANT_ID" alt="CaaS Verified">
  2. Script embed: a one-liner that injects the badge as a linked image
  3. Direct URL
- Each snippet has a "Copy" button (uses navigator.clipboard.writeText)
- Auto-refreshes the preview every 60 seconds
```

---

### Prompt S6-B: Paystack Payment Integration

```
Build Paystack payment integration for a Node.js/TypeScript + Express multi-tenant SaaS platform.

Install: npm install @paystack/paystack-sdk (or use native fetch — Paystack API is REST)
Environment variables: PAYSTACK_SECRET_KEY, PAYSTACK_WEBHOOK_SECRET

Build src/services/paystack.ts:
- initializeSubscription(tenantId, email, plan, amount, currency): Promise<{authorization_url, reference}>
  Calls POST https://api.paystack.co/transaction/initialize with amount (in kobo/pesewas/cents), 
  email, reference (generate: `caas_${tenantId}_${Date.now()}`), metadata: {tenant_id, tier: plan}
  Returns the authorization_url for frontend redirect
  
- verifyTransaction(reference): Promise<PaystackTransaction>
  Calls GET https://api.paystack.co/transaction/verify/:reference

- initiateTransfer(recipientCode, amount, currency, reason): Promise<{transfer_code, status}>
  Calls POST https://api.paystack.co/transfer

Build src/routes/billing.ts:

POST /api/v1/billing/subscribe
- Auth: JWT required (any role but must be client_executive or super_admin)
- Body: {plan: 'LITE'|'GROWTH'|'ENTERPRISE', payment_method: 'paystack'|'stripe'}
- Map plan to price: LITE=$49/mo, GROWTH=$199/mo, ENTERPRISE=$499/mo (store in constants)
- Call initializeSubscription with the tenant's contact_email
- Store the reference in accounts.billing_customer_id for tracking
- Return 200 {authorization_url}

POST /api/v1/billing/webhook/paystack
- NO auth — Paystack signs with HMAC-SHA512 in x-paystack-signature header
- Verify signature: HMAC-SHA512(rawBody, PAYSTACK_WEBHOOK_SECRET) === header value
- If signature invalid: return 400
- Parse event; handle these event types:
  'charge.success': 
    - Extract tenant_id from metadata
    - Extract tier from metadata  
    - UPDATE accounts SET tier=?, status='active', updated_at=? WHERE tenant_id=?
    - Reset run_count_this_month = 0
    - Write to audit_log: {action: 'billing.payment_success', details: {amount, tier}}
  'subscription.disable':
    - UPDATE accounts SET status='suspended' WHERE tenant_id=?
    - Write to audit_log: {action: 'billing.subscription_suspended'}
- Always return 200 (Paystack retries on non-200)

GET /api/v1/billing/status
- Auth: JWT required
- Return: {tier, status, run_count_this_month, run_limit_monthly, trial_ends_at}

IMPORTANT: Use express.raw({type: 'application/json'}) as middleware ONLY on the webhook route 
(NOT as global middleware) to get the raw body for signature verification.
```

---

## Session 7 — Partner Portal

### Prompt S7-A: Partner Registration + Payout Engine

```
Build the Partner (Freelancer) management system for a compliance SaaS platform in 
Node.js/TypeScript + Express + better-sqlite3.

Database tables involved:
- partners: id, caas_ref_id, full_name, email, country, phone, payout_method, payout_details (JSON),
  status, approved_by, approved_at, portal_password_hash, commission_rate, created_at
- commissions: id, partner_id, tenant_id, invoice_amount, currency, commission_amount, status, 
  payout_reference, billing_event_id, created_at, paid_at
- accounts: referral_agent_id column (set when a tenant signs up via a partner referral link)

Part 1: Partner API Routes (src/routes/partner.ts)

POST /api/v1/partner/register (public, no auth)
- Body: {full_name, email, country, phone?, payout_method: 'momo'|'bank'|'stripe', payout_details}
- payout_details shape for momo: {momo_number, network: 'MTN'|'Vodafone'|'Airtel'}
- payout_details shape for bank: {account_number, bank_code, bank_name}
- Insert partners row with status='pending'
- Auto-generate: no caas_ref_id yet (assigned on approval)
- Send welcome email via Resend: "Your application is under review. You'll hear from us within 24h."
- Return 201 {"message": "Application received", "email": email}

POST /api/v1/partner/login (public)
- Body: {email, password}
- Lookup partner by email where status='approved'
- Verify argon2 hash
- Return JWT with payload: {partner_id, caas_ref_id, role: 'partner'}

GET /api/v1/partner/dashboard (partner JWT required)
- Return: {partner: {caas_ref_id, full_name, commission_rate}, 
           referral_url: 'https://app.aitwcloud.com/register?ref=CAAS-100-001',
           referred_clients: [{tenant_id, display_name, tier, status}],
           commission_summary: {pending_total, paid_total, total_earned},
           recent_commissions: [last 5]}

Admin route (Executive JWT required):
POST /api/v1/admin/partners/:id/approve
- Generate caas_ref_id: 'CAAS-100-' + (count_of_approved + 1).toString().padStart(3,'0')
- Generate a temporary password (crypto.randomBytes(8).toString('hex'))
- Hash with argon2, store in portal_password_hash
- Update status='approved', approved_by=req.userId, approved_at=now(), caas_ref_id
- Send approval email via Resend with: caas_ref_id, temporary password, partner portal URL
- Return 200 {caas_ref_id, temporary_password} — log this in audit_log

Part 2: Commission Payout Worker (src/workers/payoutWorker.ts)

This worker is triggered from billing.ts when a payment succeeds:
- After updating accounts.status='active', check if accounts.referral_agent_id is set
- If yes: enqueue a 'payout' job with {tenant_id, invoice_amount, currency, billing_event_id}

handlePayoutJob(db, payload):
1. Fetch the partner record from accounts.referral_agent_id
2. Calculate commission: invoice_amount * partner.commission_rate
3. Insert commissions row with status='pending'
4. Initiate Paystack transfer (for momo) or mark for manual payout (for bank/stripe):
   - MoMo: call Paystack Transfer API
   - Bank/Stripe: insert a 'manual_payout' alert for ops team; set status='settled' (awaiting manual)
5. On Paystack transfer success: update commissions.status='paid', store transfer_code as payout_reference
6. On failure: failJob() for retry; log the error
```

---

## Session 8 — Hardening

### Prompt S8-A: API Documentation + Integration Guide

```
Generate a complete API integration guide for the CaaS Hub platform in Markdown format, 
suitable for handing to an integration team.

The document should cover:

1. Base URLs
   - Production API: https://api.aitwcloud.com
   - Production Dashboard: https://app.aitwcloud.com/dashboard
   
2. Authentication
   - JWT via POST /api/v1/auth/login → returns access_token (15 min) and refresh_token (7 days)
   - API Key via Authorization: Bearer aitw_<key> header
   - Required header on all authenticated requests: X-CaaS-Tier: LITE|GROWTH|ENTERPRISE
   - Show full cURL example for login and for using the API key

3. Endpoint Reference (table format: Method, Path, Auth, Description)
   List all endpoints built in Sessions 1-7

4. Event Ingestion
   - Full payload schema with types and which fields are required vs optional
   - Show 3 example payloads: credit_scoring, hiring_decision, generic model
   - Show the 202 success response and common error responses (400, 402, 429)

5. Rate Limits
   - Table: Tier → requests/min
   - What happens when exceeded: 429 with Retry-After header

6. Webhook Setup (for clients who want to send events)
   - How to generate an API key (via dashboard)
   - How to include it in webhook calls
   - Retry behaviour if CaaS returns non-202

7. Common Errors
   Table: HTTP Status | Error Code | Meaning | How to fix

8. Testing
   - Full working cURL sequence that a new integration can run to prove the flow end-to-end
   - From login → send event → poll for result → fetch dashboard summary

Format: clean Markdown, suitable for a GitHub README or Notion page.
Output as: docs/INTEGRATION.md
```

---

## Reusable Prompt: Debug Helper

Use this any time something breaks:

```
I am working on the CaaS Hub platform (Node.js/TypeScript + Express + SQLite + Fly.io). 
Something is broken and I need help diagnosing it.

Here is what I was trying to do: [DESCRIBE THE TASK]

Here is the error I am seeing: [PASTE THE ERROR]

Here is the relevant code: [PASTE THE FILE OR FUNCTION]

Here is the DB schema for the relevant table(s): [PASTE FROM Database Schema Blueprint]

Please:
1. Identify the most likely root cause
2. Show me the exact fix (diff format if possible)
3. Tell me if this could affect any other part of the system
4. Suggest a quick test I can run to confirm the fix worked
```
