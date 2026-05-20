# Audit Log Coverage Report

**Slice 5 deliverable.** Walks every mutation endpoint, classifies audit coverage,
flags gaps and structural issues. Tied to a CI guard test
(`tests/audit-coverage.test.ts`) that prevents regression on the routes
classified here.

## Method

For every mutation route (`router.post|.patch|.put|.delete`), the handler
body was read end-to-end. Classification:

- **AUDITED** — handler reaches an audit-log INSERT (`commercial_audit_log` or
  `role_audit_log`) on the success path. The insert was traced from handler
  entry; no inference from file-level presence.
- **AUDITED — ATOMICITY GAP** — audit fires on success, but the mutation and
  audit are written as separate statements with no transaction wrapping.
  A crash between them leaves a durable mutation with no audit row.
- **NOT AUDITED — JUSTIFIED** — intentional. Reason listed.
- **NOT AUDITED — GAP** — should be audited; isn't.
- **AUDIT DEFERRED** — audit happens in a service-layer helper or downstream
  scheduler, not in the route handler. Coverage exists but the route source
  alone doesn't prove it; verify in the named module.

---

## Findings by file

### `src/routes/admin.ts`

| Route | Method | Class | Notes |
|---|---|---|---|
| `/recompute-all` | POST | **AUDITED** (transitively, with caveat) | Delegates to `recomputeAllWarranties(db)` in `src/lib/recompute-scheduler.ts`. Verified in slice 6: that function iterates ACTIVE warranties and, per warranty, calls `applyStateTransition` INSIDE a `db.transaction(()=>{...})()` wrapper. `applyStateTransition` writes `commercial_audit_log` when state changes. **Caveat 1**: idempotent recomputes (no state change) leave no audit row — same pattern as `insurance.ts /policies/:id/recompute`. **Caveat 2**: the actor is recorded as `null` (system actor). Verify `commercial_audit_log.actor_user_id` is nullable; if not, every state-changing recompute throws a constraint violation. **Caveat 3**: badge state changes inside the recompute are NOT separately audited (Issue C). |

### `src/routes/auth.ts` — 5 mutations, **all NOT AUDITED**

| Route | Method | Class | Notes |
|---|---|---|---|
| `/register` | POST | **NOT AUDITED — GAP** | Creates a user row. No `role_audit_log` insert. The `users` table itself has `created_at` but no actor (a registering user IS the actor; arguably self-creation doesn't need an audit row beyond the existence of the user). Defensible to leave unaudited; flagging so the decision is explicit. |
| `/login` | POST | **NOT AUDITED — JUSTIFIED** | Login is captured by `users.last_login_at` and (on failure) by `failed_attempts` / `ip_lockouts`. The `users` and `ip_lockouts` tables ARE the audit trail for auth events. Adding `role_audit_log` rows per login would multiply log volume against no incremental investigative value. |
| `/refresh` | POST | **NOT AUDITED — JUSTIFIED** | Same as login. `refresh_tokens` table records issuance with `created_at` and `revoked` flag. Operational events visible without `role_audit_log`. |
| `/logout` | POST | **NOT AUDITED — JUSTIFIED** | Revokes a refresh token (state visible in `refresh_tokens.revoked`). No additional audit needed. |
| `/change-password` | POST | **NOT AUDITED — GAP** | This is a meaningful privileged mutation. A compromised access token used to change a password is one of the highest-impact attack paths. Currently leaves no trail except `users.updated_at`. **Action**: add `role_audit_log` write with `action='password_change'`. |

### `src/routes/commercial.ts` — 5 mutations, **engine review complete**

All five handlers delegate to `CommercialEngine` methods in
`src/services/commercialEngine.ts`. **Verified slice 6**: the engine writes
**zero** `commercial_audit_log` or `role_audit_log` rows. Instead, every
durable state change is recorded with an HMAC signature embedded in the
state row itself — a parallel tamper-evidence mechanism distinct from
`commercial_audit_log`.

This is a deliberate architectural pattern, not an oversight. The codebase
has two coexisting audit philosophies:

1. **`commercial_audit_log` (generic)** — used by `users.ts`, `provisioning.ts`,
   `insurance.ts`. Captures `actor_user_id`, `entity_id`, `action`,
   `old_value`, `new_value` per mutation.

2. **Per-table HMAC tamper-evidence (domain-specific)** — used by the
   commercial engine. The state row itself carries `signature` /
   `chained_hash` / `golden_thread_hash`. The table IS the audit trail.

Refined classifications:

| Route | Method | Engine writes | Class | Notes |
|---|---|---|---|---|
| `/invoice/generate` | POST | `commercial_billing_ledgers` (HMAC-signed) + line items + token status + subscription counters | **NOT AUDITED — JUSTIFIED** | Ledger row carries HMAC signature; invoice is its own tamper-evident record. |
| `/insurance/register` | POST | `insurance_underwriting_registry` | **NOT AUDITED — GAP** (actor attribution) | Policy registry has tamper-evidence on the state but does NOT record `actor_user_id`. Future "who registered this policy" forensics will be blind. Recommended fix: add `created_by_user_id` column to the registry, OR add a `commercial_audit_log` row at registration time. |
| `/insurance/audit` | POST | `underwriting_audit_snapshots` (HMAC chained_hash), conditionally `premium_reduction_tokens`, updates `insurance_underwriting_registry` | **NOT AUDITED — JUSTIFIED** | The golden-thread hash chain in `underwriting_audit_snapshots` is the canonical audit trail for risk-band changes. Adding `commercial_audit_log` rows would duplicate. |
| `/subscription/create` | POST | `tenant_commercial_subscriptions` (HMAC-signed) | **NOT AUDITED — JUSTIFIED** | Subscription row carries HMAC signature. Adding generic audit row would duplicate. |
| `/token/apply` | POST | Updates `commercial_billing_ledgers` (new HMAC sig), inserts line item, updates token status | **NOT AUDITED — GAP** (actor attribution) | The new ledger signature proves tamper-evidence but does NOT record who applied the token. A contested discount ("who applied this $X reduction?") leaves no actor trail. Recommended fix: add `commercial_audit_log` row at token application capturing `actor_user_id`, `ledger_id`, `token_id`, `discount_amount`. |

**Net resolution**: 3 routes are confirmed-justified, 2 routes are
**actor-attribution gaps** that need fixing in slice 6b alongside the four
existing NOT AUDITED gaps. The route IS persistent and tamper-evident; what's
missing is the link from state change to acting human.

### `src/routes/insurance.ts` — 3 mutations

| Route | Method | Class | Notes |
|---|---|---|---|
| `/policies` (bind) | POST | **AUDITED — ATOMICITY GAP** | `commercialAuditLog(...)` called AFTER `db.transaction(()=>{...})()`. Crash between txn commit and audit insert → mutation persists, no audit row. |
| `/policies/:id/recompute` | POST | **AUDITED** | Audit happens inside `applyStateTransition`, which itself runs inside the `db.transaction(()=>{...})()` wrapper. This is the only handler in the audit-writing files that gets atomicity right. However: badge state changes inside the same transaction are NOT audited separately — see "Issue C". |
| `/policies/:id/external` | PATCH | **AUDITED — ATOMICITY GAP** | `commercialAuditLog(...)` after `UPDATE` with no transaction. Same atomicity issue. |

### `src/routes/pilot-ingest.ts` — 1 mutation

| Route | Method | Class | Notes |
|---|---|---|---|
| `/decisions` | POST | **NOT AUDITED — JUSTIFIED** | High-volume SDK ingest. Every decision is a row in `pilot_decisions` with `account_id`, `tenant_id`, `ip_address`, `user_agent`, `received_at`. That table IS the audit trail for this surface. Duplicating to `commercial_audit_log` would double-write at SDK ingest rate (up to 50/request). |

### `src/routes/provisioning.ts` — 3 mutations, all atomicity-gapped

| Route | Method | Class | Notes |
|---|---|---|---|
| `/` (create account) | POST | **AUDITED — ATOMICITY GAP** | `commercialAuditLog(...)` after the `db.transaction(()=>{...})()` block. |
| `/:id/rotate-key` | POST | **AUDITED — ATOMICITY GAP** | UPDATE and audit are sequential statements, no transaction. |
| `/:id/tier` | PATCH | **AUDITED — ATOMICITY GAP** | Same. Note: early-return on `current.tier === tier` correctly skips both UPDATE and audit. |

### `src/routes/regulatoryIngest.ts` — 2 mutations, **both NOT AUDITED — GAP**

| Route | Method | Class | Notes |
|---|---|---|---|
| `/onboard` | POST | **NOT AUDITED — GAP** | Onboards a regulatory framework — three INSERTs across `regulatory_frameworks`, `regulatory_field_rules`, `regulatory_consent_purposes`. Uses `created_by_user_id` as an in-row attribution column but no `commercial_audit_log` write. This is a high-privilege mutation (gated `global_super_admin`); should leave a permanent audit trail. **Action**: add audit insert. |
| `/frameworks/:code` | PATCH | **NOT AUDITED — GAP** | Toggles `is_active` and/or merges `metadata` on a framework. Even more concerning than `/onboard`: turning off a framework with `is_active = false` silently disables compliance checks downstream. Only a `console.info` log line is written. **Action**: add audit insert with old/new `is_active` and old/new `metadata`. |

The file header comment states the auth middleware writes an access metric
per request (`role_access_metrics`). That records the access event, not the
*content* of the mutation. Access metrics ≠ audit logs.

### `src/routes/risk-pricing.ts` — 1 mutation

| Route | Method | Class | Notes |
|---|---|---|---|
| `/quote` | POST | **NOT AUDITED — JUSTIFIED** | Pure calculator. No DB writes, no state mutation. Handler header explicitly documents this. |

### `src/routes/users.ts` — 5 mutations, all atomicity-gapped but audited

| Route | Method | Class | Notes |
|---|---|---|---|
| `/:userId/profile` | POST | **AUDITED — ATOMICITY GAP** | `auditLog(...)` after the INSERT/UPDATE. No transaction wrapper. |
| `/:userId/role` | POST | **AUDITED — ATOMICITY GAP** | Same pattern. Old/new role recorded. |
| `/:userId/kyc` | POST | **AUDITED — ATOMICITY GAP** | Old/new tier recorded. |
| `/:userId/freelancer` | POST | **AUDITED — ATOMICITY GAP** | New `agent_id` recorded. |
| `/:userId/api-key` | POST | **AUDITED — ATOMICITY GAP** | New key prefix recorded (not the raw key — correct). |

The file's header claim "All write operations are logged to the role_audit_log
table" is verified — every mutation writes an audit row. The atomicity gap
is structural, not a content gap.

---

## Summary counts

Total mutation routes: **25**

- AUDITED, no concerns: **1** (`insurance.ts /policies/:id/recompute`)
- AUDITED transitively (with caveats): **1** (`admin.ts /recompute-all` — verified slice 6)
- AUDITED — ATOMICITY GAP: **10** (5 in `users.ts`, 3 in `provisioning.ts`, 2 in `insurance.ts`)
- NOT AUDITED — JUSTIFIED: **8** (3 in `auth.ts`, 1 in `pilot-ingest.ts`, 1 in `risk-pricing.ts`, 3 in `commercial.ts` — verified via HMAC tamper-evidence)
- NOT AUDITED — GAP (definite or actor-attribution): **6** (4 from slice 5, plus `commercial.ts /insurance/register` and `commercial.ts /token/apply` from slice 6 engine review)
- AUDIT DEFERRED: **0** (all resolved in slice 6)

---

## Cross-cutting issues

### Issue A — Atomicity gap in 10 of 11 audited routes (the dominant finding)

Only one audited route (`insurance.ts /policies/:id/recompute`) wraps the
mutation and audit insert in the same `db.transaction(()=>{...})()` block.
The other ten commit the mutation either as a bare `db.prepare(...).run()`
or as a transaction that closes before the audit insert. Process kill or
exception between the two writes leaves a durable mutation with no audit
row.

**Slice 6 fix pattern**: move every audit insert inside the same transaction
as the mutation it logs. Concretely, change:

```ts
db.prepare("UPDATE accounts SET tier = ? ...").run(tier, ...);
commercialAuditLog(db, ..., "tier_change", oldTier, newTier);
```

to:

```ts
db.transaction(() => {
  db.prepare("UPDATE accounts SET tier = ? ...").run(tier, ...);
  commercialAuditLog(db, ..., "tier_change", oldTier, newTier);
})();
```

For handlers already in a transaction (`provisioning.ts /` and
`insurance.ts /policies`), move the audit call inside the existing
transaction closure.

### Issue B — `commercialAuditLog` duplicated across files with diverging signatures

- `insurance.ts`: hardcodes `entity_type = 'warranty'` (5-arg signature).
- `provisioning.ts`: `entity_type` is a parameter (6-arg signature).
- `users.ts`: separate `auditLog` for `role_audit_log` (different table, different column shape).
- `badge-rotation.ts`: inline INSERT, no helper.

The three commercial-audit call sites should consolidate into a single
`src/lib/audit.ts` exporting `writeCommercialAudit(...)` and
`writeRoleAudit(...)`. Slice 6.

### Issue C — Badge state changes are never audited

`syncBadge` is called from three handlers (`insurance.ts /policies`,
`insurance.ts /policies/:id/recompute`, `provisioning.ts /`). The badge
state is externally visible — clients embed the signed badge in their UI.
A green→amber flip is a customer-facing state change.

No `commercial_audit_log` row is written for badge transitions. The
underlying event (warranty state change, policy bind) IS audited, so
there's an indirect trail. Defensible but worth making explicit. Slice 6
decision point.

### Issue D — `recomputeAllWarranties` audit behavior ✓ RESOLVED (slice 6)

**Verified.** `recomputeAllWarranties` (in `src/lib/recompute-scheduler.ts`)
iterates ACTIVE warranties and calls `applyStateTransition` inside
`db.transaction(()=>{...})()` per warranty. `applyStateTransition` writes
`commercial_audit_log` when state changes. Both the in-process timer and
the `admin.ts /recompute-all` route therefore have audit coverage for
state transitions.

Three caveats from the resolution worth noting (not blocking, but slice 6 follow-ups):

1. Idempotent recomputes (no state change) leave no audit row. Same pattern as `insurance.ts /policies/:id/recompute`.
2. The actor is `null` (system actor). **Verify `commercial_audit_log.actor_user_id` is nullable** — if it has a NOT NULL constraint, every state-changing recompute is currently throwing a constraint error in production. Critical to check before declaring this fully resolved.
3. Badge state changes during recompute are NOT separately audited (covered by Issue C — Badge state changes are never audited).

### Issue E — Table duplication: `role_audit_log` defined in two places

`role_audit_log` is created by `IF NOT EXISTS` in both `src/db/migrate-phase11.ts`
and `src/routes/users.ts` line ~62. Same schema, same indexes. Works because
of `IF NOT EXISTS`, but the duplication means a schema change to one will
silently diverge from the other. Slice 6: delete the duplicate from
`users.ts` and rely solely on the migration.

### Issue F — `migrate-phase11.ts` exists separately from `migrate.ts`

Discovered during this review. The main `MIGRATIONS` array in `src/db/migrate.ts`
is the source `getPendingMigrations` reads. If `migrate-phase11.ts` runs a
parallel migration mechanism, `/readyz` from slice 4 may report "ready"
while phase11 migrations are pending. **Action**: trace how `migrate-phase11.ts`
is invoked. If it's separate, either fold its migrations into the main
array or extend `getPendingMigrations` to cover it.

---

## CI guard test

`tests/audit-coverage.test.ts` enforces this report as a permanent regression
guard. It:

1. Enumerates every mutation route across `src/routes/`.
2. For each, checks whether the handler scope contains an audit-log INSERT
   (or a call to a known audit helper).
3. Asserts each route is either audited OR appears on an explicit allowlist
   with a reason.
4. Asserts allowlist entries reference real routes (catches stale entries
   when routes are renamed or removed).

The allowlist is populated from the JUSTIFIED entries above. **The test
does NOT catch atomicity gaps (Issue A)** — that requires static analysis
beyond regex.

To add a new mutation route: PR must either include an audit insert in
the handler OR an allowlist entry plus a doc update here.

---

## Pending verification

Required to close findings:

1. ~~**`src/lib/recompute-scheduler.ts`** — resolve Issue D~~ ✓ **Verified slice 6**.
2. ~~**`src/services/commercialEngine.ts`** — verify the 5 deferred routes~~ ✓ **Verified slice 6**: engine writes zero `commercial_audit_log` rows, relies on per-table HMAC tamper-evidence. 3 routes JUSTIFIED, 2 routes have actor-attribution gaps (`/insurance/register`, `/token/apply`).
3. **`src/db/migrate.ts` — `commercial_audit_log.actor_user_id` nullability.** Not yet verified. If `NOT NULL`, `recomputeAllWarranties` is silently failing on every state-changing recompute. **Run**: `Select-String -Path src/db/migrate.ts -Pattern "commercial_audit_log" -Context 0,15`.
