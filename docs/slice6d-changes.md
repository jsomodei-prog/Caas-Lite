# Slice 6d — Code Changes

**What this slice ships.** Three file changes plus one deletion. The new file
is included as a real artifact; the other three are patch instructions
because they edit files I don't have local copies of (only compiled `.js`).

## 1. NEW FILE — `src/db/migrations/phase11_users_audit.ts`

Provided. Drop into the repo as-is. Defines migration v28 that promotes
`user_profiles` and `role_audit_log` to the canonical migration system.

## 2. EDIT — `src/db/migrate.ts`

Two changes:

### 2a. Add import near the top, alongside the existing PHASE15 import

Find the existing import that brings in `PHASE15_MIGRATIONS`. It's somewhere
in the imports block at the top of `migrate.ts`. The import line looks like:

```ts
import { PHASE15_MIGRATIONS } from "./migrations/phase15_commercial_activation";
```

Add directly below it:

```ts
import { PHASE11_USERS_AUDIT_MIGRATIONS } from "./migrations/phase11_users_audit";
```

### 2b. Add spread to the MIGRATIONS array

In the `MIGRATIONS` array, find the existing spread:

```ts
  // ── 022+ ── Phase 15 Commercial Activation (v22–v26) ────────────────────────
  // Spread from src/db/migrations/phase15_commercial_activation.ts so the
  // canonical runner remains the single source of truth. See yesterday's
  // unification work for why this pattern matters.
  ...PHASE15_MIGRATIONS,

];
```

Replace with:

```ts
  // ── 022+ ── Phase 15 Commercial Activation (v22–v27) ────────────────────────
  // Spread from src/db/migrations/phase15_commercial_activation.ts so the
  // canonical runner remains the single source of truth. See yesterday's
  // unification work for why this pattern matters.
  ...PHASE15_MIGRATIONS,

  // ── 028 ── Phase 11 users + audit schema promotion (slice 6d) ────────────────
  // Moves user_profiles + role_audit_log from inline DDL in src/routes/users.ts
  // to the canonical migration system. See that file's header for the full
  // rationale. After v28 runs, the corresponding `ensureUserProfileTable`
  // function in users.ts is no longer needed (and is deleted in the same
  // commit as this migration).
  ...PHASE11_USERS_AUDIT_MIGRATIONS,

];
```

(Note: the existing comment says "v22–v26" but Phase 15 actually contains v22-v27 per the grep — fixing that typo as part of this edit. If you'd rather leave that fix for a separate commit, change my replacement back to "v22–v26".)

## 3. EDIT — `src/routes/users.ts`

Two changes:

### 3a. Delete the `ensureUserProfileTable` function

Find the function (around line 40 in the compiled output; should be similar
in the .ts source). Delete it entirely, including the section comment that
follows:

```ts
function ensureUserProfileTable(db: DB): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS user_profiles (...) `).run();
  db.prepare(`CREATE TABLE IF NOT EXISTS role_audit_log (...) `).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_role_audit_tenant ...`).run();
  db.prepare(`CREATE INDEX IF NOT EXISTS idx_user_profiles_tenant ...`).run();
}
```

### 3b. Delete all call sites

Find every call to `ensureUserProfileTable(db)` in `users.ts` and delete the
line. The slice 5 review of the compiled file showed only ONE call site:

- In `upsertProfile` at around line 201 in the compiled output:
  ```ts
  ensureUserProfileTable(db);
  ```
  Delete this line.

After deletion, `ensureUserProfileTable` should be referenced nowhere in
the file. The migration v28 guarantees the tables exist at boot, so the
runtime check was always redundant after first boot anyway — it was
defensive against the schema-in-route-file pattern this slice fixes.

## 4. DELETE — `src/db/migrate-phase11.ts`

Plain `git rm src/db/migrate-phase11.ts`.

Verified per slice 6d analysis:
- No code references it (grep returned nothing)
- It's a CLI script with its own `main()` and no module exports anyone uses
- Its migration version numbers (v16-v22) collide with completely different
  content already running in `migrate.ts` via the canonical runner
- If anyone ran the script today, the `appliedVersions.has(version)` check
  would silently skip everything

Also check for and delete (if they exist):
- `scripts/migrate-phase11.ts` (the file the header comment said to invoke)
- Any `package.json` script that invokes it
- Any documentation that references running it

```powershell
Test-Path scripts/migrate-phase11.ts
Select-String -Path package.json, README*, docs/* -Pattern "migrate-phase11"
```

If those return anything, remove those references in the same commit.

---

## Verification after applying all four changes

Run `npm test`. Expected outcome:

- The test log shows a new line `[migrate] ✓ 028 Phase 11 — promote user_profiles + role_audit_log from inline DDL to migrations (Xms)` for any fresh test DB.
- For test DBs that were created during prior test runs (Jest creates a new tempfile per test file, so this is moot — every DB is fresh), the migration is a no-op because of `IF NOT EXISTS`.
- The 124+ tests stay green. Nothing in the user-profile or role-audit-log
  contract changed — same tables, same indexes, same column shapes.
- The slice 5 audit-coverage test continues to pass because
  `ensureUserProfileTable`'s removal doesn't touch any mutation route.

If any test fails: the most likely cause is a call site I missed in step 3b.
Run `Select-String -Path src/routes/users.ts -Pattern "ensureUserProfileTable"`
and ensure it returns nothing.

---

## What slice 6d does NOT do (flagged for follow-up)

The same schema-in-route-files pattern likely applies to three other tables
declared by the dead `migrate-phase11.ts`:

- `receipt_log` — used by tax-receipt code
- `job_queue` — used by the async queue subsystem
- `notification_log` — used by Slack/Discord dispatch

Where each of these is actually created (probably inline DDL in their
respective service or route files) is not yet verified. Each needs the
same audit-and-promote treatment as v28 does for the user tables.

I'd schedule that as a single follow-up slice — call it 6d-extended — once
slice 6b/6c/6f/6g are done. Doing it now would expand 6d beyond what was
locked in the plan.
