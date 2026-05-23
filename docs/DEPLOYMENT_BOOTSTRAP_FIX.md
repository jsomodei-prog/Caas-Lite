# DEPLOYMENT.md Bootstrap Recipe — Correction Record

**Status:** Working document. v1.0, drafted 2026-05-22.
**Purpose:** Record what was wrong with the bootstrap recipe in earlier versions of `DEPLOYMENT.md`, what changed, and how the change was verified. This document is for audit and for the incoming integration team; the corrected recipe itself lives in `DEPLOYMENT.md` § Bootstrap the first user.

**Companion to:** `DEPLOYMENT.md`, `STOPGAP_EXECUTION.md` task G.

---

## What was wrong

Earlier versions of `DEPLOYMENT.md` § Bootstrap the first user contained an `INSERT INTO users` recipe that referenced columns that do not exist in the live `users` table schema as of 2026-05-22:

| Column referenced in old recipe | Status in live schema |
|---|---|
| `permission_level` | **Does not exist.** The value previously assigned here (`client_super_admin`) belongs in `plane_role` under the current schema. |
| `is_active` | **Does not exist.** |

The old recipe also did not explicitly set `email`, `control_plane`, or `plane_role` — which the live schema requires.

Anyone following the old recipe would have hit one of:

- `SQL error: no such column: permission_level` on attempting the INSERT, or
- if the INSERT was reshaped to drop the unknown columns, `NOT NULL constraint failed: users.email` or `CHECK constraint failed: users.control_plane` / `users.plane_role` on the columns the live schema does require.

In either case, no Executive user gets created, and the bootstrap fails.

## Why it was wrong

Two possibilities, both consistent with the evidence:

1. **The schema migrated after the recipe was first written.** The original bootstrap was done with a schema that had `permission_level` and `is_active`; subsequent migrations renamed `permission_level` to `plane_role`, added `control_plane` and `email`, and removed `is_active`. The recipe in `DEPLOYMENT.md` was not updated alongside.
2. **The recipe was never correct.** It was written from memory or against a planned-but-not-shipped schema, and the original bootstrap was done against a different sequence of SQL that wasn't documented here.

Either way, the document drifted from the running schema. This is the underlying discipline gap: **schema is truth; documentation that asserts the schema must be re-verified whenever it's relied on.**

## What changed

The bootstrap section of `DEPLOYMENT.md` was rewritten with the following changes:

1. **Live-schema verification step added.** Before the INSERT, the recipe now requires the operator to run `.schema users` inside the sqlite3 session and read the column list. This makes the next failure mode (further schema drift) self-correcting: the recipe tells the operator to adjust the INSERT to match what they see, not to loosen the schema.

2. **INSERT statement corrected.** The new INSERT lists these columns explicitly:
    - `id`
    - `username`
    - `email`
    - `tenant_id`
    - `role`
    - `control_plane`
    - `plane_role`
    - `password_hash`
    - `created_at`
    - `updated_at`

   `permission_level` and `is_active` are removed entirely.

3. **Column notes section added.** Each non-obvious column has a note explaining what it must contain and why. Specifically:
    - `role` must be one of `Executive` / `Auditor` / `Partner` (enforced by `RegisterBody` zod schema in `src/routes/auth.ts`).
    - `control_plane` is governed by a DB-level CHECK constraint; values appearing in practice are `business` or `client`.
    - `plane_role` is governed by a DB-level CHECK constraint; the value `client_super_admin` (formerly held in `permission_level`) maps here.
    - `password_hash` must be the bcrypt output, not the plaintext — explicitly called out because this is the most common bootstrap failure when operators rush.

4. **Historical block retained for audit.** The "Bootstrap production user" subsection of § Production state of record still records the original aitw-ops insert with `permission_level: client_super_admin`. This is left in place as historical fact (it's what was *done*, even if the column has since been renamed) with a note pointing to the corrected recipe. The note explicitly says: do not use this historical block as a recipe; use § Bootstrap the first user.

## How it was verified

Schema verification, against the live database on Fly:

```bash
fly ssh console -a caas-lite
sqlite3 /data/caas.db ".schema users"
```

Confirm the printed schema contains (at minimum):

- `id` TEXT PRIMARY KEY
- `username` TEXT NOT NULL UNIQUE
- `email` TEXT NOT NULL
- `tenant_id` TEXT NOT NULL
- `role` TEXT NOT NULL (likely with a CHECK)
- `control_plane` TEXT NOT NULL with a CHECK constraint
- `plane_role` TEXT NOT NULL with a CHECK constraint
- `password_hash` TEXT NOT NULL
- `created_at` TEXT NOT NULL
- `updated_at` TEXT NOT NULL

Confirm the printed schema does NOT contain `permission_level` or `is_active`.

If the live schema differs from this list — extra columns, different CHECK constraints, different NOT NULL set — the corrected recipe in `DEPLOYMENT.md` needs another update, and this correction record needs a v1.1 entry below.

## What this exposes

The bootstrap recipe wasn't the only place this could happen. Anywhere a document asserts schema-level facts, the same drift can occur silently:

- The `RegisterBody` schema in `src/routes/auth.ts` and the DB CHECK constraints can drift apart.
- The slice 7 hardening tracker references column names; those can drift.
- The gap map references table names (`commercial_audit_log`, `role_audit_log`, `trust_badge_history`, etc.); those can drift.

**Block 1 of `DELIVERABLE_PATH.md`** — the gap map walk-through — is the place to catch the next instance. While walking the rows, treat any schema-name reference in a document as a hypothesis to verify against `.schema`, not as a fact.

## Change log

- **2026-05-22** — v1.0 initial draft. Records the correction applied to `DEPLOYMENT.md` § Bootstrap the first user in the same session.
