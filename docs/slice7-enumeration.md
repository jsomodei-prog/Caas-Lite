# Phase 15 Slice 7 — Sub-router Zod Schema Enumeration

**Status:** Enumeration only. No code changes. Schemas to be applied in subsequent sessions.

**Scope:** Every sub-router route under `src/routes/` that reads `req.body`,
`req.query`, or `req.params`. Per session decisions:

- Strictness: `.strict()` on every top-level object schema (rejects unknown keys).
- Ambiguous shapes: best-guess schema, flagged with **NOTE**.
- Current parsing: verbatim snippet (truncated >5 lines).
- Schemas: inline per route + extracted appendix (§ Appendix A).

## Summary

| File                  | Routes total | In scope (reads body/query/params) | Already uses `validate()` |
| --------------------- | -----------: | ---------------------------------: | ------------------------: |
| admin.ts              |            1 |                                  0 |                         — |
| auth.ts               |            6 |                                  4 |                         0 |
| badge.ts              |            2 |                                  1 |                         0 |
| commercial.ts         |           10 |                                  7 |                         0 |
| insurance.ts          |            5 |                                  4 |                         0 |
| pilot-ingest.ts       |            2 |                                  2 |                         0 |
| pov-billing.ts        |            2 |                                  2 |                         0 |
| provisioning.ts       |            4 |                                  4 |                         0 |
| regulatoryIngest.ts   |            4 |                                  4 |                         0 |
| risk-pricing.ts       |            1 |                                  1 |                         0 |
| users.ts              |            9 |                                  8 |                         0 |
| **Total**             |       **46** |                             **37** |                     **0** |

Zero sub-router routes currently use the `validate()` middleware. Slice 7 is a clean
add — no migration of existing schemas, just first-time application.

## Conventions used in this doc

Decisions applied uniformly across schema proposals. Where a handler's behavior
forces a deviation, the entry calls it out.

1. **Required strings** → `z.string().min(1)`. Bare `z.string()` accepts empty
   string, which no current handler treats as valid.
2. **IDs in `:id` / `:userId` / `:tenantId` / `:accountId`** → `z.string().uuid()`
   by default. Some IDs are not UUIDs (framework codes, tenant_id strings used as
   external identifiers); these are called out per route.
3. **Enums** → `z.enum([...])` whenever the handler currently does
   `if (!VALID_X.includes(v))`. Collapses two checks (type + validity) into one.
4. **Booleans in query strings** → `z.enum(["true","false"]).transform(s => s === "true")`.
   Note: `z.coerce.boolean()` is a trap — `"false"` coerces to `true`.
5. **Numbers in query strings** → `z.coerce.number()` with shape constraints
   (`.int()`, `.min()`, `.max()`, `.default()`) mirroring current `parseInt` logic.
6. **Optional vs default**:
   - Handler does `body.x ?? defaultValue` → schema gets `.default(defaultValue)`.
   - Handler does `if (body.x !== undefined)` → schema gets `.optional()`.
7. **`.strict()`** on every top-level object schema. Nested objects also `.strict()`
   unless the field is explicitly extensible (e.g. `metadata`, `payload`,
   `constraints` — these become `z.record(z.unknown())` without strictness).
8. **Ambiguous payloads** → best-guess schema with a **NOTE** explaining what was
   inferred and what remains uncertain. Per session decision.
9. **Inline checks RETAINED after schema** — when handler validation is doing
   semantic work beyond shape (DB existence checks, cross-field business rules,
   413-payload-too-large with byte counting, conditional 422 responses), the
   schema does NOT replace that logic. Listed per route under "Inline checks
   RETAINED". Implementation sessions must not delete these.
10. **Behavior changes** — when a proposed schema would *change* observable
    behavior versus the current handler (e.g. tightening from "any string" to
    "valid email"), the entry flags it as **BEHAVIOR CHANGE** so the
    implementation session can decide whether to keep the loose form.

## Notes that apply to multiple routes

- **Headers (`X-Tenant-ID`, JWT-derived tenant/user) are not validated by
  schemas.** Per `validate.ts` design: headers are upstream
  (`requireAccessToken`, `dualPlaneAuth`). Schemas in this doc only cover body /
  query / params.
- **Existing inline `AppError`-style throws** (e.g. `getTenantId()` in
  commercial.ts throws `Error` with `status: 400` if header missing) stay as-is.
  Header validation is out of scope.
- **`String(req.params.x)` calls** — many handlers wrap params in `String(...)`.
  Once a schema declares `z.string().uuid()`, the `String()` wrap becomes
  redundant; implementation sessions can drop it, but the doc proposes schemas
  that work whether or not the wrap is removed.

---

## src/routes/admin.ts

**Current state:** No ad-hoc parsing. Handler reads no body, query, or params.

**Routes:**

### POST /recompute-all

- **Status:** Out of scope. No `req.body` / `req.query` / `req.params` access.
- **Action:** None. Optional: an explicit `validate({})` could be added as
  documentation that no input is accepted, but it's a no-op.

---

## src/routes/auth.ts

**Current state:** Ad-hoc parsing on every mutation route. 4 of 6 routes in scope.

### POST /register

- **Auth:** None (per file header — "Restricted to Executive callers or
  service-to-service via internal API key" — but no middleware enforces this in
  the router; that's a separate concern not in slice 7 scope).
- **Current parsing:**
  ```ts
  const { username, email, password, role, tenant_id } = req.body as {
    username?: string;
    email?: string;
    password?: string;
    role?: CaaSRole;
    tenant_id?: string;
  };
  if (!username || !email || !password || !role || !tenant_id) {
    res.status(400).json({ error: "username, email, password, role, and tenant_id are required" });
    return;
  }
  const validRoles: CaaSRole[] = ["Executive", "Auditor", "Partner"];
  if (!validRoles.includes(role)) { /* 400 */ }
  ```
- **Proposed schema** (`RegisterBody`):
  ```ts
  const RegisterBody = z.object({
    username:  z.string().min(1),
    email:     z.string().email(),
    password:  z.string().min(1),
    role:      z.enum(["Executive", "Auditor", "Partner"]),
    tenant_id: z.string().min(1),
  }).strict();
  ```
- **BEHAVIOR CHANGE:** Current handler accepts any string as `email` — proposed
  schema enforces email format. If tests pass non-email strings, either loosen
  the schema or update fixtures.
- **Inline checks RETAINED:**
  - `validatePasswordStrength(password)` — returns 422 with policy-specific
    message (length, char classes). Could be expressed as a Zod refinement, but
    the current handler returns 422 (not 400) for password policy violations,
    and `validate()` always emits 400. Keep as inline post-schema check to
    preserve 422 status.
  - Tenant-uniqueness check (DB SELECT) and password hashing — semantic, stay.

### POST /login

- **Current parsing:**
  ```ts
  const { username, password, tenant_id } = req.body as {
    username?: string; password?: string; tenant_id?: string;
  };
  if (!username || !password || !tenant_id) { /* 400 */ }
  ```
- **Proposed schema** (`LoginBody`):
  ```ts
  const LoginBody = z.object({
    username:  z.string().min(1),
    password:  z.string().min(1),
    tenant_id: z.string().min(1),
  }).strict();
  ```
- **Inline checks RETAINED:** Constant-time user-existence check + lockout
  state + brute-force delay + `argon2.verify` — all semantic, stay.

### POST /refresh

- **Current parsing:**
  ```ts
  const { refresh_token } = req.body as { refresh_token?: string };
  if (!refresh_token) { res.status(400).json({ error: "refresh_token is required" }); return; }
  ```
- **Proposed schema** (`RefreshBody`):
  ```ts
  const RefreshBody = z.object({
    refresh_token: z.string().min(1),
  }).strict();
  ```
- **NOTE:** Could tighten to `.regex(/^[a-f0-9]{128}$/)` since `issueTokenPair`
  emits a 64-byte hex string. Leaving as `.min(1)` — token format is an
  implementation detail of `issueTokenPair`, and a future change there
  shouldn't break the schema. The 401 from `hashRefreshToken` + DB lookup
  catches any malformed value.

### POST /logout

- **Status:** Out of scope. Handler reads no body, query, or params (uses
  `req.caasUserId` from middleware).
- **Action:** None.

### GET /me

- **Status:** Out of scope. Same as logout.
- **Action:** None.

### POST /change-password

- **Auth:** `requireAccessToken`.
- **Current parsing:**
  ```ts
  const { current_password, new_password } = req.body as {
    current_password?: string;
    new_password?: string;
  };
  if (!current_password || !new_password) { /* 400 */ }
  ```
- **Proposed schema** (`ChangePasswordBody`):
  ```ts
  const ChangePasswordBody = z.object({
    current_password: z.string().min(1),
    new_password:     z.string().min(1),
  }).strict();
  ```
- **Inline checks RETAINED:**
  - `validatePasswordStrength(new_password)` — returns 422; same rationale as
    `/register`.
  - `argon2.verify` of current_password — semantic.
  - Reuse check (`samePassword`) — returns 422; semantic.

---

## src/routes/badge.ts

**Current state:** Ad-hoc string-coercion + presence check. 1 of 2 routes in scope.

### GET /:tenantId

- **Auth:** None (signature-gated, public-ish).
- **Current parsing:**
  ```ts
  const tenantId  = String(req.params.tenantId);
  const presented = String(req.query.sig ?? "");
  if (!presented) { res.status(404).json({ error: "Not found" }); return; }
  ```
- **Proposed schemas**:
  ```ts
  const BadgeParams = z.object({
    tenantId: z.string().min(1),
  }).strict();
  const BadgeQuery = z.object({
    sig: z.string().min(1),
  }).strict();
  ```
- **NOTE:** `tenantId` here is a tenant identifier string, not necessarily a
  UUID — the badge registry is keyed on whatever tenant_id the embedder
  presents. Using `.min(1)` rather than `.uuid()` to match current behavior.
- **BEHAVIOR CHANGE:** Current handler returns **404** for missing `sig` (to
  avoid distinguishing "no tenant" from "bad sig"). `validate()` would return
  **400** for missing `sig`. This *leaks information*: an attacker can now
  distinguish "missing sig parameter" from "wrong sig value", which the
  current design deliberately avoids.
  - **Recommendation:** Do **not** apply `BadgeQuery` to this route. Keep the
    inline `if (!presented)` check returning 404. Schema validation would
    weaken the existing privacy property. Apply only `BadgeParams`.
  - Implementation session: validate params only, leave query handling inline.

### OPTIONS /:tenantId

- **Status:** Out of scope. Handler reads nothing.
- **Action:** None.


---

## src/routes/commercial.ts

**Current state:** Heavy ad-hoc parsing with mixed query / body / params patterns.
7 of 10 routes in scope (3 GETs read only the `X-Tenant-ID` header). Note:
`getTenantId()` reads `X-Tenant-ID` header and
throws `Error` with `status: 400` — header validation, out of scope.

### GET /invoice-summary

- **Auth:** `requireRole("Executive")`.
- **Current parsing:**
  ```ts
  const limit  = Math.min(parseInt((req.query.limit  as string) ?? "12", 10), 50);
  const offset = parseInt((req.query.offset as string) ?? "0", 10);
  const status = req.query.status as string | undefined;
  ```
- **Proposed schema** (`InvoiceSummaryQuery`):
  ```ts
  const InvoiceSummaryQuery = z.object({
    limit:  z.coerce.number().int().min(1).max(50).default(12),
    offset: z.coerce.number().int().min(0).default(0),
    status: z.enum(["issued", "paid", "overdue", "void"]).optional(),
  }).strict();
  ```
- **NOTE:** `status` values inferred from the aggregates query in the same
  handler (`paid`, `issued`, `overdue` appear in the SUM CASE clauses).
  `void` is a guess based on common invoice lifecycle states — verify
  against `commercial_billing_ledgers.status` column constraint. If
  uncertain, loosen to `z.string().min(1).optional()` and let DB return
  empty result for unknown statuses.
- **BEHAVIOR CHANGE (minor):** Current `parseInt` of garbage returns `NaN`,
  used as-is in SQL — could yield empty result or error. Proposed schema
  rejects garbage with 400. Strictly an improvement.

### GET /invoice/:id

- **Auth:** `requireRole("Executive")`.
- **Current parsing:**
  ```ts
  const ledgerId  = String(req.params.id);
  ```
- **Proposed schema** (`InvoiceParams`):
  ```ts
  const InvoiceParams = z.object({
    id: z.string().uuid(),
  }).strict();
  ```
- **NOTE:** `id` is the `commercial_billing_ledgers.id` column. Assumed UUID
  per the codebase convention (`crypto.randomUUID()` everywhere). Verify
  against the schema migration; if the column is something else (auto-incr
  int? invoice number string?), adjust accordingly.

### POST /invoice/generate

- **Auth:** `requireRole("Executive")`.
- **Current parsing:**
  ```ts
  const fxRateRaw = (req.body as { fx_rate?: string }).fx_rate;
  let fxRate: number;
  if (fxRateRaw === undefined || fxRateRaw === null) {
    fxRate = 1.0;
  } else {
    const parsed = parseFloat(fxRateRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) { /* 400 */ }
    fxRate = parsed;
  }
  const invoiceCurrency = (req.body as { invoice_currency?: string }).invoice_currency ?? "USD";
  ```
- **Proposed schema** (`GenerateInvoiceBody`):
  ```ts
  const GenerateInvoiceBody = z.object({
    fx_rate: z.coerce.number().positive().finite().default(1.0),
    invoice_currency: z.string().length(3).default("USD"),
  }).strict();
  ```
- **NOTE:** Current handler accepts `fx_rate` as a *string* and `parseFloat`s
  it. `z.coerce.number()` handles both numeric and string-encoded JSON
  values; tests passing numeric `fx_rate` will continue to work.
- **BEHAVIOR CHANGE:** Current `invoice_currency` accepts any string;
  proposed schema requires length 3 (ISO 4217). Flag for verification —
  if any test uses `"USDC"` or similar, loosen to `z.string().min(1)`.
- **Slice 6g HIGH-3 preservation:** the inline guard against zero / negative
  / NaN `fx_rate` (with the noted `parseFloat("0") || 1.0` bug fix) is
  fully captured by `.positive().finite()` in the schema. Schema replaces
  this entirely.

### GET /insurance-certificate

- **Auth:** `requireRole("Executive", "Auditor")`.
- **Status:** No body, no query, no params (other than tenant via header).
- **Action:** None — out of scope per "header validation upstream" rule.

### POST /insurance/register

- **Auth:** `requireRole("Executive")`.
- **Current parsing:**
  ```ts
  const body = req.body as {
    carrier_name:           string;
    carrier_id:             string;
    policy_number:          string;
    coverage_type:          CoverageType;
    coverage_limit_usd:     number;
    deductible_usd:         number;
    base_annual_premium_usd: number;
    policy_start_date:      string;
    policy_end_date:        string;
    jurisdiction?:          string;
  };
  const required = [
    "carrier_name", "carrier_id", "policy_number", "coverage_type",
    "coverage_limit_usd", "deductible_usd", "base_annual_premium_usd",
    "policy_start_date", "policy_end_date",
  ] as const;
  for (const field of required) {
    if (!body[field]) { res.status(400).json({ error: `Field "${field}" is required` }); return; }
  }
  ```
- **Proposed schema** (`RegisterPolicyBody`):
  ```ts
  const RegisterPolicyBody = z.object({
    carrier_name:            z.string().min(1),
    carrier_id:              z.string().min(1),
    policy_number:           z.string().min(1),
    coverage_type:           z.string().min(1), // see NOTE
    coverage_limit_usd:      z.coerce.number().positive().finite(),
    deductible_usd:          z.coerce.number().nonnegative().finite(),
    base_annual_premium_usd: z.coerce.number().positive().finite(),
    policy_start_date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    policy_end_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    jurisdiction:            z.string().min(1).optional(),
  }).strict();
  ```
- **NOTE:** `coverage_type` is typed as `CoverageType` (imported from
  `commercialEngine`). Need to inspect `CoverageType` to know whether it's a
  union literal type. If it is (e.g. `"general_liability" | "errors_omissions"`),
  the schema should be `z.enum([...])`. Flagged as uncertain — implementation
  session must inspect `commercialEngine` types and tighten.
- **BEHAVIOR CHANGE:** Current `if (!body[field])` rejects `0`,
  empty strings, etc. — but for `coverage_limit_usd: 0` that's actually correct
  (a zero-limit policy is nonsensical). Schema enforces `.positive()` for
  premium/limit, matching real intent. `deductible_usd` allowed at 0
  (`.nonnegative()`) since a zero-deductible policy is legitimate.
- **BEHAVIOR CHANGE (numeric coercion):** Current handler does
  `Number(body.coverage_limit_usd)` *after* the falsy check, which means a
  string like `"100"` would pass the check then convert. Schema's
  `z.coerce.number()` matches this. But the existing `if (!body[field])`
  check on numbers means `0` was rejected — schema needs the explicit
  `.positive()` / `.nonnegative()` constraint to preserve that.
- **Inline checks RETAINED:** Engine-level validation (cross-field date
  range, policy_number uniqueness) and the audit log call — semantic.

### POST /insurance/audit

- **Auth:** `requireRole("Executive")`.
- **Current parsing:**
  ```ts
  const registryId = String((req.body as { registry_id?: string }).registry_id ?? "");
  if (!registryId) { res.status(400).json({ error: "registry_id is required" }); return; }
  ```
- **Proposed schema** (`UnderwritingAuditBody`):
  ```ts
  const UnderwritingAuditBody = z.object({
    registry_id: z.string().uuid(),
  }).strict();
  ```
- **NOTE:** Assuming `registry_id` is a UUID per `crypto.randomUUID()`
  convention. Verify against `insurance_underwriting_registry.id` schema.

### GET /subscription

- **Auth:** `requireRole("Executive", "Auditor")`.
- **Status:** No body, no query, no params.
- **Action:** None.

### POST /subscription/create

- **Auth:** `requireRole("Executive")`.
- **Current parsing:**
  ```ts
  const body = req.body as {
    tier:                    SubscriptionTier;
    billing_cycle?:          "monthly" | "quarterly" | "annual";
    invoice_currency?:       string;
    contract_ref?:           string;
    custom_fee?:             number;
    custom_runs?:            number;
    custom_monitors?:        number;
    custom_overage_rate?:    number;
    custom_monitor_overage?: number;
  };
  const validTiers: SubscriptionTier[] = ["PAY_AS_YOU_GO", "GROWTH", "ENTERPRISE", "CUSTOM"];
  if (!body.tier || !validTiers.includes(body.tier)) { /* 400 */ }
  ```
- **Proposed schema** (`CreateSubscriptionBody`):
  ```ts
  const CreateSubscriptionBody = z.object({
    tier: z.enum(["PAY_AS_YOU_GO", "GROWTH", "ENTERPRISE", "CUSTOM"]),
    billing_cycle:          z.enum(["monthly", "quarterly", "annual"]).optional(),
    invoice_currency:       z.string().length(3).optional(),
    contract_ref:           z.string().min(1).optional(),
    custom_fee:             z.coerce.number().nonnegative().finite().optional(),
    custom_runs:            z.coerce.number().int().nonnegative().optional(),
    custom_monitors:        z.coerce.number().int().nonnegative().optional(),
    custom_overage_rate:    z.coerce.number().nonnegative().finite().optional(),
    custom_monitor_overage: z.coerce.number().nonnegative().finite().optional(),
  }).strict();
  ```
- **NOTE:** Same `invoice_currency` length-3 caveat as `/invoice/generate`.
- **Inline check RETAINED:** Cross-field rule: when `tier === "CUSTOM"`, at
  least one `custom_*` field should arguably be required. The current handler
  does **not** enforce this — it just passes `undefined` to the engine. Schema
  matches current behavior; flagged as a possible follow-up. Could be added as
  a `.refine()` if business logic requires it.

### POST /token/apply

- **Auth:** `requireRole("Executive")`.
- **Current parsing:**
  ```ts
  const { ledger_id, token_id } = req.body as { ledger_id?: string; token_id?: string };
  if (!ledger_id) { res.status(400).json({ error: "ledger_id is required" }); return; }
  if (!token_id)  { res.status(400).json({ error: "token_id is required" });  return; }
  ```
- **Proposed schema** (`ApplyTokenBody`):
  ```ts
  const ApplyTokenBody = z.object({
    ledger_id: z.string().uuid(),
    token_id:  z.string().uuid(),
  }).strict();
  ```
- **Inline checks RETAINED:** Ledger-belongs-to-tenant check (403) and
  ledger-exists check (404) — semantic.

### GET /tokens

- **Auth:** `requireRole("Executive", "Auditor")`.
- **Status:** No body, no query, no params.
- **Action:** None.

---

## src/routes/insurance.ts

**Current state:** Ad-hoc parsing on 4 of 5 routes (GET `/policies` is tenant-from-JWT
only and has no in-scope inputs). CRIT-1 tenant-ownership checks (slice 6g) are
inline post-DB-lookup and remain semantic — schemas don't touch them.

### GET /policies

- **Status:** No body, no query, no params (tenant from JWT).
- **Action:** None.

### GET /policies/:id

- **Current parsing:**
  ```ts
  const id = String(req.params.id);
  ```
- **Proposed schema** (`PolicyParams`):
  ```ts
  const PolicyParams = z.object({
    id: z.string().uuid(),
  }).strict();
  ```
- **Inline checks RETAINED:** CRIT-1 tenant ownership check (super-admin
  bypass), DB existence (404). Semantic, stay.

### POST /policies (bindPolicy)

- **Current parsing:**
  ```ts
  const { account_id, coverage_ends_at } = req.body as {
    account_id?:       string;
    coverage_ends_at?: string;
  };
  if (!account_id) { res.status(400).json({ error: "account_id is required" }); return; }
  ```
- **Proposed schema** (`BindPolicyBody`):
  ```ts
  const BindPolicyBody = z.object({
    account_id:       z.string().uuid(),
    coverage_ends_at: z.string().datetime().optional(),
  }).strict();
  ```
- **NOTE:** `coverage_ends_at` is stored as an ISO string and used in
  `new Date(...)` comparisons elsewhere. `z.string().datetime()` enforces
  RFC 3339 / ISO 8601 form. Verify test fixtures use this format; if they
  use `YYYY-MM-DD` only, switch to a custom regex or `.refine()`.
- **Inline checks RETAINED:** Account existence (404), CRIT-1 tenant
  ownership check.

### POST /policies/:id/recompute

- **Current parsing:**
  ```ts
  const id = String(req.params.id);
  ```
  (No body read.)
- **Proposed schema:** Reuse `PolicyParams` from `GET /policies/:id`.
  ```ts
  // Reuses PolicyParams
  ```
- **Inline checks RETAINED:** Warranty existence (404), CRIT-1 tenant ownership.

### PATCH /policies/:id/external

- **Current parsing:**
  ```ts
  const id = String(req.params.id);
  const { external_carrier_id, external_policy_number } = req.body as {
    external_carrier_id?:    string;
    external_policy_number?: string;
  };
  ```
- **Proposed schemas:**
  ```ts
  // Reuses PolicyParams
  const AttachExternalBody = z.object({
    external_carrier_id:    z.string().min(1).optional(),
    external_policy_number: z.string().min(1).optional(),
  }).strict();
  ```
- **NOTE:** Current handler does NOT require either field — both are
  optional, and the UPDATE uses `?? warranty.external_carrier_id` to no-op
  on missing values. Schema matches this. Could add `.refine(d => d.external_carrier_id || d.external_policy_number, "Provide at least one field")` if PATCH-with-empty-body should be rejected, but current
  behavior allows it (silently no-ops). Matching existing behavior.
- **Inline checks RETAINED:** Warranty existence (404), CRIT-1 tenant
  ownership, slice 6g HIGH-1 tenant-scoped UPDATE.

---

## src/routes/pilot-ingest.ts

**Current state:** Most complex body validation in the codebase. Single OR
batch payloads, byte caps, finite-number checks. 2 of 2 routes in scope.

### POST /decisions

- **Auth:** `requireApiKey` (API-key bearer; not JWT).
- **Current parsing:**
  ```ts
  const body = req.body as DecisionPayload | { decisions?: DecisionPayload[] };
  const decisions: DecisionPayload[] = Array.isArray((body as { decisions?: unknown[] }).decisions)
    ? (body as { decisions: DecisionPayload[] }).decisions
    : [body as DecisionPayload];
  if (decisions.length === 0) { /* 400 */ }
  if (decisions.length > MAX_BATCH_SIZE) { /* 413 */ }
  for (const [i, d] of decisions.entries()) {
    const payloadStr = JSON.stringify(d.payload ?? {});
    if (Buffer.byteLength(payloadStr, "utf-8") > MAX_PAYLOAD_BYTES) { /* 413 */ }
    if (d.risk_score !== undefined && (typeof d.risk_score !== "number" || !Number.isFinite(d.risk_score))) { /* 400 */ }
  }
  ```
- **Proposed schemas:**
  ```ts
  const DecisionPayloadSchema = z.object({
    client_decision_id: z.string().min(1).optional(),
    decision_class:     z.string().min(1).optional(),
    risk_score:         z.number().finite().optional(),
    payload:            z.record(z.unknown()).optional(),
  }).strict();

  const IngestDecisionsBody = z.union([
    DecisionPayloadSchema,
    z.object({
      decisions: z.array(DecisionPayloadSchema).min(1),
    }).strict(),
  ]);
  ```
- **NOTE 1:** The `payload` field is intentionally an arbitrary JSON object
  per design — `z.record(z.unknown())` is correct here, NOT a placeholder.
- **NOTE 2:** Schema uses `z.union` for "single OR batch" shape. The current
  handler's `Array.isArray(body.decisions) ? batch : [single]` normalization
  should happen AFTER validation, not inside the schema, so the handler
  still sees `req.body` in its declared form and normalizes there. Schema
  enforces that one of the two shapes was sent — full stop.
- **Inline checks RETAINED (CRITICAL — do not remove during implementation):**
  - **Batch size cap returning 413**: `decisions.length > 50` → 413 Payload
    Too Large. The schema could enforce `.max(50)` returning 400, but the
    413 semantic is meaningful (it signals to the client "your batch is too
    big, split it" — different intent than "your batch is malformed"). KEEP
    the inline 413 check. Schema does NOT include `.max(50)`.
  - **Per-payload byte cap (8KB) returning 413**: requires computing
    `JSON.stringify(d.payload).byteLength` — not expressible in Zod without
    a `.refine()` that does the same work. KEEP inline.
  - **Empty array check**: schema's `.min(1)` covers the batch-mode empty
    case. The single-mode case (an empty object `{}`) is technically still
    "one decision" — current handler accepts that (the `[body]` wrap creates
    a one-element array). Schema matches that behavior.
- **BEHAVIOR CHANGE (minor):** Schema rejects unknown keys (`.strict()`).
  Current handler silently ignores them. If clients send extra fields
  (debug flags, SDK metadata), they'll now 400. Flag for test verification.

### GET /decisions

- **Auth:** `requireApiKey`.
- **Current parsing:**
  ```ts
  const limit = Math.min(parseInt((req.query.limit as string) ?? "50", 10) || 50, 500);
  const since = typeof req.query.since === "string" ? req.query.since : null;
  ```
- **Proposed schema** (`ListDecisionsQuery`):
  ```ts
  const ListDecisionsQuery = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(50),
    since: z.string().datetime().optional(),
  }).strict();
  ```
- **NOTE:** Current `parseInt(...) || 50` masks invalid input (NaN, 0)
  silently. Proposed schema rejects garbage with 400. Strictly better;
  flag if any test relies on the fallback.
- **BEHAVIOR CHANGE:** `since` validated as ISO 8601 datetime. Current
  handler passes the raw string into the SQL `received_at > ?` comparator
  — SQLite's lexicographic comparison happens to work for ISO 8601 strings
  but would silently mis-filter garbage input. Schema makes this explicit.

---

## src/routes/pov-billing.ts

**Current state:** Two GET routes, both with `:accountId` param and `window_days`
query.

### GET /:accountId/statement (JSON)

- **Current parsing:**
  ```ts
  const accountId  = String(req.params.accountId);
  const windowDays = parseWindowDays(req); // see helper
  ```
  Helper:
  ```ts
  function parseWindowDays(req: Request): number {
    const raw = parseInt((req.query.window_days as string) ?? "30", 10);
    if (!Number.isFinite(raw) || raw <= 0) return 30;
    return Math.min(raw, 365);
  }
  ```
- **Proposed schemas:**
  ```ts
  const StatementParams = z.object({
    accountId: z.string().uuid(),
  }).strict();
  const StatementQuery = z.object({
    window_days: z.coerce.number().int().min(1).max(365).default(30),
  }).strict();
  ```
- **BEHAVIOR CHANGE:** Current `parseWindowDays` silently clamps invalid
  input to 30 (e.g. `window_days=-5` becomes 30, `window_days=abc` becomes
  30, `window_days=9999` becomes 365). Schema rejects with 400 instead of
  silently coercing.
  - **Recommendation:** Schema is the right behavior — silent clamping
    masks bugs in callers. But this IS a behavior change, so flag for the
    implementation session. If a test passes `window_days=abc` expecting
    30, the test should be updated, not the schema loosened.

### GET /:accountId/statement.txt

- Same as above. Reuse both schemas.

---

## src/routes/provisioning.ts

**Current state:** Ad-hoc on 4 routes. Uses `requireBusinessPlane` for 3 of 4.

### POST / (createAccount)

- **Current parsing:**
  ```ts
  const body = req.body as CreateAccountBody;
  if (!body.tenant_id || !body.display_name) { /* 400 */ }
  const tier = body.tier ?? "LITE";
  if (!VALID_TIERS.includes(tier)) { /* 400 */ }
  ```
  Where `CreateAccountBody` is:
  ```ts
  interface CreateAccountBody {
    tenant_id:     string;
    display_name:  string;
    tier?:         AccountTier;
    contact_email?: string;
    pilot_days?:   number;
  }
  ```
- **Proposed schema** (`CreateAccountBody`):
  ```ts
  const CreateAccountBody = z.object({
    tenant_id:     z.string().min(1),
    display_name:  z.string().min(1),
    tier:          z.enum(["LITE", "GROWTH", "ENTERPRISE"]).default("LITE"),
    contact_email: z.string().email().optional(),
    pilot_days:    z.coerce.number().int().positive().default(30),
  }).strict();
  ```
- **BEHAVIOR CHANGE:** Current `contact_email` accepts any string; schema
  requires email format. Verify test fixtures.
- **BEHAVIOR CHANGE:** Current handler accepts `pilot_days: 0` or negative
  silently (would yield `pilot_ends < pilot_started`). Schema enforces
  `.positive()`. Strictly better.
- **Inline checks RETAINED:** Tenant-uniqueness check (409), badge sync,
  audit log — semantic.

### GET /:id (getAccount)

- **Current parsing:**
  ```ts
  const id = String(req.params.id);
  ```
- **Proposed schema** (`AccountParams`):
  ```ts
  const AccountParams = z.object({
    id: z.string().uuid(),
  }).strict();
  ```

### PATCH /:id/tier (changeTier)

- **Current parsing:**
  ```ts
  const id = String(req.params.id);
  const { tier } = req.body as { tier?: AccountTier };
  if (!tier || !VALID_TIERS.includes(tier)) { /* 400 */ }
  ```
- **Proposed schemas:**
  ```ts
  // Reuses AccountParams
  const ChangeTierBody = z.object({
    tier: z.enum(["LITE", "GROWTH", "ENTERPRISE"]),
  }).strict();
  ```
- **Inline checks RETAINED:** Account existence (404), no-op short-circuit
  on same-tier, slice 6g HIGH-1 tenant-scoped UPDATE — semantic.

### POST /:id/rotate-key (rotateApiKey)

- **Current parsing:**
  ```ts
  const id = String(req.params.id);
  ```
- **Proposed schema:** Reuse `AccountParams`.
- **Inline checks RETAINED:** Account existence (404), slice 6g HIGH-1
  tenant-scoped UPDATE.

---

## src/routes/regulatoryIngest.ts

**Current state:** Has the most thorough handwritten validator in the codebase
(`validateFrameworkPayload`). 4 of 4 routes in scope. This file is the
biggest schema lift in slice 7.

### POST /onboard

- **Auth:** `requireGlobalSuperAdmin` (router-level).
- **Current parsing:** Calls `validateFrameworkPayload(req.body)` — a 200+ line
  handwritten validator (lines 163-449 of the source). Truncated example of
  the pattern:
  ```ts
  const validation = validateFrameworkPayload(req.body);
  if (!validation.valid || !validation.data) {
    res.status(400).json({
      error:   "VALIDATION_FAILED",
      message: "The submitted framework payload failed validation.",
      details: validation.errors ?? [],
    });
    return;
  }
  const payload = validation.data;
  ```
- **Proposed schemas:**
  ```ts
  const FIELD_KEY_RE       = /^[a-z_][a-z0-9_]*$/;
  const FRAMEWORK_CODE_RE  = /^[A-Z][A-Z0-9_]*$/;
  const REGION_CODE_RE     = /^[A-Z]{2}$/;
  const REGEX_FLAGS_RE     = /^[gimsuy]*$/;
  const ISO_DATE_RE        = /^\d{4}-\d{2}-\d{2}$/;

  const DataTypeSchema = z.enum([
    "string", "number", "boolean", "date", "email", "phone", "identifier",
  ]);

  const FieldRuleSchema = z.object({
    field_key:        z.string().min(1).max(128).regex(FIELD_KEY_RE),
    field_label:      z.string().min(1).max(255),
    data_type:        DataTypeSchema,
    is_required:      z.boolean().default(false),
    is_sensitive:     z.boolean().default(false),
    min_length:       z.number().int().min(0).max(10_000).optional(),
    max_length:       z.number().int().min(1).max(10_000).optional(),
    validation_regex: z.string().min(1).max(2048).optional(),
    regex_flags:      z.string().regex(REGEX_FLAGS_RE).default(""),
    error_message:    z.string().max(1024).optional(),
    allowed_values:   z.array(z.string().min(1).max(255)).max(500).optional(),
    constraints:      z.record(z.unknown()).default({}),
    display_order:    z.number().int().min(0).max(10_000).default(0),
  }).strict()
    .refine(
      d => d.min_length === undefined || d.max_length === undefined || d.min_length <= d.max_length,
      { message: "min_length cannot exceed max_length", path: ["min_length"] }
    )
    .refine(
      d => d.allowed_values === undefined || new Set(d.allowed_values).size === d.allowed_values.length,
      { message: "allowed_values must not contain duplicates", path: ["allowed_values"] }
    )
    .refine(
      d => {
        if (d.validation_regex === undefined) return true;
        try { new RegExp(d.validation_regex, d.regex_flags ?? ""); return true; }
        catch { return false; }
      },
      { message: "validation_regex must be a compilable regex", path: ["validation_regex"] }
    );

  const ConsentPurposeSchema = z.object({
    purpose_code:              z.string().min(1).max(128).regex(FIELD_KEY_RE),
    purpose_label:             z.string().min(1).max(255),
    description:               z.string().max(2048).optional(),
    lawful_basis:              z.string().max(128).optional(),
    requires_explicit_consent: z.boolean().default(false),
    retention_days:            z.number().int().min(0).max(36_500).optional(),
  }).strict();

  const OnboardBody = z.object({
    framework_code:   z.string().min(1).max(64).regex(FRAMEWORK_CODE_RE),
    framework_name:   z.string().min(1).max(255),
    region_code:      z.string().length(2).regex(REGION_CODE_RE),
    region_name:      z.string().min(1).max(128),
    regulator_name:   z.string().max(255).optional(),
    version:          z.string().min(1).max(32),
    description:      z.string().max(8192).optional(),
    source_url:       z.string().url().max(1024).optional(),
    effective_date:   z.string().regex(ISO_DATE_RE).optional(),
    is_active:        z.boolean().default(true),
    metadata:         z.record(z.unknown()).default({}),
    field_rules:      z.array(FieldRuleSchema).min(1).max(200),
    consent_purposes: z.array(ConsentPurposeSchema).max(100).default([]),
  }).strict()
    .refine(
      d => {
        const keys = d.field_rules.map(r => r.field_key);
        return new Set(keys).size === keys.length;
      },
      { message: "field_rules must not contain duplicate field_keys", path: ["field_rules"] }
    )
    .refine(
      d => {
        const codes = d.consent_purposes.map(p => p.purpose_code);
        return new Set(codes).size === codes.length;
      },
      { message: "consent_purposes must not contain duplicate purpose_codes", path: ["consent_purposes"] }
    );
  ```
- **NOTE 1 (error shape change — IMPORTANT):** Current handler returns
  ```json
  { "error": "VALIDATION_FAILED", "message": "...", "details": ["..."] }
  ```
  where `details` is an array of human strings. The `validate()` middleware
  returns `AppError.badRequest("Invalid request body", { section: "body", issues: [...] })`
  via the global handler — the issue shape differs (Zod `{path, code, message}` per issue).
  **This is a breaking change to the API error format.** Recommendation: either
  (a) accept the change as part of slice 7's "normalize error shape" goal, or
  (b) keep `validateFrameworkPayload` as a layer that wraps the Zod result into
  the legacy shape. Flag prominently for product/API-stability discussion.

- **NOTE 2 (regex compilability):** The `validation_regex` field is currently
  test-compiled with `new RegExp(...)`. Captured in the `.refine()` above.
  Behaves identically.

- **NOTE 3 (duplicates):** Three duplicate-detection rules in the original
  (field_keys, purpose_codes, allowed_values per rule). All three captured
  in `.refine()` blocks above.

- **Inline checks RETAINED:** Uniqueness check via `stmts.findByCode.get`
  (409), UNIQUE-constraint race handling, audit log call — semantic.

### GET /frameworks

- **Current parsing:**
  ```ts
  const regionFilter   = req.query.region_code  as string | undefined;
  const activeFilterQ  = req.query.is_active    as string | undefined;
  const regionOk = regionFilter !== undefined && REGION_CODE_RE.test(regionFilter);
  const activeProvided = activeFilterQ !== undefined;
  const activeValue = activeFilterQ === "true" ? 1 : activeFilterQ === "false" ? 0 : null;
  if (activeProvided && activeValue === null) { /* 400 */ }
  ```
- **Proposed schema** (`ListFrameworksQuery`):
  ```ts
  const ListFrameworksQuery = z.object({
    region_code: z.string().length(2).regex(REGION_CODE_RE).optional(),
    is_active:   z.enum(["true", "false"])
                  .transform(s => s === "true")
                  .optional(),
  }).strict();
  ```
- **NOTE:** Current handler silently *ignores* invalid `region_code` (doesn't
  match the regex → just doesn't filter). Schema would 400 instead. This is
  a **BEHAVIOR CHANGE** — silently degrading filters to "no filter" hides
  client bugs; schema makes it explicit. Recommend the strict form, but flag.
- **NOTE on the boolean idiom:** `z.enum(["true","false"]).transform(...)` is
  the recommended replacement for `z.coerce.boolean()` (see Conventions § 4).

### GET /frameworks/:code

- **Current parsing:**
  ```ts
  const code = String(req.params.code);
  if (!FRAMEWORK_CODE_RE.test(code)) { /* 400 */ }
  ```
- **Proposed schema** (`FrameworkParams`):
  ```ts
  const FrameworkParams = z.object({
    code: z.string().min(1).max(64).regex(FRAMEWORK_CODE_RE),
  }).strict();
  ```

### PATCH /frameworks/:code

- **Current parsing:**
  ```ts
  const code = String(req.params.code);
  if (!FRAMEWORK_CODE_RE.test(code)) { /* 400 */ }
  if (!isObject(req.body)) { /* 400 */ }
  const { is_active, metadata } = req.body as { is_active?: unknown; metadata?: unknown };
  const errs: string[] = [];
  if (is_active !== undefined && typeof is_active !== "boolean") { errs.push(...); }
  if (metadata !== undefined && !isObject(metadata))             { errs.push(...); }
  if (is_active === undefined && metadata === undefined)         { errs.push(...); }
  ```
- **Proposed schemas:**
  ```ts
  // Reuses FrameworkParams
  const PatchFrameworkBody = z.object({
    is_active: z.boolean().optional(),
    metadata:  z.record(z.unknown()).optional(),
  }).strict()
    .refine(
      d => d.is_active !== undefined || d.metadata !== undefined,
      { message: "Provide at least one of: is_active, metadata" }
    );
  ```
- **NOTE:** The "at least one field" rule is captured in `.refine()`. Schema
  preserves the current behavior exactly. Same error-shape note as
  `/onboard` applies — current handler returns `{error: "VALIDATION_FAILED", details: [...]}`;
  `validate()` returns the standard `AppError.badRequest` shape.
- **Inline checks RETAINED:** Framework existence (404), audit log — semantic.

---

## src/routes/risk-pricing.ts

**Current state:** Single mutation route. Has its own `validateSeries` helper.

### POST /quote

- **Current parsing:**
  ```ts
  const body = req.body as QuoteRequestBody;
  if (!body || typeof body.vessel_class !== "string") { /* 400 */ }
  const seriesCheck = validateSeries(body.series);
  if (!seriesCheck.ok) { /* 400 with seriesCheck.error */ }
  // [resolve vessel_class or custom_config — see below]
  ```
  Where `validateSeries`:
  ```ts
  function validateSeries(series: unknown): { ok: true } | { ok: false; error: string } {
    if (!Array.isArray(series)) return { ok: false, error: "series must be an array" };
    if (series.length === 0)    return { ok: false, error: "series cannot be empty" };
    if (series.length > 365)    return { ok: false, error: "series cannot exceed 365 entries" };
    for (let i = 0; i < series.length; i++) {
      const d = series[i] as Partial<TimeSeriesDay>;
      if (typeof d?.date !== "string") return { ok: false, error: `series[${i}].date must be a string` };
      if (typeof d?.events !== "number"        || d.events < 0)        return { ok: false, error: `series[${i}].events invalid` };
      if (typeof d?.severity_sum !== "number"  || d.severity_sum < 0)  return { ok: false, error: `series[${i}].severity_sum invalid` };
      if (typeof d?.anomaly_count !== "number" || d.anomaly_count < 0) return { ok: false, error: `series[${i}].anomaly_count invalid` };
      if (typeof d?.drift_flag !== "boolean")  return { ok: false, error: `series[${i}].drift_flag must be boolean` };
    }
    return { ok: true };
  }
  ```
  Plus vessel-class resolution:
  ```ts
  if (body.vessel_class === "custom") {
    if (!body.custom_config) { /* 400 */ }
    config = body.custom_config;
  } else {
    const found = VESSEL_CLASSES[body.vessel_class];
    if (!found) { /* 400 — unknown vessel_class */ }
    config = found;
  }
  ```
- **Proposed schemas:**
  ```ts
  const TimeSeriesDaySchema = z.object({
    date:          z.string().min(1),
    events:        z.number().nonnegative().finite(),
    severity_sum:  z.number().nonnegative().finite(),
    anomaly_count: z.number().nonnegative().finite(),
    drift_flag:    z.boolean(),
  }).strict();

  const QuoteBody = z.object({
    vessel_class:  z.string().min(1),
    series:        z.array(TimeSeriesDaySchema).min(1).max(365),
    custom_config: z.record(z.unknown()).optional(), // see NOTE
  }).strict();
  ```
- **NOTE 1 (vessel_class):** Deliberately `z.string().min(1)` rather than
  `z.enum(["CONTAINER_SHIP", "TUGBOAT", "custom"])`. Reason: the
  `VESSEL_CLASSES` registry is designed to grow (new ship classes added
  over time); locking the schema to the current set would force a schema
  edit on every new vessel class. The handler's lookup + 404 stays as the
  validity gate.
- **NOTE 2 (custom_config):** `VesselClassConfig` is imported from
  `../lib/premium-pricing` — a structured type. The current handler accepts
  it as-is without validating its shape (`body.custom_config` is used
  directly). Two options:
  - (a) `z.record(z.unknown())` — passes through anything, matches current
    laxness. Recommended for slice 7.
  - (b) Properly schema `VesselClassConfig` — requires reading
    `premium-pricing.ts`, out of scope for this enumeration. Flag as a
    follow-up.
- **NOTE 3 (date format):** `TimeSeriesDay.date` is `z.string().min(1)`,
  matching current handler's `typeof d?.date !== "string"` check. The
  handler does not enforce ISO 8601 — could tighten to
  `z.string().regex(/^\d{4}-\d{2}-\d{2}$/)` if all callers conform. Flag
  for verification.
- **Inline checks RETAINED:**
  - `if (body.vessel_class === "custom" && !body.custom_config)` —
    cross-field rule expressible as `.refine()`. Could move into schema;
    leaving inline preserves the specific error message. Implementation
    session's call.
  - Unknown `vessel_class` 400 (DB-like lookup miss) — semantic, stay.

---

## src/routes/users.ts

**Current state:** Ad-hoc on 8 of 9 routes (GET `/` reads only header). Two
notable patterns: (1) `getTenantId(req)` reads `X-Tenant-ID` header — header
validation upstream. (2) Several routes use `req.params.userId` with no
validation.

### GET /

- **Current parsing:** None beyond header. No query, body, or params.
- **Action:** None.

### GET /audit-log

- **Current parsing:**
  ```ts
  const limit = Math.min(parseInt((req.query.limit as string) ?? "100", 10), 500);
  ```
- **Proposed schema** (`AuditLogQuery`):
  ```ts
  const AuditLogQuery = z.object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }).strict();
  ```
- **BEHAVIOR CHANGE:** Current `parseInt(garbage)` is `NaN`, then
  `Math.min(NaN, 500)` is `NaN`, which becomes the SQL `LIMIT` parameter
  — better-sqlite3 will reject this with an error. Schema rejects with 400
  cleanly. Improvement.

### GET /:userId (getUser)

- **Current parsing:**
  ```ts
  const userId = String(req.params.userId);
  ```
- **Proposed schema** (`UserParams`):
  ```ts
  const UserParams = z.object({
    userId: z.string().uuid(),
  }).strict();
  ```

### POST /:userId/profile (upsertProfile)

- **Current parsing:**
  ```ts
  const {
    display_name, phone, country_code, preferred_currency,
    bio, kyc_tier, profile_status,
  } = req.body as Partial<ExtendedProfile>;
  ```
- **Proposed schemas:**
  ```ts
  // Reuses UserParams
  const UpsertProfileBody = z.object({
    display_name:       z.string().min(1).optional(),
    phone:              z.string().min(1).optional(),
    country_code:       z.string().length(2).optional(),
    preferred_currency: z.string().length(3).optional(),
    bio:                z.string().optional(),
    kyc_tier:           z.enum(["basic", "standard", "enhanced"]).optional(),
    profile_status:     z.enum(["active", "suspended", "pending_kyc", "pending_review"]).optional(),
  }).strict();
  ```
- **NOTE:** `kyc_tier` values from `KycTier` (basic/standard/enhanced — same set
  used in `elevateKyc` below). `profile_status` from `ProfileStatus` type
  declaration at line 32 of users.ts.
- **NOTE on phone format:** Current handler does NOT validate phone format
  (the type comment says "E.164" but no enforcement). Schema matches current
  laxness; tightening to E.164 (`.regex(/^\+[1-9]\d{1,14}$/)`) would be a
  behavior change. Flag for product decision.
- **BEHAVIOR CHANGE:** `country_code` currently any string; schema enforces
  length 2 (ISO 3166-1 alpha-2). The handler then passes it to
  `getCountryRequirement` which would throw on invalid codes anyway (caught
  as 422). Schema catches earlier as 400. Acceptable.
- **Inline checks RETAINED:** Country requirement check via
  `getCountryRequirement` + currency acceptance (returns 422) — semantic.

### POST /:userId/role (assignRole)

- **Current parsing:**
  ```ts
  const userId = String(req.params.userId);
  const { role, reason } = req.body as { role?: CaaSRole; reason?: string };
  const validRoles: CaaSRole[] = ["Executive", "Auditor", "Partner"];
  if (!role || !validRoles.includes(role)) { /* 400 */ }
  ```
- **Proposed schemas:**
  ```ts
  // Reuses UserParams
  const AssignRoleBody = z.object({
    role:   z.enum(["Executive", "Auditor", "Partner"]),
    reason: z.string().min(1).optional(),
  }).strict();
  ```
- **Inline checks RETAINED:** User existence (404), no-op short-circuit on
  same-role, slice 6g HIGH-1 tenant-scoped UPDATE — semantic.

### POST /:userId/kyc (elevateKyc)

- **Current parsing:**
  ```ts
  const userId = String(req.params.userId);
  const { kyc_tier, evidence_ref } = req.body as { kyc_tier?: KycTier; evidence_ref?: string };
  const validTiers: KycTier[] = ["basic", "standard", "enhanced"];
  if (!kyc_tier || !validTiers.includes(kyc_tier)) { /* 400 */ }
  ```
- **Proposed schemas:**
  ```ts
  // Reuses UserParams
  const ElevateKycBody = z.object({
    kyc_tier:     z.enum(["basic", "standard", "enhanced"]),
    evidence_ref: z.string().min(1).optional(),
  }).strict();
  ```
- **NOTE on evidence_ref:** Type allows optional. Real-world KYC elevation
  *should* require evidence — but the current handler does not enforce this,
  passing `evidence_ref ?? null` to the audit log. Schema matches current
  behavior. Flag as a product question for future tightening.

### POST /:userId/freelancer (registerFreelancer)

- **Current parsing:**
  ```ts
  const userId = String(req.params.userId);
  const reg    = req.body as FreelancerRegistration;
  ```
  Where `FreelancerRegistration` is:
  ```ts
  interface FreelancerRegistration {
    user_id: string;
    tenant_id: string;
    display_name: string;
    country_code: string;
    payout_method: "momo" | "card";
    momo_number?: string;
    momo_provider?: string;
    card_token?: string;
    payout_threshold_usd: number;
    preferred_currency: string;
  }
  ```
- **Proposed schemas:**
  ```ts
  // Reuses UserParams
  const RegisterFreelancerBody = z.object({
    display_name:         z.string().min(1),
    country_code:         z.string().length(2),
    payout_method:        z.enum(["momo", "card"]),
    momo_number:          z.string().min(1).optional(),
    momo_provider:        z.string().min(1).optional(),
    card_token:           z.string().min(1).optional(),
    payout_threshold_usd: z.coerce.number().nonnegative().finite(),
    preferred_currency:   z.string().length(3),
  }).strict();
  ```
- **NOTE 1:** The `FreelancerRegistration` interface declares `user_id` and
  `tenant_id` as required body fields, but the handler doesn't use them —
  it reads `userId` from `req.params.userId` and `tenantId` from the
  `X-Tenant-ID` header. The body fields appear vestigial. The proposed
  schema OMITS them, since accepting them in the body would invite
  confusion (which `user_id` wins — body or URL?). Flag for verification:
  do any callers send body `user_id`/`tenant_id`? If so, the schema with
  `.strict()` will 400 them, exposing the latent inconsistency.
- **NOTE 2 (cross-field):** `payout_method === "momo"` should require
  `momo_number` + `momo_provider`; `payout_method === "card"` should
  require `card_token`. Current handler doesn't enforce this — passes
  `?? null` through. Schema matches current behavior. Could be added as
  `.refine()`. Flag as a possible product hardening.
- **Inline checks RETAINED:** User existence (404), country requirement
  check, payout-method-supported-in-country check (both 422),
  duplicate-freelancer check (409) — all semantic.

### POST /:userId/api-key (generateApiKey)

- **Current parsing:**
  ```ts
  const userId = String(req.params.userId);
  ```
- **Proposed schema:** Reuse `UserParams`.

### GET /:userId/permissions/test (testPermissions)

- **Current parsing:**
  ```ts
  const userId = String(req.params.userId);
  ```
- **Proposed schema:** Reuse `UserParams`.
- **Inline checks RETAINED:** User existence (404).

---

## Appendix A — Named schemas (cross-reference)

Every proposed schema, grouped by file. Implementation sessions can copy
this appendix directly into the relevant `src/routes/*.ts` files (or a
sibling `*.schemas.ts` if you prefer to separate them — that's a per-file
decision, not made here).

All schemas assume `import { z } from "zod"` at the top of the file.

### auth.ts

```ts
const RegisterBody = z.object({
  username:  z.string().min(1),
  email:     z.string().email(),
  password:  z.string().min(1),
  role:      z.enum(["Executive", "Auditor", "Partner"]),
  tenant_id: z.string().min(1),
}).strict();

const LoginBody = z.object({
  username:  z.string().min(1),
  password:  z.string().min(1),
  tenant_id: z.string().min(1),
}).strict();

const RefreshBody = z.object({
  refresh_token: z.string().min(1),
}).strict();

const ChangePasswordBody = z.object({
  current_password: z.string().min(1),
  new_password:     z.string().min(1),
}).strict();
```

### badge.ts

```ts
const BadgeParams = z.object({
  tenantId: z.string().min(1),
}).strict();
// NOTE: BadgeQuery is NOT applied — see route entry; would weaken privacy.
```

### commercial.ts

```ts
const InvoiceSummaryQuery = z.object({
  limit:  z.coerce.number().int().min(1).max(50).default(12),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(["issued", "paid", "overdue", "void"]).optional(),
}).strict();

const InvoiceParams = z.object({
  id: z.string().uuid(),
}).strict();

const GenerateInvoiceBody = z.object({
  fx_rate:          z.coerce.number().positive().finite().default(1.0),
  invoice_currency: z.string().length(3).default("USD"),
}).strict();

const RegisterPolicyBody = z.object({
  carrier_name:            z.string().min(1),
  carrier_id:              z.string().min(1),
  policy_number:           z.string().min(1),
  coverage_type:           z.string().min(1), // tighten to z.enum once CoverageType is inspected
  coverage_limit_usd:      z.coerce.number().positive().finite(),
  deductible_usd:          z.coerce.number().nonnegative().finite(),
  base_annual_premium_usd: z.coerce.number().positive().finite(),
  policy_start_date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  policy_end_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  jurisdiction:            z.string().min(1).optional(),
}).strict();

const UnderwritingAuditBody = z.object({
  registry_id: z.string().uuid(),
}).strict();

const CreateSubscriptionBody = z.object({
  tier: z.enum(["PAY_AS_YOU_GO", "GROWTH", "ENTERPRISE", "CUSTOM"]),
  billing_cycle:          z.enum(["monthly", "quarterly", "annual"]).optional(),
  invoice_currency:       z.string().length(3).optional(),
  contract_ref:           z.string().min(1).optional(),
  custom_fee:             z.coerce.number().nonnegative().finite().optional(),
  custom_runs:            z.coerce.number().int().nonnegative().optional(),
  custom_monitors:        z.coerce.number().int().nonnegative().optional(),
  custom_overage_rate:    z.coerce.number().nonnegative().finite().optional(),
  custom_monitor_overage: z.coerce.number().nonnegative().finite().optional(),
}).strict();

const ApplyTokenBody = z.object({
  ledger_id: z.string().uuid(),
  token_id:  z.string().uuid(),
}).strict();
```

### insurance.ts

```ts
const PolicyParams = z.object({
  id: z.string().uuid(),
}).strict();

const BindPolicyBody = z.object({
  account_id:       z.string().uuid(),
  coverage_ends_at: z.string().datetime().optional(),
}).strict();

const AttachExternalBody = z.object({
  external_carrier_id:    z.string().min(1).optional(),
  external_policy_number: z.string().min(1).optional(),
}).strict();
```

### pilot-ingest.ts

```ts
const DecisionPayloadSchema = z.object({
  client_decision_id: z.string().min(1).optional(),
  decision_class:     z.string().min(1).optional(),
  risk_score:         z.number().finite().optional(),
  payload:            z.record(z.unknown()).optional(),
}).strict();

const IngestDecisionsBody = z.union([
  DecisionPayloadSchema,
  z.object({
    decisions: z.array(DecisionPayloadSchema).min(1),
  }).strict(),
]);
// NOTE: batch size cap (50) and per-payload byte cap (8KB) stay inline.

const ListDecisionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  since: z.string().datetime().optional(),
}).strict();
```

### pov-billing.ts

```ts
const StatementParams = z.object({
  accountId: z.string().uuid(),
}).strict();

const StatementQuery = z.object({
  window_days: z.coerce.number().int().min(1).max(365).default(30),
}).strict();
```

### provisioning.ts

```ts
const CreateAccountBody = z.object({
  tenant_id:     z.string().min(1),
  display_name:  z.string().min(1),
  tier:          z.enum(["LITE", "GROWTH", "ENTERPRISE"]).default("LITE"),
  contact_email: z.string().email().optional(),
  pilot_days:    z.coerce.number().int().positive().default(30),
}).strict();

const AccountParams = z.object({
  id: z.string().uuid(),
}).strict();

const ChangeTierBody = z.object({
  tier: z.enum(["LITE", "GROWTH", "ENTERPRISE"]),
}).strict();
```

### regulatoryIngest.ts

```ts
const FIELD_KEY_RE      = /^[a-z_][a-z0-9_]*$/;
const FRAMEWORK_CODE_RE = /^[A-Z][A-Z0-9_]*$/;
const REGION_CODE_RE    = /^[A-Z]{2}$/;
const REGEX_FLAGS_RE    = /^[gimsuy]*$/;
const ISO_DATE_RE       = /^\d{4}-\d{2}-\d{2}$/;

const DataTypeSchema = z.enum([
  "string", "number", "boolean", "date", "email", "phone", "identifier",
]);

const FieldRuleSchema = z.object({
  field_key:        z.string().min(1).max(128).regex(FIELD_KEY_RE),
  field_label:      z.string().min(1).max(255),
  data_type:        DataTypeSchema,
  is_required:      z.boolean().default(false),
  is_sensitive:     z.boolean().default(false),
  min_length:       z.number().int().min(0).max(10_000).optional(),
  max_length:       z.number().int().min(1).max(10_000).optional(),
  validation_regex: z.string().min(1).max(2048).optional(),
  regex_flags:      z.string().regex(REGEX_FLAGS_RE).default(""),
  error_message:    z.string().max(1024).optional(),
  allowed_values:   z.array(z.string().min(1).max(255)).max(500).optional(),
  constraints:      z.record(z.unknown()).default({}),
  display_order:    z.number().int().min(0).max(10_000).default(0),
}).strict()
  .refine(
    d => d.min_length === undefined || d.max_length === undefined || d.min_length <= d.max_length,
    { message: "min_length cannot exceed max_length", path: ["min_length"] }
  )
  .refine(
    d => d.allowed_values === undefined || new Set(d.allowed_values).size === d.allowed_values.length,
    { message: "allowed_values must not contain duplicates", path: ["allowed_values"] }
  )
  .refine(
    d => {
      if (d.validation_regex === undefined) return true;
      try { new RegExp(d.validation_regex, d.regex_flags ?? ""); return true; }
      catch { return false; }
    },
    { message: "validation_regex must be a compilable regex", path: ["validation_regex"] }
  );

const ConsentPurposeSchema = z.object({
  purpose_code:              z.string().min(1).max(128).regex(FIELD_KEY_RE),
  purpose_label:             z.string().min(1).max(255),
  description:               z.string().max(2048).optional(),
  lawful_basis:              z.string().max(128).optional(),
  requires_explicit_consent: z.boolean().default(false),
  retention_days:            z.number().int().min(0).max(36_500).optional(),
}).strict();

const OnboardBody = z.object({
  framework_code:   z.string().min(1).max(64).regex(FRAMEWORK_CODE_RE),
  framework_name:   z.string().min(1).max(255),
  region_code:      z.string().length(2).regex(REGION_CODE_RE),
  region_name:      z.string().min(1).max(128),
  regulator_name:   z.string().max(255).optional(),
  version:          z.string().min(1).max(32),
  description:      z.string().max(8192).optional(),
  source_url:       z.string().url().max(1024).optional(),
  effective_date:   z.string().regex(ISO_DATE_RE).optional(),
  is_active:        z.boolean().default(true),
  metadata:         z.record(z.unknown()).default({}),
  field_rules:      z.array(FieldRuleSchema).min(1).max(200),
  consent_purposes: z.array(ConsentPurposeSchema).max(100).default([]),
}).strict()
  .refine(
    d => new Set(d.field_rules.map(r => r.field_key)).size === d.field_rules.length,
    { message: "field_rules must not contain duplicate field_keys", path: ["field_rules"] }
  )
  .refine(
    d => new Set(d.consent_purposes.map(p => p.purpose_code)).size === d.consent_purposes.length,
    { message: "consent_purposes must not contain duplicate purpose_codes", path: ["consent_purposes"] }
  );

const ListFrameworksQuery = z.object({
  region_code: z.string().length(2).regex(REGION_CODE_RE).optional(),
  is_active:   z.enum(["true", "false"]).transform(s => s === "true").optional(),
}).strict();

const FrameworkParams = z.object({
  code: z.string().min(1).max(64).regex(FRAMEWORK_CODE_RE),
}).strict();

const PatchFrameworkBody = z.object({
  is_active: z.boolean().optional(),
  metadata:  z.record(z.unknown()).optional(),
}).strict()
  .refine(
    d => d.is_active !== undefined || d.metadata !== undefined,
    { message: "Provide at least one of: is_active, metadata" }
  );
```

### risk-pricing.ts

```ts
const TimeSeriesDaySchema = z.object({
  date:          z.string().min(1),
  events:        z.number().nonnegative().finite(),
  severity_sum:  z.number().nonnegative().finite(),
  anomaly_count: z.number().nonnegative().finite(),
  drift_flag:    z.boolean(),
}).strict();

const QuoteBody = z.object({
  vessel_class:  z.string().min(1),
  series:        z.array(TimeSeriesDaySchema).min(1).max(365),
  custom_config: z.record(z.unknown()).optional(),
}).strict();
```

### users.ts

```ts
const AuditLogQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();

const UserParams = z.object({
  userId: z.string().uuid(),
}).strict();

const UpsertProfileBody = z.object({
  display_name:       z.string().min(1).optional(),
  phone:              z.string().min(1).optional(),
  country_code:       z.string().length(2).optional(),
  preferred_currency: z.string().length(3).optional(),
  bio:                z.string().optional(),
  kyc_tier:           z.enum(["basic", "standard", "enhanced"]).optional(),
  profile_status:     z.enum(["active", "suspended", "pending_kyc", "pending_review"]).optional(),
}).strict();

const AssignRoleBody = z.object({
  role:   z.enum(["Executive", "Auditor", "Partner"]),
  reason: z.string().min(1).optional(),
}).strict();

const ElevateKycBody = z.object({
  kyc_tier:     z.enum(["basic", "standard", "enhanced"]),
  evidence_ref: z.string().min(1).optional(),
}).strict();

const RegisterFreelancerBody = z.object({
  display_name:         z.string().min(1),
  country_code:         z.string().length(2),
  payout_method:        z.enum(["momo", "card"]),
  momo_number:          z.string().min(1).optional(),
  momo_provider:        z.string().min(1).optional(),
  card_token:           z.string().min(1).optional(),
  payout_threshold_usd: z.coerce.number().nonnegative().finite(),
  preferred_currency:   z.string().length(3),
}).strict();
```

---

## Appendix B — Schema reuse map

Schemas defined once and reused across multiple routes within a file.

| Schema             | File                  | Routes that reuse it                                                 |
| ------------------ | --------------------- | -------------------------------------------------------------------- |
| `PolicyParams`     | insurance.ts          | GET `/policies/:id`, POST `/policies/:id/recompute`, PATCH `/policies/:id/external` |
| `StatementParams`  | pov-billing.ts        | GET `/:accountId/statement`, GET `/:accountId/statement.txt`         |
| `StatementQuery`   | pov-billing.ts        | both statement routes                                                |
| `AccountParams`    | provisioning.ts       | GET `/:id`, POST `/:id/rotate-key`, PATCH `/:id/tier`                |
| `FrameworkParams`  | regulatoryIngest.ts   | GET `/frameworks/:code`, PATCH `/frameworks/:code`                   |
| `UserParams`       | users.ts              | GET `/:userId`, POST `/:userId/profile`, POST `/:userId/role`, POST `/:userId/kyc`, POST `/:userId/freelancer`, POST `/:userId/api-key`, GET `/:userId/permissions/test` |

---

## Appendix C — Routes with `**NOTE**` or `**BEHAVIOR CHANGE**` flags

Quick index for the implementation sessions. Sorted by severity.

### Privacy / security flags (HIGHEST priority — review before implementing)

- **badge.ts — GET /:tenantId** — applying schema to `?sig=...` query would
  weaken the existing 404-vs-400 privacy property. Do NOT apply `BadgeQuery`;
  validate params only.

### API contract changes (review before implementing)

- **regulatoryIngest.ts — POST /onboard** — error response shape changes
  from `{error, message, details: string[]}` to standard `AppError` shape
  with `{section, issues}`. Same for PATCH `/frameworks/:code`. Decide
  whether to keep legacy shape via wrapper or accept the normalization.
- **pilot-ingest.ts — POST /decisions** — `.strict()` rejects unknown
  fields; current handler silently ignores them. SDK clients sending
  unrecognized fields will now 400.

### Type-inspection follow-ups (must resolve during implementation)

- **commercial.ts — POST /insurance/register** — `coverage_type` should
  likely be `z.enum([...])`; need to read `CoverageType` from
  `commercialEngine` to know the literal set.
- **risk-pricing.ts — POST /quote** — `custom_config` typed as
  `VesselClassConfig`; could be properly schemaed by reading
  `premium-pricing.ts`. Slice 7 uses `z.record(z.unknown())` for laxness.

### Schema vs. inline placement decisions

- **auth.ts — /register, /change-password** — `validatePasswordStrength`
  returns **422**; `validate()` always returns **400**. Keep password
  policy as inline post-schema check.
- **pilot-ingest.ts — POST /decisions** — batch-too-large returns **413**;
  schema would return 400. Keep size cap inline (and the 8KB byte cap
  too, which Zod can't express cleanly).
- **risk-pricing.ts — POST /quote** — `vessel_class === "custom"` requires
  `custom_config`. Could be `.refine()` in schema or stay inline. Either
  works; implementation session chooses based on error-message style.

### Tightenings (improvements that change observable behavior)

- **provisioning.ts — POST /** — `contact_email` validated as email
  (was: any string).
- **provisioning.ts — POST /** — `pilot_days` must be positive (was:
  accepted 0 / negative silently).
- **commercial.ts — POST /invoice/generate** — `invoice_currency` length 3.
- **commercial.ts — POST /subscription/create** — `invoice_currency` length 3.
- **users.ts — POST /:userId/profile** — `country_code` length 2,
  `preferred_currency` length 3.
- **users.ts — POST /:userId/freelancer** — same.
- **pov-billing.ts — both statement routes** — `window_days` garbage is
  rejected (was: silently clamped to 30).
- **regulatoryIngest.ts — GET /frameworks** — invalid `region_code` is
  rejected (was: silently degraded to "no filter").
- **multiple files** — Query-string number parsing returns 400 on garbage
  (was: `parseInt` returned NaN and was used unchecked).

### Possible product hardenings (NOT applied in slice 7; flagged for future)

- **users.ts — POST /:userId/profile** — phone format (E.164 regex).
- **users.ts — POST /:userId/kyc** — make `evidence_ref` required.
- **users.ts — POST /:userId/freelancer** — drop unused `user_id`/`tenant_id`
  body fields; cross-field rule for momo-vs-card required fields.
- **commercial.ts — POST /subscription/create** — require at least one
  `custom_*` field when `tier === "CUSTOM"`.
- **insurance.ts — PATCH /policies/:id/external** — require at least one
  field (currently no-ops on empty body).
- **risk-pricing.ts — POST /quote** — `TimeSeriesDay.date` ISO 8601 regex.

### IDs assumed UUID — verify against schema migrations

- `commercial.ts` — `invoice/:id`, `apply-token.ledger_id`, `apply-token.token_id`,
  `insurance/audit.registry_id`
- `insurance.ts` — `policies/:id`, `bindPolicy.account_id`
- `pov-billing.ts` — `:accountId`
- `provisioning.ts` — `accounts/:id`
- `users.ts` — `:userId`

Any of these that are not UUIDs in the actual DB schema need their schemas
loosened to `z.string().min(1)` or to a format-specific regex.

---

## Appendix D — Implementation order recommendation

If applying schemas across multiple sessions, suggested order from lowest
to highest risk:

1. **risk-pricing.ts** (1 route, pure compute, already had its own validator) —
   smallest blast radius, good warm-up.
2. **admin.ts** — nothing to do; mark complete.
3. **pov-billing.ts** (2 routes, GETs only, simple) — small.
4. **badge.ts** (1 route, params only) — small; remember the privacy caveat.
5. **provisioning.ts** (4 routes, well-defined `CreateAccountBody`) — medium.
6. **insurance.ts** (5 routes, reuses `PolicyParams`) — medium.
7. **auth.ts** (4 routes; care needed around 422 vs 400 for password policy) —
   medium-high; auth is sensitive.
8. **commercial.ts** (9 routes; needs `CoverageType` inspection) — high.
9. **users.ts** (9 routes; phone/E.164 question, vestigial body fields) — high.
10. **pilot-ingest.ts** (2 routes, but 413 semantics + union shape) — high.
11. **regulatoryIngest.ts** (4 routes; error-shape compatibility decision
    required first) — highest; settle the legacy shape question before
    starting.
