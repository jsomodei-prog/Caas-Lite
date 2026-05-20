# Slice 6d — Migration System Findings & Actions

**Status.** Analysis complete on `migrate-phase11.ts` and the `role_audit_log`
duplication question (Issues E and F from `docs/audit-coverage.md`). One
unresolved item blocks slice 6 completion: the `commercial_audit_log` table
definition cannot be located in any uploaded file.

---

## Finding 1 — `src/db/migrate-phase11.ts` is dead code

**Evidence.**
- The file has a `main()` function and terminates with `main().catch(err => ...)`.
  That's a CLI entrypoint, not an importable module.
- The header comment instructs: *"Run with: npx ts-node --project tsconfig.json scripts/migrate-phase11.ts"* — manual invocation only.
- Grep for `migrate-phase11`, `phase11Migrations`, `migratePhase11` across
  the codebase returned no references. Nothing imports it, nothing invokes it.
- The migrations it declares (v16-v22) are at version numbers ALREADY USED by
  the main migration sequence in `src/db/migrate.ts`, with DIFFERENT content:
  - `migrate-phase11.ts` v16 = `user_profiles` table
  - `migrate.ts` v16 (verified from slice 3 test logs) = "Phase 14 — dynamic regulatory framework ingestion"
  - `migrate-phase11.ts` v17 = `role_audit_log` table
  - `migrate.ts` v17 (verified from slice 3 test logs) = "Add control_plane and plane_role columns to users table"
- The slice 3 test output shows 27 migrations applied via `runMigrations(db)` alone, none routed through `migrate-phase11.ts`.

**Failure mode if anyone runs it.**
If the script were executed against a database that has already advanced past
v15 via the main `runMigrations`, the script would:
1. See those versions already in `schema_migrations`,
2. Hit the `appliedVersions.has(migration.version)` early-skip check,
3. Silently never create `user_profiles`, `role_audit_log`, `receipt_log`,
   `job_queue`, `notification_log`.

The dev who ran it would see "✓ all skipped" output and assume everything is
fine. The tables would only exist if the inline DDL elsewhere created them.

**Recommendation: DELETE `src/db/migrate-phase11.ts`.**

Also check for and delete:
- `scripts/migrate-phase11.ts` (the runner referenced in the header comment)
- Any `package.json` script that invokes it
- Any README mentions of it

```powershell
Select-String -Path scripts/*, package.json, README*, docs/* -Pattern "migrate-phase11"
```

If that grep returns hits, those references must be removed alongside the
file deletion. If it returns nothing, the file is fully isolated dead code.

This closes Issue F.

---

## Finding 2 — `role_audit_log` schema lives in `src/routes/users.ts`, not in any migration

**Evidence.**
- `migrate-phase11.ts` declares v17 = `role_audit_log` (dead code, per Finding 1).
- `src/routes/users.ts` line 142 (slice 5 grep) creates the table inline via
  `CREATE TABLE IF NOT EXISTS role_audit_log (...)` plus the matching indexes.
- The main `src/db/migrate.ts` does NOT contain a `CREATE TABLE role_audit_log` —
  verified by absence from the slice 3 migration log output, which listed every
  applied migration with its description and none matched.

**This is worse than the "duplication" I described in slice 5.** The route
file is the **sole source of truth** for the schema. Implications:

1. Any DB that boots without first hitting `users.ts` (a fresh test DB, a
   migration-only operations container, anything that imports modules but
   doesn't load the users router) will not have `role_audit_log`. The
   124 tests pass because they all use the full app factory, which mounts
   `createUsersRouter` and triggers `ensureUserProfileTable(db)` at first
   call.

2. `/readyz` (slice 4) reports "ready" based on `getPendingMigrations(db)`
   returning empty. If a user hits `/api/v1/users/audit-log` before any
   handler in `users.ts` has run `ensureUserProfileTable`, the query
   `SELECT * FROM role_audit_log WHERE tenant_id = ? ...` will throw
   "no such table". `/readyz` won't catch this.

3. Schema changes to `role_audit_log` would require editing route files
   AND adding a migration, instead of just adding a migration.

**Recommendation: add a migration v28 to `src/db/migrate.ts` that creates
`role_audit_log`, then delete the inline `ensureUserProfileTable` DDL from
`users.ts`.**

The migration body is the same DDL `users.ts` already runs:

```ts
{
  version: 28,
  description: "Promote role_audit_log to migrations (was inline DDL in users.ts)",
  up(db) {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS role_audit_log (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        target_user_id  TEXT NOT NULL,
        actor_user_id   TEXT NOT NULL,
        action          TEXT NOT NULL,
        old_value       TEXT,
        new_value       TEXT,
        reason          TEXT,
        created_at      TEXT NOT NULL
      )
    `).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_role_audit_tenant
                ON role_audit_log(tenant_id, created_at DESC)`).run();
    db.prepare(`CREATE INDEX IF NOT EXISTS idx_role_audit_target
                ON role_audit_log(target_user_id, created_at DESC)`).run();
  },
}
```

Because the existing inline DDL uses `IF NOT EXISTS`, the migration is safe
to run against:
- Fresh DBs (creates the table)
- DBs that already have the table from a prior `users.ts` boot (no-op)

After the migration lands, delete `ensureUserProfileTable`'s
`role_audit_log` block from `users.ts`. The `user_profiles` block in that
same function should ALSO move to a migration — verify whether `migrate.ts`
already contains `user_profiles` DDL (likely the case based on the
slice 3 test log mentioning v16 phases). If yes, just delete; if not,
include the `user_profiles` DDL in the same v28 migration.

This closes Issue E.

---

## Finding 3 — UNRESOLVED — `commercial_audit_log` table definition not found

**Evidence.**
- Slice 5 grep showed `commercial_audit_log` is written from `insurance.ts`,
  `provisioning.ts`, and `lib/badge-rotation.ts`.
- Slice 6 grep `Select-String -Path src/db/migrate.ts -Pattern "commercial_audit_log" -Context 0,15` returned **nothing**.
- The 124 tests include `badge-rotation.test.ts` which exercises an insert
  to this table. The test passes. Therefore the table exists at test time.

**Where is it being created?** Three possibilities, in order of likelihood:

1. **A `migrate-phase15.ts` exists** parallel to `migrate-phase11.ts`. If
   that file is also dead code (same pattern: standalone CLI, not imported),
   we have the same problem as Finding 2 in a different file. Check:
   ```powershell
   Get-ChildItem src/db/migrate-phase*.ts
   ```

2. **Inline DDL in a routes file** like `users.ts` does for `role_audit_log`.
   Check:
   ```powershell
   Select-String -Path src/**/*.ts -Pattern "CREATE TABLE.*commercial_audit_log" -Context 0,15
   ```

3. **The slice 3 migration log mentioned v25 = "Phase 15 — commercial_audit_log
   (write trail for Phase 15 mutations)".** It might be in `migrate.ts` but
   the grep I asked for missed it. Re-verify with a broader pattern:
   ```powershell
   Select-String -Path src/db/migrate.ts -Pattern "commercial_audit_log|Phase 15"
   ```

**Why this matters.** I need to see the `actor_user_id` column declaration
to confirm whether `recomputeAllWarranties` (which passes `null` for actor)
is silently failing in production. If `actor_user_id TEXT NOT NULL`, every
state-changing recompute throws a constraint violation and the `errors++`
counter in `recomputeAllWarranties` catches it without surfacing. That's
a real production bug we'd want to fix in this slice, not defer.

---

## What slice 6d delivers

This document. No code changes yet, because:

- Deleting `migrate-phase11.ts` is a file deletion — better to do it
  in the same PR as the v28 migration and the `users.ts` cleanup, so
  the whole "schema lives in migrations now" change is atomic in git.
- Adding migration v28 requires editing `src/db/migrate.ts`, which I
  haven't seen the full source of.
- Resolving Finding 3 needs your grep output before I can act.

## Next actions for you

In order:

1. **Confirm Finding 1.** Run:
   ```powershell
   Select-String -Path scripts/*, package.json -Pattern "migrate-phase11"
   ```
   If no hits, `migrate-phase11.ts` is safe to delete in isolation.

2. **Resolve Finding 3.** Run the three commands listed above to locate
   the `commercial_audit_log` table definition, then paste the output.

3. **Then I do** slice 6d's code changes in one pass:
   - delete `migrate-phase11.ts` (and `scripts/migrate-phase11.ts` if it exists)
   - add migration v28 (`role_audit_log`, possibly `user_profiles` if missing)
   - delete the inline DDL from `users.ts`
   - **Possibly** delete `commercial_audit_log` DDL from wherever it lives
     and promote to a migration too, depending on Finding 3's outcome.
