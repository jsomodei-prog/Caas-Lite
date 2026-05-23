# Phase 15 Slice 7 — Hardening Tracker

**Status:** Living document. Updated as items move through review, decision, and rollout. Successor to `docs/slice7-enumeration.md` Appendix C.

**Scope:** Validation-layer tightenings and contract-shape reconciliations identified during slice 7 (POST-slice-7-merge) that were intentionally deferred. Each item is either:

- A **product hardening** — requires a decision from product / compliance / SDK team about whether to enforce a stricter rule than current behavior.
- A **reconciliation** — closes a known inconsistency between files or between TypeScript types and runtime schemas; requires engineering judgment plus a test-impact review.
- A **verification** — needs a five-minute check against a migration or column constraint; outcome may then promote it to a code change.

Items already shipped between slice 7 merge and the most recent revision of this doc are listed under **§ Shipped** at the bottom so the history doesn't get lost.

---

## Conventions

**Item IDs.** Each item has a stable ID (`H-001`, `R-001`, `V-001`) so PRs, tickets, and review comments can reference it without ambiguity. IDs are append-only — if an item is dropped, its ID is retired, not reused.

**Status values.**

| Status | Meaning |
|---|---|
| `Open` | Identified, not yet triaged. Needs decision from a named owner. |
| `Decided` | Product / engineering decision recorded. Implementation not started. |
| `In Progress` | Branch open, schema / handler edits in flight. |
| `Shipped` | Merged to master. Item moved to § Shipped. |
| `Won't Fix` | Decided against. Reasoning recorded. Item moved to § Shipped (with status). |
| `Blocked` | Waiting on something external (other team, infrastructure, schema migration). |

**Owner.** Every Open item should have a named owner before it leaves the triage cycle. `?` is acceptable for items that haven't been triaged but anything older than two weeks at `?` is a process failure, not a normal state.

**Rollout posture.** One of:

- **Drop-in** — Schema change is strictly safer than current behavior (rejects garbage that previously caused silent breakage). Safe to merge alongside fixture updates. Use when the broken inputs have no plausible legitimate use.
- **Coordinated** — Breaks code outside this repo (SDK, dashboard, external callers). Requires coordinated release: SDK update first, then this change, then deprecation notice.
- **Soft-warn** — Server logs the would-be-rejected input but still accepts it, for one release. Decision to flip to hard-enforce based on whether the warning fires in production.
- **Hard cutover** — One-step enforcement. Justified only when soft-warn isn't feasible (e.g. the rule depends on data the server doesn't see in soft-mode).

**Per-merge discipline.** Each item, when shipped, gets the same treatment slice 7 files got: prominent header block, behavior-change list, no-behavior-change list, pre-merge checks. The doc-comment lift is part of the change, not optional.

---

## Hardening items (need product input)

### H-001 — users.ts POST /:userId/profile — phone E.164

- **Source:** Slice 7 enumeration doc Appendix C; users.ts `UpsertProfileBody` schema comment.
- **Status:** `Open`. **Owner:** `?`
- **Current behavior:** `phone` accepts any non-empty string. The `ExtendedProfile` TypeScript type's JSDoc comment claims E.164 but no enforcement runs.
- **Proposed change:**
  ```ts
  // In UpsertProfileBody:
  phone: z.string().regex(/^\+[1-9]\d{1,14}$/).optional(),
  ```
- **Behavior change:** Requests sending `phone: "555-1234"` or `phone: "(202) 555-0100"` or other non-E.164 forms → currently accepted, would 400.
- **Affected:**
  - Any test fixture using non-E.164 phone strings.
  - Production callers who entered phones in local format and had them stored as-is.
  - Existing rows in `user_profiles.phone` that are NOT E.164 — they continue to exist but can no longer be re-saved without reformatting.
- **Product question:** *Are we comfortable rejecting local-format phone numbers at the API boundary?* Specifically:
  - Do we have a normalization step elsewhere (libphonenumber-style) that turns local-format into E.164 before this endpoint sees it?
  - If not, do we want to enforce E.164 server-side and push the formatting burden onto clients, or do server-side normalization?
  - Are there onboarding flows (signup, KYC) where users enter phone in local format and expect it to be stored as-typed for display purposes?
- **Suggested rollout:** **Soft-warn** for one release. Log when phone fails the E.164 regex but still accept. If logs show <0.1% of writes failing, hard cutover in the next release. Otherwise, build server-side normalization first.
- **Pre-merge checks (when implementing):**
  - `grep -r "phone:.*[^+\d]" tests/` — fixtures with non-E.164 phones.
  - Sample 100 rows from `user_profiles.phone WHERE phone IS NOT NULL` and check the E.164 hit rate.

---

### H-002 — users.ts POST /:userId/kyc — make `evidence_ref` required

- **Source:** Slice 7 enumeration doc Appendix C; users.ts `ElevateKycBody` schema comment.
- **Status:** `Open`. **Owner:** `?`
- **Current behavior:** `evidence_ref` is optional. The handler passes `evidence_ref ?? null` to the audit log, so KYC elevations can be recorded without any evidence pointer.
- **Proposed change:**
  ```ts
  // In ElevateKycBody:
  evidence_ref: z.string().min(1),  // was .optional()
  ```
- **Behavior change:** `POST /:userId/kyc` without `evidence_ref` → currently 200, would 400.
- **Affected:**
  - Test fixtures that elevate KYC without evidence (probably most of them).
  - Audit-log rows: future KYC elevations all have non-null `evidence_ref`. Existing rows with NULL are unaffected.
  - Any internal tool / dashboard that elevates KYC without prompting for evidence.
- **Product question:** *Is KYC elevation without an evidence pointer ever legitimate?* Likely answers and their implications:
  - **No, never** — the field should be required at the API boundary. Internal tools must be updated to capture an evidence reference (could be a document URL, an internal case ID, a free-text note).
  - **Yes, for super-admin overrides** — the field should be required by default but bypassable when the caller has a specific role. Schema enforcement isn't the right gate; this becomes a handler-level conditional.
  - **Yes, for the basic→standard transition only** — make required when `kyc_tier === "enhanced"`, optional otherwise. Cross-field `.refine()`.
- **Suggested rollout:** **Coordinated.** This isn't a syntactic tightening; it's a process change. Step 1: identify all callers of `POST /:userId/kyc`. Step 2: ensure each can supply an evidence_ref. Step 3: ship the schema change. **Compliance / regulatory team is the natural owner**, not engineering alone.
- **Pre-merge checks (when implementing):**
  - `SELECT COUNT(*) FROM role_audit_log WHERE action = 'kyc_elevation' AND new_value IS NOT NULL AND reason IS NULL` — count of historical elevations that lacked evidence. If non-trivial, the rollout needs a backfill conversation.
  - `grep -r "evidence_ref" tests/` — fixture audit.

---

### H-003 — users.ts POST /:userId/freelancer — momo-vs-card cross-field rule

- **Source:** Slice 7 enumeration doc Appendix C; users.ts `RegisterFreelancerBody` schema comment.
- **Status:** `Open`. **Owner:** `?`
- **Current behavior:** Schema enforces `payout_method: z.enum(["momo", "card"])` but does NOT require `momo_number` + `momo_provider` when `momo`, or `card_token` when `card`. Handler passes `?? null` through to the INSERT.
- **Proposed change:**
  ```ts
  // Append to RegisterFreelancerBody:
  .refine(
    d => d.payout_method !== "momo" || (d.momo_number !== undefined && d.momo_provider !== undefined),
    { message: "momo payout requires momo_number and momo_provider", path: ["payout_method"] }
  )
  .refine(
    d => d.payout_method !== "card" || d.card_token !== undefined,
    { message: "card payout requires card_token", path: ["payout_method"] }
  )
  ```
- **Behavior change:** `POST /:userId/freelancer` with `payout_method: "momo"` and no momo_number → currently inserts a row with NULL momo fields (which then can't actually be paid out), would 400.
- **Affected:**
  - Existing freelancer rows with `payout_method = "momo" AND momo_number IS NULL` — they continue to exist (latent broken state) and can't be re-saved.
  - Test fixtures registering freelancers without payout-method-specific fields.
  - The dashboard onboarding flow if it lets users select method before filling in details.
- **Product question:** *Is registering a freelancer with an incomplete payout configuration ever intentional?*
  - If "no" — apply the refines, and the next conversation is whether to ship a backfill that flips incomplete rows to `locked = 1` or similar.
  - If "yes, the row is created in step 1 of a multi-step onboarding flow" — the schema stays loose, but then the *payout pipeline* must reject incomplete rows when attempting to pay. That's a separate validation layer, not this one.
- **Suggested rollout:** **Drop-in** if the answer is "no" and the dashboard already collects the fields before submit. **Coordinated** if the dashboard has a multi-step flow that posts an incomplete row.
- **Pre-merge checks (when implementing):**
  - `SELECT COUNT(*) FROM agents WHERE (payout_method = 'momo' AND momo_number IS NULL) OR (payout_method = 'card' AND card_token IS NULL)` — count of latent-broken rows.
  - Walk the dashboard freelancer onboarding flow end-to-end before merging.

---

### H-004 — commercial.ts POST /subscription/create — CUSTOM requires custom_*

- **Source:** Slice 7 enumeration doc Appendix C; commercial.ts `CreateSubscriptionBody` schema comment.
- **Status:** `Open`. **Owner:** `?`
- **Current behavior:** `tier: "CUSTOM"` is accepted with no `custom_*` fields. The engine then uses default fallbacks for every custom slot, defeating the point of the CUSTOM tier.
- **Proposed change:**
  ```ts
  // Append to CreateSubscriptionBody:
  .refine(
    d => d.tier !== "CUSTOM" || (
      d.custom_fee !== undefined ||
      d.custom_runs !== undefined ||
      d.custom_monitors !== undefined ||
      d.custom_overage_rate !== undefined ||
      d.custom_monitor_overage !== undefined
    ),
    { message: "CUSTOM tier requires at least one custom_* field", path: ["tier"] }
  )
  ```
- **Behavior change:** `POST /subscription/create` with `tier: "CUSTOM"` and no `custom_*` → currently 201 (subscription created with all defaults), would 400.
- **Affected:**
  - Probably zero production callers — a CUSTOM subscription with no custom fields is provisioning-by-accident.
  - Test fixtures that exercise the CUSTOM path with default values to test the tier-creation flow itself.
- **Product question:** *Is there a legitimate use case for `tier: "CUSTOM"` with all-default values?* Almost certainly no. The point of CUSTOM is to override defaults; "CUSTOM with no overrides" is functionally identical to whatever the engine's default tier is.
- **Suggested rollout:** **Drop-in.** This is the lowest-impact hardening in the list; it catches a misuse that has no legitimate counterpart.
- **Pre-merge checks (when implementing):**
  - `grep -r '"CUSTOM"' tests/ src/` — find any CUSTOM-tier code paths.
  - `SELECT COUNT(*) FROM tenant_commercial_subscriptions WHERE tier = 'CUSTOM' AND custom_fee IS NULL AND custom_runs IS NULL` — count of historical no-op CUSTOMs. If non-zero, ask whether they're real or test residue.

---

### H-005 — insurance.ts PATCH /policies/:id/external — require at-least-one field

- **Source:** Slice 7 enumeration doc Appendix C; insurance.ts `AttachExternalBody` schema comment.
- **Status:** `Open`. **Owner:** `?`
- **Current behavior:** Both `external_carrier_id` and `external_policy_number` are optional. An empty body `{}` is valid and produces a no-op UPDATE plus an audit row with identical before/after values.
- **Proposed change:**
  ```ts
  // Append to AttachExternalBody:
  .refine(
    d => d.external_carrier_id !== undefined || d.external_policy_number !== undefined,
    { message: "Provide at least one of: external_carrier_id, external_policy_number" }
  )
  ```
- **Behavior change:** `PATCH /policies/:id/external` with `{}` → currently 200 (no-op), would 400.
- **Affected:**
  - Test fixtures that hit this endpoint with empty body (probably none — it's a strange thing to do).
  - Any internal job that re-sweeps policies and PATCH-pokes them without actually changing anything (which would now log audit-row noise *and* error 400 on the no-op poke).
- **Product question:** *Does any internal job rely on the no-op PATCH behavior to refresh `updated_at`?* If yes, find the job and have it use a dedicated touch endpoint instead.
- **Suggested rollout:** **Drop-in** if no internal jobs depend on the no-op. **Soft-warn** if uncertain — log when empty-body PATCH arrives, watch for one release, then hard cutover.
- **Pre-merge checks (when implementing):**
  - `SELECT COUNT(*) FROM commercial_audit_log WHERE action = 'external_attach' AND old_value = new_value` — count of historical no-op audit rows.

---

### H-006 — risk-pricing.ts POST /quote — TimeSeriesDay.date ISO 8601 regex

- **Source:** Slice 7 enumeration doc Appendix C; risk-pricing.ts `TimeSeriesDaySchema` comment (NOTE 3 in the schema doc).
- **Status:** `Open`. **Owner:** `?`
- **Current behavior:** `date: z.string().min(1)` — any non-empty string passes. The risk-profile engine consumes `series[i].date` for time-window calculations; non-ISO inputs break the math downstream silently.
- **Proposed change:**
  ```ts
  // In TimeSeriesDaySchema:
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ```
- **Behavior change:** Quote requests with `series[i].date = "2026/06/01"` or `series[i].date = "01-06-2026"` or other non-ISO forms → currently silently mis-process, would 400.
- **Affected:**
  - The risk-pricing endpoint is a calculator with no state; no DB rows to migrate.
  - Test fixtures using non-ISO dates in series payloads.
  - SDK callers if any of them generate dates from a non-ISO source (e.g. raw `Date.toString()` instead of `Date.toISOString().slice(0, 10)`).
- **Product question:** None — this is engineering hygiene. The current laxness is silently buggy, not deliberately permissive.
- **Suggested rollout:** **Drop-in.** The current behavior is "appear to work, produce garbage." Strict ISO is a strict improvement.
- **Pre-merge checks (when implementing):**
  - `grep -rE 'date:.*"[^"]*"' tests/ | grep -v -E '"\d{4}-\d{2}-\d{2}"'` — fixtures with non-ISO dates.

---

## Reconciliation items (engineering judgment, not product input)

### R-001 — users.ts `getTenantId` returns `"unknown"` instead of throwing 400

- **Source:** Slice 7 users.ts header block (NO BEHAVIOR CHANGES section flagged this as out of scope).
- **Status:** `Open`. **Owner:** engineering / security.
- **Current behavior:** `users.ts:getTenantId()` returns `"unknown"` when the `X-Tenant-ID` header is missing. The handlers then run queries like `WHERE tenant_id = 'unknown'`, which return no rows, which surface to the caller as 404 / empty results. `commercial.ts:getTenantId()` throws (400) on the same condition. Two helpers with the same name, the same job, and different failure modes.
- **Proposed change:** Reconcile users.ts to match commercial.ts:
  ```ts
  function getTenantId(req: Request): string {
    const id = req.headers["x-tenant-id"] as string | undefined;
    if (!id) throw Object.assign(new Error("X-Tenant-ID header is required"), { status: 400 });
    return id;
  }
  ```
- **Behavior change:** Requests to any users.ts endpoint without `X-Tenant-ID` → currently empty / 404 / partial response, would 400.
- **Affected:**
  - Test fixtures that don't set the header (probably many — silent-empty makes "negative path" tests easy to write).
  - Any production caller that's been getting empty responses and treating them as "no data" rather than "you forgot a header."
  - The latent-dangerous edge case where a row with `tenant_id = 'unknown'` ever gets inserted (whether by bug, by import, by test residue) — all header-less requests would suddenly see that row. The "fix" closes this exposure.
- **Engineering question:** This is *security-relevant*. The current behavior is silently dangerous; the fix is loud and correct. The blocker is test-impact: a `grep -r "X-Tenant-ID" tests/` will show many tests that explicitly set the header, but a `grep -r "supertest.*users" tests/` minus the prior will likely show some that don't. Each needs to be audited.
- **Suggested rollout:** **Soft-warn** for one release. Log when `getTenantId` would have thrown but returned `"unknown"`. If production logs are clean after a release, hard cutover. If not, audit each fired callsite.
- **Pre-merge checks (when implementing):**
  - `grep -rl "createUsersRouter\|/api/v1/users" tests/` and audit each for header presence.
  - `SELECT COUNT(*), table_name FROM information_schema.columns WHERE column_name = 'tenant_id' AND ... WHERE tenant_id = 'unknown'` (per relevant table) — confirm no existing "unknown" rows.

---

### R-002 — regulatoryIngest.ts POST /onboard + PATCH /:code body validation

- **Source:** Slice 7 conversation; option A explicitly chosen, defers full schema coverage on these two routes.
- **Status:** `Blocked` (on contract-shape migration plan).
- **Current behavior:** Both routes return errors in the legacy `{ error: "VALIDATION_FAILED", message: "...", details: ["...", ...] }` shape via `validateFrameworkPayload`. Slice 7 did NOT apply the proposed schemas because doing so would silently flip the response shape to the standard `AppError` form.
- **Proposed change:** Apply `OnboardBody` + `PatchFrameworkBody` schemas from enumeration doc § Appendix A. The schemas themselves are written and ready.
- **Behavior change:** Error responses on these two endpoints change shape. Clients parsing `details[0]` for UI messages break.
- **Affected:**
  - Unknown — that's the blocker. The slice 7 option-A decision was made because *we don't know* which external consumers parse the error shape.
- **Engineering question:** This is the inverse of R-001 — there, the current behavior is loud-but-silent-bug, and the fix is correctly noisy. Here, the current behavior is correct-but-bespoke, and the fix is correct-but-different. The "right" shape is the standardized `AppError` everywhere; the price is a coordinated migration.
- **Suggested rollout:** **Coordinated.** The path to shipping this:
  1. Audit known external consumers (SDK, dashboard, partner integrations) for code that parses the legacy `details: [...]` array.
  2. If any exist, ship an SDK / dashboard update that handles both shapes (parse `details` if present, else parse `issues`).
  3. After the consumer release ships and a deprecation window passes, flip the server side and apply the schemas here.
  4. After another release window, remove the dual-parsing code from consumers.
- **Pre-merge checks (when implementing):**
  - Confirm step 1 has been done (consumer audit complete).
  - Confirm step 2 has shipped (dual-parser in production for the deprecation window).
  - `grep -r "VALIDATION_FAILED\|details:" sdk/ dashboard/` — must show only the dual-parser callsites.

---

### R-003 — auth.ts POST /refresh — tighten `refresh_token` to hex regex

- **Source:** Slice 7 auth.ts `RefreshBody` schema comment; slice 7 commentary explicitly left this loose.
- **Status:** `Open`. **Owner:** security.
- **Current behavior:** `refresh_token: z.string().min(1)`. The token is then SHA-256 hashed and looked up; bad inputs produce a 401 via the DB miss path.
- **Proposed change:**
  ```ts
  refresh_token: z.string().regex(/^[a-f0-9]{128}$/),
  ```
- **Behavior change:** Malformed refresh tokens → currently 401 (after hashing and DB lookup), would 400 (before hashing).
- **Affected:**
  - Test fixtures using fake-but-non-hex refresh tokens.
  - The HASH-and-DB-lookup performance path for malformed input — currently we waste a SHA-256 + a prepared statement on garbage.
  - **Security note:** the 401 → 400 shift is debatable. 401 is "your credentials are wrong"; 400 is "your request shape is wrong." A token enumeration attacker can distinguish "well-formed but wrong" (still 401) from "malformed" (now 400) — slight information leak. *This is the reason slice 7 left it loose.*
- **Engineering question:** *Does the defense-in-depth value of rejecting malformed tokens at the schema boundary outweigh the information-leak from the 400 vs 401 distinction?* Reasonable arguments both ways. My read: the leak is negligible (attackers learn that `issueTokenPair` emits 128-char hex, which they can see by issuing a token themselves), and the perf win is real but small. Leaning toward "yes, tighten" but flagging it as security's call.
- **Suggested rollout:** **Drop-in.** Schema change is mechanical. No client-visible contract for the response shape (both 400 and 401 are "your token didn't work").
- **Pre-merge checks (when implementing):**
  - `grep -r "refresh_token:" tests/` — fixtures using non-hex tokens.

---

### R-004 — insurance.ts `coverage_ends_at` lenience

- **Source:** Slice 7 insurance.ts `BindPolicyBody` schema comment; flagged as "HIGHEST-RISK ITEM IN THIS FILE."
- **Status:** `Open`. **Owner:** engineering.
- **Current behavior:** `coverage_ends_at: z.string().datetime().optional()` — enforces full RFC 3339. Slice 7 went with strict; the doc explicitly flagged this would 400 any fixture using `YYYY-MM-DD` date-only form.
- **Proposed change:** *If* fixtures or callers use date-only form, replace with:
  ```ts
  coverage_ends_at: z.string().refine(s => !isNaN(Date.parse(s)), {
    message: "must be a parseable date or datetime string",
  }).optional(),
  ```
- **Behavior change:** This is a *contingent* item — it's only a change if the strict form is currently breaking something. If slice 7 shipped clean, nothing to do.
- **Verification needed:** Did slice 7 pass tests with `coverage_ends_at` strict? If yes, this item is a no-op (close as "no change needed"). If no, this is the loosening path.
- **Suggested rollout:** N/A until verification completes.
- **Pre-merge checks:** Already covered by slice 7's pre-merge checklist for insurance.ts.

---

### R-005 — pilot-ingest.ts `since` lenience (same shape as R-004)

- **Source:** Slice 7 pilot-ingest.ts `ListDecisionsQuery` schema comment.
- **Status:** `Open`. **Owner:** engineering.
- **Current behavior:** `since: z.string().datetime().optional()`. Same RFC 3339 strictness as R-004.
- **Proposed change:** Identical pattern to R-004 if needed.
- **Verification needed:** Same as R-004. Tied to that item — if R-004 needs loosening, this almost certainly does too (consistent posture).
- **Suggested rollout:** Decide jointly with R-004.

---

### R-006 — commercial.ts `invoice_currency` length-3 consistency

- **Source:** Slice 7 commercial.ts `GenerateInvoiceBody` and `CreateSubscriptionBody` schema comments; users.ts `UpsertProfileBody` and `RegisterFreelancerBody` schema comments.
- **Status:** `Open`. **Owner:** engineering, ideally with a product nudge.
- **Current behavior:** Four schemas across two files enforce `z.string().length(3)` on currency codes (ISO 4217). Two schemas enforce `z.string().length(2)` on country codes (ISO 3166-1 alpha-2).
- **Reconciliation question:** *Will the platform ever accept non-3-char currency codes?* Stablecoin codes (`USDC`, `USDT`) are 4 chars; some internal accounting flows use them. If yes, all four schemas need coordinated loosening to `z.string().min(1)` plus an inline enum/whitelist if a closed set exists.
- **Engineering question:** Single source of truth — should there be a shared `CurrencyCode` schema in `src/lib/schemas/` that all four files import? Slice 7 deliberately did NOT factor this out (each file kept its own literal). Reconciling now would let a future change happen in one place.
- **Suggested rollout:**
  - If product confirms 3-char-only — close as "consistent and correct, no change."
  - If product confirms broader support — factor into a shared schema, then loosen.
- **Pre-merge checks (when implementing):** Audit every place that writes to a `*_currency` column; ensure downstream consumers (FX engine, ledger printer) handle the broader set.

---

## Verification items (5-minute checks)

### V-001 to V-005 — IDs assumed UUID; verify against migrations

The slice 7 enumeration doc Appendix C lists these UUID assumptions. Each is a one-minute check against the relevant migration file:

| ID | File | Field | Assumed | Verify |
|---|---|---|---|---|
| V-001 | commercial.ts | `commercial_billing_ledgers.id` (InvoiceParams) | UUID | migration for commercial_billing_ledgers |
| V-002 | commercial.ts | `commercial_billing_ledgers.id` (ApplyTokenBody.ledger_id) | UUID | same as V-001 |
| V-003 | commercial.ts | `premium_reduction_tokens.id` (ApplyTokenBody.token_id) | UUID | migration for premium_reduction_tokens |
| V-004 | commercial.ts | `insurance_underwriting_registry.id` (UnderwritingAuditBody.registry_id) | UUID | migration for insurance_underwriting_registry |
| V-005 | insurance.ts | `ai_insurance_warranties.id` (PolicyParams) | UUID | migration for ai_insurance_warranties |
| V-006 | insurance.ts | `accounts.id` (BindPolicyBody.account_id) | UUID | migration for accounts |
| V-007 | pov-billing.ts | `accounts.id` (StatementParams.accountId) | UUID | same as V-006 |
| V-008 | provisioning.ts | `accounts.id` (AccountParams) | UUID | same as V-006 |
| V-009 | users.ts | `users.id` (UserParams.userId) | UUID | migration for users |

**Process:**
- Check each migration for the column type. If `TEXT`, `VARCHAR(36)`, or has a UUID CHECK constraint → confirmed, status Shipped/verified.
- If different (numeric, ULID, custom format) → file follows as a new item (e.g. `R-007`) to loosen the schema.

**Owner:** any engineer with five minutes and access to `migrations/`.

---

## § Shipped

Items that started in this tracker and have landed in master.

### S-001 — users.ts FreelancerRegistration vestigial body fields (DROPPED)

- **Originally:** Appendix C "drop unused user_id/tenant_id body fields."
- **Disposition:** Shipped in two parts.
  - Slice 7 (schema side): `RegisterFreelancerBody` omits the fields; `.strict()` rejects them at runtime.
  - Slice 7.5 (interface side): `FreelancerRegistration` TypeScript interface dropped the fields, surfacing breakage at compile time instead of runtime.
- **Behavior:** Callers sending `user_id` or `tenant_id` in the body get 400; TypeScript callers constructing the literal get a compile error.

### S-002 — commercial.ts coverage_type enum tightening (CoverageType)

- **Originally:** Appendix C "must resolve during implementation" — couldn't resolve in slice 7 without commercialEngine.ts.
- **Disposition:** Shipped in slice 7.5. Tightened `coverage_type` from `z.string().min(1)` to `z.enum([...])` with the literal 6-value CoverageType union. Also corrected a separate slice 7 bug (LedgerStatus enum was missing values and had `"void"` instead of `"voided"`).
- **Behavior:** Unknown `coverage_type` → 400 at schema boundary; previously accepted as arbitrary string (engine doesn't validate at runtime).

### S-003 — auth.ts dead Database default import

- **Originally:** Noted in slice 7 auth.ts pre-merge commentary as a pre-existing dead import out of slice 7 scope.
- **Disposition:** Shipped post-slice-7 as a lint-grade one-line cleanup.
- **Behavior:** None — pure dead-code removal.

---

## Process notes

- **When to open a new item.** Any time a slice file's header comments reference a future tightening, a deferred decision, or an inconsistency with another file → add a tracker entry. The slice file headers and this tracker should always be in sync.
- **When to close an item.** When merged: move to § Shipped with a one-paragraph disposition note. When decided against: move to § Shipped with `Won't Fix` and the reasoning.
- **When to rewrite an item.** If new information (schema migration, consumer audit, product decision) materially changes the proposed change or the rollout posture, edit in place. Don't open a parallel item.
- **What this doc does NOT track.** New features, schema additions for new endpoints, refactors unrelated to slice 7's validation-layer scope. Those belong in normal planning channels.
### H-007 — User & Tenant Management — required module, not yet built

- **Source:** Slice 7 hardening session 2026-05-21 (post-deploy retrospective); DEPLOYMENT.md § "What this deployment story does NOT cover."
- **Status:** `Open`. **Owner:** `?` (needs product + security; engineering cannot scope alone).
- **Current behavior:** There is no admin surface for managing the users and tenants that the rest of the platform assumes exist. Specifically:
  - **Bootstrap (first Executive)** requires direct DB access via `fly ssh console` + `sqlite3` — no UI for it, by design (see DEPLOYMENT.md § Bootstrap the first user).
  - **Subsequent user creation by an Executive** requires hitting the API endpoint directly (`POST /users` or equivalent). The admin-side UI for this either doesn't exist or isn't wired to a route an Executive would discover.
  - **Self-registration** via `/register` works end-to-end but has unclear security posture — no documented rate limit, no email verification posture, no per-tenant scoping rule, no captcha. Acceptable for a closed alpha; not acceptable for any public launch.
  - **Tenant management** does not exist as a concept in the UI. Tenants are implicit strings (`tenant-aitw-001`) created by being typed into an INSERT. No provisioning flow, no rename, no archive, no list, no governance.
  - **User lifecycle operations** — listing, editing, deactivation, role-change, password-reset — none are visible in the UI. The DB supports all of them; the API may support some; nothing surfaces to an admin.
  - **Audit log of user actions** is captured in the DB (table `role_audit_log` and related) but there is no UI to read it. The most security-sensitive trail in the system is write-only from an operator's perspective.
- **Proposed change:** This is not a schema tightening; it's a module to build. The shape, at minimum:
  - An admin UI accessible to `Executive` / `client_super_admin` users with: user list, user detail (view + edit), user create, user deactivate, role-change with reason capture, password-reset flow, tenant list, tenant detail, tenant create / archive, audit-log reader with filters by actor, target, action, time range.
  - A documented self-registration policy: one of {disabled, invite-token only, email-verified open within tenant, fully open}. The current implicit "fully open" is not a chosen posture, it's a default.
  - Server-side endpoints for any of the above that don't already exist, with the slice-7-style schema discipline (zod + `.strict()` + audit-log writes).
- **Behavior change:** Net-additive. Existing API surface remains; this adds the admin UI on top and locks down `/register` per the chosen posture. The one breaking change is whatever the self-registration decision turns out to be — if anything tighter than "fully open" is chosen, existing self-registrations using the loose path break.
- **Affected:**
  - **Production operators** — currently doing first-user bootstrap by hand per the DEPLOYMENT.md recipe. They get a real flow.
  - **Every Executive user** — gains an admin surface they don't currently have.
  - **Self-registered users** — affected by whatever the security-posture decision is. If the decision is "disable self-registration entirely," the `/register` route gets removed and any in-flight signups break.
  - **Audit / compliance review** — the role_audit_log becomes readable, which is the precondition for any real compliance posture.
- **Product question:** This is the largest open product question in the tracker. It decomposes:
  - *What is the self-registration security posture?* Disabled / invite-token / email-verified-within-tenant / fully open. This must be answered before any public launch and probably before the UI is built (the UI design depends on the answer).
  - *Who provisions tenants?* Self-service via the same Executive UI, or platform-operator-only via direct DB / a separate ops tool, or some hybrid (an Executive can request a new tenant, an ops admin approves)?
  - *What is the role model for the admin UI?* The current roles are `Executive` and the permission level `client_super_admin`. Is there a `tenant_admin` below Executive who can manage their own tenant's users but not others? If so, the UI needs row-level visibility filters.
  - *Is password reset email-driven or token-driven or operator-driven?* Each has different infrastructure prerequisites (SMTP / queue / nothing).
- **Suggested rollout:** **Coordinated**, and almost certainly multi-slice. A sensible decomposition:
  1. **Decide self-registration posture** (product + security, no code). Block public launch on this.
  2. **Enforce the decision in the existing `/register` route** (rate limit, captcha, or removal). Drop-in if decision is "disable" or "tighten." Coordinated if decision is "email-verified" (needs SMTP infra first).
  3. **Build read-only admin surfaces first** — user list, audit log reader. These have no risk and give operators something useful immediately.
  4. **Build write surfaces** — user create / edit / deactivate, role change with reason — with the slice-7 schema discipline.
  5. **Build tenant management** — provisioning, rename, archive. Coordinated with whatever the tenant-provisioning answer is.
- **Pre-merge checks (when implementing):**
  - For each new endpoint: schema + `.strict()` + audit-log write + handler test + fixture audit. Same checklist slice 7 used.
  - For the self-registration tightening: `grep -r "POST /register\|/api/v1/register" tests/ sdk/ dashboard/` to find every caller before changing the contract.
  - For the audit-log reader: confirm pagination + indexing on `role_audit_log` (and related tables) before exposing — a naive `SELECT *` on a year of audit rows from the UI is a self-DoS.
  - Before merging the first admin-UI route: document the role gate in one place so subsequent routes copy from a single source of truth, not by lifting from neighbors.
