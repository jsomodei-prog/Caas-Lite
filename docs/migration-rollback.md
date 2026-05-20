# Migration Rollback Procedure

**Scope.** This document covers how to roll back a database schema migration on
CaaS-Lite (SQLite via better-sqlite3). It assumes you have shell access to a
node where the database file lives, and that you understand the deployment is
currently broken or degraded due to a recent migration.

This is operational documentation. If you have not personally been through a
rollback on this codebase before, **read the entire document before touching
anything**. Stop and ask if anything below contradicts what you observe.

---

## 1. Decide: roll back or forward-fix?

In almost every case, **forward-fix is safer**. Rolling back a migration on a
running production database is a destructive operation: you cannot undo a
rollback if the new state turns out to be wrong.

Roll back only if **all** of the following are true:

1. The most recent migration is the cause of the broken state. Confirm this
   from logs (`schema now at version N` lines emitted by `runMigrations` at
   boot) and from your deployment timeline.
2. A forward-fix would take longer than the duration of the current incident's
   acceptable downtime.
3. You have a current backup that predates the broken migration. Verify this
   by checking the backup manager's `getManifestHistory()` output (via
   `GET /api/v1/admin/backups`) before doing anything else.
4. The migration's `down` step is reversible. Migrations that drop columns,
   coalesce rows, or transform data **are not safely reversible** even if a
   `down` function exists — the original data is gone.

If any of these is false, forward-fix. Write a new migration that corrects the
broken state and deploy it through the normal path.

---

## 2. Understand what you're rolling back

Open `src/db/migrate.ts`. Migrations are declared in the `MIGRATIONS` array at
module scope, each with shape:

```ts
{
  version:     <number>,
  description: <string>,
  up:          (db) => { /* applies the change */ },
  down?:       (db) => { /* reverses the change */ },  // optional, not always present
}
```

**The `down` step is optional.** If the migration you want to revert does not
have one, you cannot roll back via this procedure. Restore from backup instead
(section 5).

Identify exactly which version is broken. Run:

```sql
SELECT version, applied_at FROM schema_migrations ORDER BY version DESC LIMIT 10;
```

The top row is the most recent applied migration. That is the candidate for
rollback.

---

## 3. Pre-flight checks

Before rolling back, capture the current state so you can verify the rollback
afterwards and recover if it goes wrong:

1. **Stop incoming traffic.** Take the pod out of the load balancer (the
   `/readyz` endpoint returning 503 will do this automatically if you flip
   the migration count, but the cleanest way is to scale to zero or use
   your orchestrator's drain command).
2. **Capture a backup right now.** Hit `POST /api/v1/admin/backups` or run
   the backup manager manually. Do not skip this. The pre-rollback state is
   what you'll need if the rollback itself causes corruption.
3. **Checkpoint the WAL.** `sqlite3 <db-file> 'PRAGMA wal_checkpoint(TRUNCATE);'`
   This collapses the write-ahead log so the backup you just took is
   self-contained.
4. **Record the current schema version.** Save the output of:

   ```sql
   SELECT version, applied_at FROM schema_migrations ORDER BY version;
   ```

   Keep this somewhere recoverable. If the rollback proceeds, this is your
   reference for "what should the table look like if I revert."

---

## 4. Execute the rollback

The codebase does not have a CLI command for rollback. This is intentional —
rollback is rare enough that ad-hoc supervised execution is safer than a
button. Steps:

1. With the process **stopped**, open a Node REPL or one-shot script with
   the same DB path the app uses:

   ```ts
   import Database from "better-sqlite3";
   const db = new Database("/data/caas_evidence.db");
   db.pragma("journal_mode = WAL");
   db.pragma("foreign_keys = ON");
   ```

2. Import the `MIGRATIONS` array. Note that it's not currently exported —
   you may need to add a temporary export, or copy the relevant `down`
   function into your script. **Do not commit such a change**; revert it
   after the rollback.

3. Run the migration's `down` function inside a transaction:

   ```ts
   const target = MIGRATIONS.find(m => m.version === <broken-version>);
   if (!target?.down) throw new Error("No down step — restore from backup instead");

   const tx = db.transaction(() => {
     target.down!(db);
     db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(target.version);
   });
   tx();
   ```

4. Verify the row is gone from `schema_migrations` and the schema reflects
   the pre-migration state. Run any spot-check SQL relevant to what the
   migration touched (column existence, table existence, index presence).

5. Checkpoint the WAL again before restarting.

---

## 5. If `down` doesn't exist or fails

Restore from the most recent backup that predates the broken migration.
This is destructive — you will lose all writes between the backup and now.
This is the trade-off.

1. With the process **stopped**, replace the DB file with the backup. The
   exact mechanics depend on your backup format (raw `.db` file copy vs S3
   restore). Consult `src/db/replication.ts` and the `BackupManager` API.
2. After replacement, run `PRAGMA integrity_check` on the restored file.
   It should return `ok`.
3. Start the process. Migrations from the backup's version forward will
   re-apply on boot. If the same migration is still in the `MIGRATIONS`
   array, **it will re-apply and you will be back where you started**.
   Either remove the migration from the array (and the corresponding code
   references) or fix it before restarting.

---

## 6. After rollback

1. Restart the process. `/readyz` should return 200 once migrations are at
   head (which in a rollback case means at the pre-broken version).
2. **Schema and the `MIGRATIONS` array are now out of sync.** The array
   still contains the broken migration; the database no longer has it
   applied. If you redeploy the same code, it will re-apply. Either:
   - Remove or fix the broken migration in the array, **or**
   - Pin the broken version to skip via a code change in `runMigrations`
     (do not do this; the previous option is cleaner).
3. Open a postmortem ticket. The rollback should leave a trail.

---

## 7. SQLite-specific gotchas

- **No transactional DDL for some operations.** SQLite supports
  transactional `CREATE TABLE`, `DROP TABLE`, and column additions, but
  some older operations (renaming columns pre-3.25, certain `ALTER TABLE`
  forms) are not. If your `down` function uses one of these, the rollback
  may leave the schema in a half-state. Test the `down` against a copy of
  the DB before running it on the real one.
- **WAL implications.** A migration that does heavy writes may leave a
  large WAL. Checkpoint before and after.
- **`PRAGMA foreign_keys = ON` matters during rollback.** If you forget
  to set it, `down` functions that depend on FK constraints to cascade
  may behave differently than they did in testing.
- **`schema_migrations` row vs actual schema state.** These can drift if
  a `down` function partially succeeds. If you see `schema_migrations`
  claiming a version is applied but the schema doesn't reflect it,
  manually reconcile — `schema_migrations` is just bookkeeping; the
  schema itself is the source of truth.

---

## 8. What never to do

- Edit `schema_migrations` rows without also reverting the corresponding
  schema state. This is the fastest way to get an inconsistent DB that
  future migrations will refuse to touch.
- Run `down` against a DB the app is still writing to. Always stop the
  process first.
- Roll back across multiple versions in a single step unless every
  intervening `down` is independently safe. Roll back one at a time and
  verify between each.
- Skip the pre-rollback backup. The temptation under time pressure is
  immense. Don't.
