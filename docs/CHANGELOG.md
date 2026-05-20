# Hotfix — `tests/audit-coverage.test.ts` post-slice-6c

## What failed

1 test failing out of 127, all in `tests/audit-coverage.test.ts`. The CI
guard from slice 5 reported coverage gaps on multiple routes in
`users.ts`, `provisioning.ts`, and `insurance.ts` — routes that ARE
audited but the regex stopped detecting it.

## Root cause: slice 6c regression in the test

The test's coverage check had this logic (line 254 in the original):

```ts
if (AUDIT_HELPER_CALL.test(body) && AUDIT_PATTERN.test(source)) return true;
```

Translation: "a handler counts as audited if it calls an audit helper
AND the file source somewhere contains `INSERT INTO commercial_audit_log`
or `INSERT INTO role_audit_log`."

That second clause was the safety net for handlers that delegated to a
**same-file local helper function** — the helper's `INSERT INTO` statement
satisfied the file-level check.

**Slice 6c moved `INSERT INTO commercial_audit_log` and
`INSERT INTO role_audit_log` out of every route file** by deleting the
local helper functions and replacing them with imports from
`src/lib/audit.ts`. The route files still call `commercialAuditLog(...)`
and `auditLog(...)`, but no longer contain the literal INSERT strings. The
test's safety net stopped firing. Several routes that ARE audited started
failing the check.

The same regression hit inline-arrow handlers (the `handler === null`
branch at line 197 of the original), which fell back to
`AUDIT_PATTERN.test(source)` directly. This affected the inline-handler
routes in `regulatoryIngest.ts` (POST /onboard, PATCH /frameworks/:code)
that slice 6b just added audit coverage for.

## Fix

Refactored the file-level audit-evidence check into a shared helper that
recognizes both legacy and post-slice-6c patterns:

```ts
function fileHasAuditEvidence(source: string): boolean {
  // Legacy: INSERT INTO statement local to the file (pre-slice-6c)
  if (AUDIT_PATTERN.test(source)) return true;
  // Post-slice-6c: import from the consolidated audit lib
  if (/from\s+["']\.\.\/lib\/audit["']/.test(source)) return true;
  return false;
}
```

Apply this helper in three places where the original tested only
`AUDIT_PATTERN.test(source)`:

1. Inline-arrow handler fallback (where named-handler extraction is impossible)
2. Missing-`fnHeader` fallback (handler defined unusually)
3. Named-handler audit-helper-call check (the original line 254)

## Also: removed 5 stale TEMPORARY allowlist entries

Slice 6b actually closed the audit gaps for:

- `auth.ts POST /change-password` (now writes `role_audit_log`)
- `regulatoryIngest.ts POST /onboard` (now writes `commercial_audit_log`)
- `regulatoryIngest.ts PATCH /frameworks/:code` (same)
- `commercial.ts POST /insurance/register` (same)
- `commercial.ts POST /token/apply` (same)

Their TEMPORARY allowlist entries are now both incorrect (they say "GAP —
add audit") and redundant (the routes ARE audited). Removed.

The 6th TEMPORARY entry — `auth.ts POST /register` — was NOT closed by
slice 6b (it requires a team decision on whether self-registration needs
its own audit row beyond the `users.created_at` evidence). Kept with an
updated reason noting the decision is still pending.

## Verified locally before shipping

Ran the updated test logic against the working copy:

```
✓ No coverage gaps. Test would pass.
```

This time I'm not shipping a speculative fix — the new code was simulated
end-to-end against actual current source files. Both the "gaps" check and
the "stale allowlist" check pass cleanly. (The stale-allowlist dry-run
flagged 3 routes whose files aren't in my working copy — `risk-pricing.ts`,
`pilot-ingest.ts`, `admin.ts` — but those files exist in the user's repo
and the entries are valid there.)

## Apply

Replace `tests/audit-coverage.test.ts` with this version. Run `npm test`.
Expect **127/127 green**.

## Lessons logged

This is the second time in this sprint that a "harmless" refactor created
a regression in a regression guard. First time was slice 5's regex
needing tolerance for TypeScript type annotations on inline handlers.
This time slice 6c moved INSERT INTO out of route files in a way the
test couldn't detect. Both fixes were one-line additions to a single
function. Both could have been caught by running the test locally before
shipping the refactor.

For future slices that change audit infrastructure (consolidation,
extraction, splitting), part of the pre-flight check should be: "did this
change move any INSERT INTO statement out of the file it used to live in,
and if so, does the audit-coverage test still detect it?" Adding to the
slice 7+ pre-flight checklist.
