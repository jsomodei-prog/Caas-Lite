# Slice 6g — Security Review Pass

**Scope.** Systematic review of all route handlers for the five categories
flagged in the original handoff: secrets in error messages, SQL injection,
unhandled promise rejections, type coercions, and missing `req.body` checks.
Plus three additional categories surfaced during this review.

**Coverage.** 9 route files reviewed via slice 5 grep + targeted handler reads:
`auth.ts`, `commercial.ts`, `admin.ts`, `pilot-ingest.ts`, `insurance.ts`,
`regulatoryIngest.ts`, `risk-pricing.ts`, `provisioning.ts`, `users.ts`.
Plus `src/services/commercialEngine.ts` (1257 lines, reviewed slice 6e).

**Methodology.** Same pattern as slice 5: enumerate concern → grep → manual
review of matches → classify each finding as CRITICAL / HIGH / MEDIUM / LOW
or JUSTIFIED.

**Bottom line:** **two findings classified as CRITICAL** and need fixes
before the next deploy. Multiple HIGH findings worth fixing in a follow-up
sprint. The codebase is in good shape relative to its complexity — no SQLi,
no unhandled rejections, no `eval`. The CRITICAL items are gaps in
multi-tenant authorization, not classic web-app vulnerabilities.

---

## CRITICAL FINDINGS — fix before next deploy

### 6g.CRIT-1 — Cross-tenant resource manipulation in `insurance.ts`

**Routes affected:**
- `POST /policies` (`bindPolicy`)
- `POST /policies/:id/recompute` (`recomputePolicy`)
- `PATCH /policies/:id/external` (`attachExternal`)

**The bug.** Each handler accepts an `account_id` (in body) or `:id`
(path param) and operates on it without verifying that the resource
belongs to the caller's tenant.

`bindPolicy` example (lines 197–227 of `insurance.ts`):

```ts
const account = db
  .prepare("SELECT id, tenant_id FROM accounts WHERE id = ?")
  .get(account_id);
if (!account) { res.status(404).json({ error: "Account not found" }); return; }
// no check that account.tenant_id === caller's tenant_id
db.prepare(`INSERT INTO ai_insurance_warranties (...) VALUES (...)`)
  .run(id, account.tenant_id, account.id, ...);  // uses ACCOUNT's tenant_id, not caller's
commercialAuditLog(db, account.tenant_id, actorId, id, "bind", ...);
```

**Attack scenario.** A logged-in user from tenant A enumerates account IDs
(possibly via a leak elsewhere, or guessing — UUIDs are hard to guess,
but the bar shouldn't be "hard to guess"). They call
`POST /api/v1/insurance/policies` with another tenant's `account_id`.
The handler:

1. Looks up the account, finds it belongs to tenant B.
2. Creates a warranty policy on tenant B's account, scoped to tenant B.
3. Writes an audit row attributing the action to tenant A's user but
   on tenant B's policy.

The cross-tenant audit trail (`actor_user_id` in tenant A, `tenant_id` in
tenant B) is the only trace; it's correct as a forensic record but does
NOT prevent the action.

Even if the policy creation itself doesn't damage tenant B's data
(it just adds an ACTIVE warranty entry, which may already exist),
`attachExternal` is worse: it overwrites the external carrier ID and
policy number on tenant B's existing warranty record. That IS data
corruption visible to tenant B.

**Fix.** Three call sites. Pattern:

```ts
// bindPolicy: after fetching account
const callerTenantId = getTenantId(req);
if (account.tenant_id !== callerTenantId) {
  // Return 404 not 403 — don't confirm the account exists in another tenant.
  res.status(404).json({ error: "Account not found" });
  return;
}

// recomputePolicy & attachExternal: after fetching warranty
const callerTenantId = getTenantId(req);
if (warranty.tenant_id !== callerTenantId) {
  res.status(404).json({ error: "Policy not found" });
  return;
}
```

The 404 (not 403) is deliberate — confirming the resource exists in
another tenant leaks information.

**Note for super-admin operations.** If a `global_super_admin` legitimately
needs to bind policies across tenants, gate the cross-tenant check on role:

```ts
const isSuperAdmin = req.user?.role === "global_super_admin";
if (!isSuperAdmin && warranty.tenant_id !== callerTenantId) {
  res.status(404).json({ error: "Policy not found" });
  return;
}
```

This route currently has only `requireAccessToken` (any logged-in user),
which suggests the original intent was tenant-scoped. Adding the
super-admin escape hatch is a separate product decision.

**Severity rationale.** This is the difference between a "trust the auth
layer" multi-tenant system and one that actually enforces tenant
boundaries at the data layer. The auth layer correctly identifies WHO
the caller is; the handler then ignores WHICH tenant the resource belongs
to. That's exactly the gap that turns "your CRM has 1000 tenants" into
"any customer can read or write any other customer's data."

### 6g.CRIT-2 — `dev_hmac_secret` fallback in production paths

**Locations:**
- `src/routes/commercial.ts` line 98 (invoice signature)
- `src/routes/commercial.ts` line 237 (token signature)
- `src/services/commercialEngine.ts` line 281 (engine-wide secret)

**The bug.** All three modules contain:

```ts
const HMAC_SECRET = process.env.PAYOUT_HMAC_SECRET ?? "dev_hmac_secret";
```

If production starts without `PAYOUT_HMAC_SECRET` set (because of a
deployment misconfiguration, a missing env var in a new region, a
forgotten secret rotation step), every HMAC signature produced is
computed with the literal string `"dev_hmac_secret"`. Anyone with source
code access (the dev team, contractors, anyone who's seen the repo,
attackers if the repo leaks) knows this string and can forge:

- Invoice signatures (line 98)
- Token signatures (line 237)
- The entire commercial engine's tamper-evidence chain — the
  `chained_hash` on `underwriting_audit_snapshots`, the signatures on
  `commercial_billing_ledgers`, etc.

The signatures are the only thing preventing forged commercial records
from being accepted as authentic. With a known fallback, that protection
is contingent on an environment variable being set.

**Fix.** Boot-time guard:

```ts
// At module load, BEFORE any signing operation
function loadHmacSecret(): string {
  const secret = process.env.PAYOUT_HMAC_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "PAYOUT_HMAC_SECRET must be set in production. " +
      "Refusing to start with development fallback."
    );
  }
  // Dev/test only
  return "dev_hmac_secret";
}
const HMAC_SECRET = loadHmacSecret();
```

This preserves dev ergonomics (you can still `npm test` without env vars)
and makes production fail-fast on missing config instead of fail-quiet
on weak signatures.

**Even better:** route this through the `secret_state` table created by
migration v27 (slice 6e identified this migration). The boot sequence
reads the active secret from `secret_state`; if the table is empty in
production, refuse to start. No code-level fallback exists. This is the
proper end-state but requires coordinating with whoever designed
`secret_state`'s contract.

**Severity rationale.** A signing secret with a known fallback string is
not a signing secret. The HMAC mechanism is theatre if it can be bypassed
by configuration. This is the kind of finding that turns a 4-week
"we proved tamper-evidence" demo into a 4-hour incident response.

---

## HIGH FINDINGS — fix in next sprint

### 6g.HIGH-1 — Tenant-scoped UPDATEs that rely on prior SELECT

**Locations:**
- `users.ts:283` — `UPDATE users SET role = ? ... WHERE id = ?` (no tenant_id)
- `provisioning.ts:176` — `UPDATE accounts SET tier = ? ... WHERE id = ?`
  (super-admin route — JUSTIFIED — see below)
- `provisioning.ts rotateApiKey` — same shape
- `insurance.ts attachExternal UPDATE` — same shape

**The pattern.** The handler does a SELECT with `WHERE id = ? AND tenant_id = ?`
and confirms the resource exists in the caller's tenant. Then does an UPDATE
with only `WHERE id = ?`. The UPDATE is safe **today** because of the SELECT,
but the safety is implicit, not enforced by the query.

**Why HIGH and not CRITICAL.** Today these aren't exploitable — the SELECT
gates entry. The risk is that a future refactor moves the SELECT out, or
changes the variable name, or merges the handler with another that doesn't
pre-check. The UPDATE then becomes a cross-tenant write.

**Fix.** Defense in depth — add `AND tenant_id = ?` to every UPDATE that
operates on tenant-scoped tables. Pattern:

```ts
// BEFORE
db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ?")
  .run(role, now, userId);

// AFTER
db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
  .run(role, now, userId, tenantId);
```

The cost is one extra parameter per UPDATE. The benefit is that the SQL
itself enforces the boundary; the SELECT becomes a "is this user authorized
to act" check, not a "does the row exist" prerequisite for safety.

**Provisioning routes (`changeTier`, `rotateApiKey`) — JUSTIFIED**. These
are gated by `requireBusinessPlane(["global_super_admin"])`. The super-admin
operates across tenants by design; cross-tenant UPDATEs from this role are
intended, not bugs. Still worth adding `tenant_id` to the UPDATEs as defense
in depth, but classified JUSTIFIED at the HIGH level.

### 6g.HIGH-2 — `validate()` middleware not propagated to sub-routers

**Affected routers:** `auth.ts`, `commercial.ts`, `admin.ts`, `pilot-ingest.ts`,
`insurance.ts`, `regulatoryIngest.ts`, `risk-pricing.ts`, `provisioning.ts`,
`users.ts` — **all of them**.

**The finding.** Slice 2 added Zod `validate({ body: schema })` middleware
to routes mounted directly in `app.ts`. Inspection of every sub-router's
`router.post(...)` declarations shows **not a single one uses `validate()`**.
Every `req.body` destructure across these handlers happens without
schema-level validation.

Each handler does some ad-hoc validation (`if (!field) ...`, allowlist
arrays, regex tests). Some are thorough; some are minimal. The result is:

- Inconsistent validation across handlers
- Same field validated with different rules in different routes
- The Zod schema work from slice 2 is half-applied

**Fix.** This is a substantial follow-up — every route in every sub-router
needs a Zod schema and a `validate()` middleware. Slice 2's pattern is
exactly the right template; it just wasn't applied to the sub-routers.

Recommend scoping this as **Slice 7** rather than a quick fix in slice 6.
It's bounded (every route already exists; just adding schemas) but it's
~25 routes worth of schema definitions and middleware wiring. Doing it
in one pass with a CI guard (like slice 5's audit-coverage test, but for
"every mutation route has a validate() in its middleware chain") would be
the right shape.

**Why HIGH and not CRITICAL.** The handlers DO validate, just not via a
declarative schema. The risks of ad-hoc validation are real
(inconsistency, missed edge cases, no schema documentation) but no
specific exploit is confirmed. Different from CRIT-1 which has a concrete
attack scenario.

### 6g.HIGH-3 — `parseFloat(...) || 1.0` swallows legitimate zero

**Location:** `commercial.ts:196`:

```ts
const fxRate = parseFloat(req.body.fx_rate ?? "1.0") || 1.0;
```

If a caller legitimately passes `fx_rate: 0`, the `|| 1.0` replaces it
with 1.0. Same for any other falsy numeric value (which is just 0 in
practice).

For FX rates, `0` makes no economic sense — but the pattern is a footgun
that will bite a similar coercion somewhere else. The fix is to use `??`
which only replaces null/undefined:

```ts
const raw = req.body.fx_rate;
const fxRate = raw == null ? 1.0 : parseFloat(raw);
if (Number.isNaN(fxRate) || fxRate <= 0) {
  res.status(400).json({ error: "fx_rate must be a positive number" });
  return;
}
```

That correctly handles missing, malformed, and out-of-range values.

---

## MEDIUM FINDINGS — fix when convenient

### 6g.MED-1 — Error message leakage in `users.ts`

**Locations:** `users.ts:215, 344`:

```ts
res.status(422).json({ error: err instanceof Error ? err.message : "Invalid country code" });
```

The thrown error's `.message` is propagated to the client. For
`getCountryRequirement` failures, the message is benign ("Country code 'XX'
not supported"). But this pattern is brittle — if `getCountryRequirement`
ever throws something internal (a DB error, a config-load failure), that
error message could expose internals.

**Fix.** Catch by error type, map known errors to user-facing messages,
let everything else become a generic 500:

```ts
try {
  const countryReq = getCountryRequirement(country_code);
  // ...
} catch (err) {
  if (err instanceof UnsupportedCountryError) {
    res.status(422).json({ error: err.message });
    return;
  }
  throw err;  // propagate to error-handler middleware, becomes generic 500
}
```

Requires defining `UnsupportedCountryError` in `countryRequirements.ts`.
The AppError factory pattern from slice 2 is ideal here.

### 6g.MED-2 — Missing `validate()` body checks downstream of pre-checks

This is a subset of HIGH-2 but worth calling out: several handlers
assume the body has fields it might not. Example from `commercial.ts:508`:

```ts
const { ledger_id, token_id } = req.body;
// then immediately:
const result = engine.applyPremiumReductionToken(ledger_id, token_id);
```

If `ledger_id` is missing from the body, this passes `undefined` to
the engine, which then SELECTs from `commercial_billing_ledgers WHERE id = undefined`.
SQLite handles that as a literal NULL comparison — no rows match, returns null
— and the engine throws "Ledger not found." The user sees a 500 (or whatever
the engine error handler turns it into) for what should be a 400.

**Fix.** Same as HIGH-2 — Zod schemas at the middleware layer.

---

## LOW / JUSTIFIED FINDINGS

### 6g.LOW-1 — `parseInt` calls use `|| FALLBACK`

Same `||` vs `??` issue as HIGH-3, but for `limit` and `offset` query
params where 0 is rarely legitimate. The capping with `Math.min(...)`
also serves as a guard. Worth fixing for consistency, but not a real
exploit surface.

### 6g.LOW-2 — `validate()` was added to `app.ts`-mounted routes only

Slice 2 covered routes mounted directly in `app.ts`. The sub-routers
weren't in scope. This is documented in slice 2's notes; raising again
in slice 6g as part of the comprehensive review for completeness.
See HIGH-2 for the proposed fix path.

### 6g.JUST-1 — No SQL injection found

Every `prepare()` call across all 9 route files uses `?` placeholders.
Zero string-concatenated SQL, zero template-literal-with-interpolation
SQL. This codebase is **architecturally immune** to SQLi by virtue of
the better-sqlite3 prepared-statement API and consistent use of it.
Worth celebrating.

### 6g.JUST-2 — No unhandled promise rejections

Every async route handler is wrapped in either `async_(...)` or
`asyncHandler(...)`. No raw `async (req, res) => {...}` arrow handlers
exist. Express 5's native promise-rejection forwarding (verified via
the slice 2 removal of `express-async-errors`) handles the rest.
No `.then()` without `.catch()` anywhere.

### 6g.JUST-3 — No `eval` / `new Function`

Clean.

### 6g.JUST-4 — No `console.log(req.body)` patterns

The pino logger (slice 3) handles structured logging with redaction
configured. No accidental body-content logging via raw console calls.

---

## Prioritized fix order

1. **6g.CRIT-1** (cross-tenant resource manipulation) — three handlers in
   `insurance.ts` need a tenant check. ~30 minutes of code, can land
   in slice 6h alongside the existing pending atomicity work in slice 6a.

2. **6g.CRIT-2** (`dev_hmac_secret` fallback) — three call sites get a
   `loadHmacSecret()` helper. ~20 minutes of code. Can be the same PR
   as CRIT-1.

3. **6g.HIGH-1** (UPDATEs without tenant_id) — four sites get an extra
   parameter each. Sequenced AFTER slice 6a's atomicity fixes (since 6a
   touches the same UPDATEs).

4. **6g.HIGH-3** (`|| 1.0` swallow) — one line. Trivial.

5. **6g.HIGH-2** (`validate()` on sub-routers) — Slice 7. Separate sprint.
   Don't try to compress this into slice 6.

6. **6g.MED-1, MED-2, LOW-1, LOW-2** — convenience-level cleanups, no urgency.

---

## What this review does NOT cover

- **Authentication itself.** Whether `requireAccessToken`, `requireRole`,
  `requireBusinessPlane`, and their underlying JWT verification are
  correctly implemented. The slice 5 review took those as a given.
  Out of scope here.

- **Rate limiting and DoS protection.** Slice 4 mentioned rate-limiter
  bypass list management; the limiter's own configuration is not reviewed.

- **CORS configuration.** Slice 3's startup banner referenced CORS warnings;
  the actual policy is not reviewed.

- **Secret storage at rest.** `secret_state` migration v27 exists; whether
  secrets in that table are encrypted, how key rotation actually works,
  what happens on a rotation incident — none of that is reviewed.

- **Audit log integrity itself.** Slice 5 reviewed audit COVERAGE (which
  mutations write audit rows). Whether the audit rows themselves can be
  tampered with after write (no `chained_hash` on `commercial_audit_log`
  unlike `underwriting_audit_snapshots`) is a separate question.

Each of these is a legitimate follow-up review pass. None are urgent
unless something in this report's findings suggests an active exploit.
