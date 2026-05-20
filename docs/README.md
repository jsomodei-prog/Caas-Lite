# Phase 15 Hardening Sprint — Final Consolidated Drop

This folder contains every shippable artifact from the multi-slice hardening
sprint covering slices 2 through 6g. The work below brings the codebase
from "feature-complete Phase 15" to "production-hardened against the
specific concerns flagged in the original handoff."

**Test baseline at the end of this drop:** 127/127 green, with the new
`audit-coverage.test.ts` self-checking CI guard preventing audit regressions.

## What's inside

```
.gitattributes                              ← drop at repo root
docs/
  audit-coverage.md                         ← slice 5+6e: audit gap analysis
  migration-rollback.md                     ← slice 4: ops runbook
  slice6a-atomicity-fixes.md                ← patch instructions, 10 edits
  slice6d-changes.md                        ← patch instructions for migrate.ts/users.ts
  slice6d-migration-cleanup.md              ← analysis: why migrate-phase11.ts is dead
  slice6f-cleanup.md                        ← tax-receipt + test-secret follow-ups
  slice6g-security-review.md                ← security audit pass — READ FIRST
src/
  db/
    migrations/
      phase11_users_audit.ts                ← drop in; new migration v28
tests/
  audit-coverage.test.ts                    ← replace existing
```

## Apply order

The order below is designed so each step leaves you at green tests. Don't
skip ahead — each step assumes the previous ones landed.

### Step 0 — Read first

**`docs/slice6g-security-review.md`**. It contains two CRITICAL findings
(cross-tenant resource manipulation in `insurance.ts` and the
`dev_hmac_secret` fallback). Decide whether to act on them before deploy
or schedule them as their own follow-up. Everything else in this drop is
hardening on top of a working system; those two are gaps that should be
closed before declaring "production-hardened."

### Step 1 — Test fix (already applied per session)

The `tests/audit-coverage.test.ts` in this drop is the post-test-fix version.
If you already replaced it during the session and got 127/127, no action
needed. Otherwise: drop it in and run `npm test`. Expect 127/127.

### Step 2 — Slice 6f cleanup (no source uploads needed)

a. Drop `.gitattributes` at the repo root.

   ```bash
   git add .gitattributes
   git add --renormalize .
   git commit -m "chore: normalize line endings via .gitattributes"
   ```

b. **Read `docs/slice6f-cleanup.md`** for the tax-receipt patch instructions.
   These need to be applied by hand to your tax-receipt source file (not
   uploaded during this session). The four sub-fixes are small but require
   judgment calls (especially 6f.2b on regulator field handling). Tests
   may need updating; cover with new unit tests after each fix.

c. **Test-secrets cleanup is deferred** — flagged in the doc for when CI
   secrets manager lands.

d. **Real calibration fitter is deferred** — needs actuary and real data.
   The placeholder warning banner stays in place as the contract.

After Step 2: `npm test` still 127/127. Tax-receipt fixes may require
test updates; align as you apply each fix.

### Step 3 — Slice 6d migration cleanup

The new file is ready to drop in. The two edits to existing files are
patch instructions you'll apply by hand.

a. Drop `src/db/migrations/phase11_users_audit.ts` into your repo.

b. **Read `docs/slice6d-changes.md`**. Apply the three remaining edits:
   - Edit `src/db/migrate.ts` — add 1 import, add 1 spread to MIGRATIONS array.
   - Edit `src/routes/users.ts` — delete `ensureUserProfileTable` function +
     its single call site at `upsertProfile`.
   - `git rm src/db/migrate-phase11.ts`.

c. Verify also delete:
   ```powershell
   Test-Path scripts/migrate-phase11.ts
   Select-String -Path package.json -Pattern "migrate-phase11"
   ```
   If either has hits, remove them in the same commit.

d. Run `npm test`. Expect 127/127, with one new migration line in the test
   logs: `[migrate] ✓ 028 Phase 11 — promote user_profiles + role_audit_log
   from inline DDL to migrations`.

### Step 4 — Slice 6a atomicity fixes

10 mechanical edits across 3 files. Patch instructions in
`docs/slice6a-atomicity-fixes.md`. Each fix wraps an existing mutation +
audit pair in `db.transaction(() => { ... })()`.

Apply, then `npm test`. Expect 127/127. Atomicity is invisible to the
existing tests (it shows up only under failure injection), so green is
the correct bar.

### Step 5 — CRITICAL security fixes from slice 6g

a. **CRIT-1: tenant scoping in `insurance.ts`.** Three handlers
   (`bindPolicy`, `recomputePolicy`, `attachExternal`) need a tenant
   ownership check. See `slice6g-security-review.md` section 6g.CRIT-1
   for the exact pattern.

b. **CRIT-2: `dev_hmac_secret` fallback.** Replace the inline `?? "dev_hmac_secret"`
   in three locations with a `loadHmacSecret()` helper that fails-fast in
   production. See section 6g.CRIT-2.

   After this fix, run the app locally with `NODE_ENV=production` and no
   `PAYOUT_HMAC_SECRET` set. It should refuse to start. If it does, the
   fix worked.

c. Run `npm test`. Tests use `NODE_ENV=test` (verified slice 3 logs), so
   the production guard won't fire; existing fallback behavior is
   preserved. Expect 127/127.

### Step 6 — Deferred to future sprints

**Slice 6b — Four audit gaps.** `auth.ts /change-password`,
`regulatoryIngest.ts /onboard`, `regulatoryIngest.ts /frameworks/:code`,
plus the two actor-attribution gaps from `commercial.ts` (`/insurance/register`,
`/token/apply`). All currently on TEMPORARY allowlist; CI green. Real fixes
need `.ts` source uploads to produce real diffs.

**Slice 6c — Helper consolidation.** Move duplicated `commercialAuditLog` +
`auditLog` helpers into `src/lib/audit.ts`. Must follow slice 6a.

**Slice 6g HIGH findings.**
- HIGH-1: defense-in-depth `AND tenant_id = ?` on UPDATEs (4 sites)
- HIGH-2: `validate()` on every sub-router — its own sprint, ~25 routes
- HIGH-3: `|| 1.0` → `?? 1.0` + NaN guard (1 line)

**Slice 6d-extended.** `receipt_log`, `job_queue`, `notification_log` —
same schema-in-routes pattern as `role_audit_log`. Each table needs the
same audit-and-promote treatment.

## What the sprint accomplished

| Slice | Status | What it shipped |
|---|---|---|
| 2 — Input validation | ✓ Applied | Zod schemas, AppError factory, request-ID middleware, validate() (for app.ts routes only — see 6g HIGH-2) |
| 3 — Pino logging + shutdown | ✓ Applied | pino logger, graceful shutdown handlers, http-logger middleware |
| 4 — Health endpoints | ✓ Applied | /healthz (liveness), /readyz (deep), migration-rollback runbook |
| 5 — Audit coverage | ✓ Applied | Full audit map (25 routes), CI guard test, 4 gaps + 2 actor-attribution gaps |
| 6a — Atomicity sweep | Patch ready | 10 transaction-wrapping edits across 3 route files |
| 6b — Four audit gaps | Not started | Awaits 6a + .ts uploads |
| 6c — Helper consolidation | Not started | Awaits 6a applied + .ts uploads |
| 6d — Migration cleanup | Code + patch ready | New phase11_users_audit.ts + 3 edits + 1 deletion |
| 6e — Audit verification | ✓ Applied | Engine review complete: 3 routes JUSTIFIED, 2 new actor-attribution gaps surfaced |
| 6f — Cleanup | Files + patches | .gitattributes shipped; tax-receipt patches by hand |
| 6g — Security review | Document shipped | 2 CRITICAL findings need fixes before deploy; 3 HIGH for next sprint |

## Why some slices are patches, not finished files

I had access to your compiled `.js` outputs of the route files (sufficient
to do code review and produce patch instructions) but not the original
`.ts` source. Writing `.ts` files from compiled `.js` would have produced
files with `__importDefault` shims and IIFE compilation artifacts that
don't belong in a `.ts` source tree.

Slices that DO ship finished files (6d's new migration, 6f's `.gitattributes`,
6e and 5's docs/tests) are ones that don't depend on existing source —
they're new modules, new files, or modifications to files I'd already
seen in their authoritative `.ts` form.

If you want me to do real `str_replace` edits on the remaining patch
instructions, upload the `.ts` sources of:

- `src/routes/users.ts`
- `src/routes/provisioning.ts`
- `src/routes/insurance.ts`
- `src/routes/auth.ts`
- `src/routes/regulatoryIngest.ts`
- `src/routes/commercial.ts`
- `src/db/migrate.ts`
- The tax-receipt module (`src/lib/tax-receipt.ts` or wherever it lives)

With those, slices 6a, 6b, 6c, 6d's remaining edits, 6f.2 (tax receipt),
and 6g's CRITICAL/HIGH fixes can all become real diffs.

## Validation matrix

After each step, what to check:

| After step | Tests | Migration log | What changed |
|---|---|---|---|
| 1 (test fix) | 127/127 | Same 27 migrations | Just the regex tolerates .ts type annotations |
| 2 (.gitattributes) | 127/127 | Same | Repo blob normalization |
| 3 (6d) | 127/127 | 28 migrations applied | New v28 line + cleaner users.ts |
| 4 (6a) | 127/127 | Same | Atomicity invisible to tests; durability under crash |
| 5 (6g CRIT-1) | 127/127 | Same | Cross-tenant attack scenarios blocked |
| 5 (6g CRIT-2) | 127/127 in NODE_ENV=test; production refuses to start without env var | Same | Signing-secret fallback closed |

If any step deviates from this matrix, stop and diagnose before continuing.
The slice-5 CI guard (audit-coverage.test.ts) will catch any audit
regression introduced by slice 6a or 6d. If it fires, treat that as the
signal to revert and re-apply more carefully.

## Final note

This sprint did real architectural work, not just cosmetic hardening:

- Migration system is now properly understood and consolidated (the
  spread-from-sibling-file pattern is the canonical convention)
- Audit coverage has a self-checking CI guard that catches its own blind
  spots (proved in the slice 5/6 typed-handler regex discovery)
- Two coexisting audit philosophies (`commercial_audit_log` vs HMAC
  tamper-evidence) are documented; neither alone is sufficient but both
  together cover state integrity + actor attribution
- The security review found two CRITICAL gaps that were NOT in the original
  handoff scope — finding them was a side effect of the comprehensive
  per-route review

The codebase architecture is sound. The hardening was about making the
architectural invariants enforced rather than implicit. Most of the
remaining work (6b, 6c, 6g HIGH-2) is bounded continuation of patterns
already established in this sprint, not new design.

Good luck with the deploy.
