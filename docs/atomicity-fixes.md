# Slice 6a — Atomicity Fixes

**Goal.** Move every audit-log insert inside the same `db.transaction()` as
the mutation it logs. Closes Issue A from `docs/audit-coverage.md`.

**Scope.** 10 call sites across 3 files:

- `src/routes/users.ts` — 5 sites
- `src/routes/provisioning.ts` — 3 sites
- `src/routes/insurance.ts` — 2 sites

**Pattern.** Every fix follows the same shape:

```ts
// BEFORE
db.prepare("UPDATE ... ").run(...);
auditLog(db, ..., "action", oldValue, newValue);

// AFTER
db.transaction(() => {
  db.prepare("UPDATE ... ").run(...);
  auditLog(db, ..., "action", oldValue, newValue);
})();
```

For handlers that already have a `db.transaction(()=>{...})()` wrapping the
mutation, the audit call that currently lives *after* the closing `)()` is
moved *inside* the closure.

**Side effects to watch for.** Variables assigned inside the transaction
closure that are read afterwards (e.g. `badgeSignature` in
`provisioning.ts createAccount`) need to remain reachable. Use `let` declared
above the closure and assign inside, which is already the existing pattern.

---

## File: src/routes/users.ts

All five handlers in this file follow the same anti-pattern: `INSERT`/`UPDATE`
runs, then `auditLog(...)` runs as a separate statement. Wrap each in a
transaction.

### 1. `upsertProfile` (around line 196)

```ts
// BEFORE (the existing if/else + auditLog tail)
if (existing) {
  db.prepare(`UPDATE user_profiles ...`).run({...});
} else {
  db.prepare(`INSERT INTO user_profiles ...`).run({...});
}
auditLog(db, tenantId, userId, actorId, "profile_update", null,
  JSON.stringify({ display_name, country_code, kyc_tier }));
res.json({ success: true, updated_at: now });

// AFTER
db.transaction(() => {
  if (existing) {
    db.prepare(`UPDATE user_profiles ...`).run({...});
  } else {
    db.prepare(`INSERT INTO user_profiles ...`).run({...});
  }
  auditLog(db, tenantId, userId, actorId, "profile_update", null,
    JSON.stringify({ display_name, country_code, kyc_tier }));
})();
res.json({ success: true, updated_at: now });
```

### 2. `assignRole` (around line 260)

The existing handler does an `UPDATE users SET role = ?` followed by
`auditLog(...)`. Wrap both:

```ts
db.transaction(() => {
  db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
    .run(role, now, userId, tenantId);
  auditLog(db, tenantId, userId, actorId, "role_change", oldRole, role, reason ?? null);
})();
```

### 3. `elevateKyc` (around line 293)

Same shape — wrap the UPDATE and the audit call together:

```ts
db.transaction(() => {
  db.prepare("UPDATE user_profiles SET kyc_tier = ?, updated_at = ? WHERE user_id = ? AND tenant_id = ?")
    .run(kyc_tier, now, userId, tenantId);
  auditLog(db, tenantId, userId, actorId, "kyc_elevation", oldTier, kyc_tier, evidence_ref ?? null);
})();
```

### 4. `registerFreelancer` (around line 324)

This handler is more complex — it inserts into `agents` and then updates
`user_profiles` to set `agent_id`. Both writes plus the audit go in one
transaction. The existing code already has a transactional intent but
spreads the writes; consolidate:

```ts
db.transaction(() => {
  db.prepare("INSERT INTO agents (...) VALUES (...)").run(...);
  db.prepare("UPDATE user_profiles SET agent_id = ?, ...").run(...);
  auditLog(db, tenantId, userId, actorId, "freelancer_registered", null, agentId, reg.country_code);
})();
```

### 5. `generateApiKey` (around line 400)

```ts
db.transaction(() => {
  db.prepare("UPDATE user_profiles SET api_key_hash = ?, api_key_prefix = ?, updated_at = ? WHERE user_id = ? AND tenant_id = ?")
    .run(hash, prefix, now, userId, tenantId);
  auditLog(db, tenantId, userId, actorId, "api_key_generated", null, prefix, null);
})();
```

---

## File: src/routes/provisioning.ts

### 6. `createAccount` (around line 75)

This handler ALREADY has a `db.transaction(()=>{...})()` block — but the
`commercialAuditLog(...)` call sits OUTSIDE it. Move the audit call inside:

```ts
// BEFORE
db.transaction(() => {
  db.prepare(`INSERT INTO accounts ...`).run(...);
  const sync = syncBadge(db, body.tenant_id, accountId, { policy_state: null });
  badgeSignature = sync.signature;
})();
commercialAuditLog(db, body.tenant_id, actorId, "account", accountId,
  "create", null, JSON.stringify({ tier, status: "pilot" }),
  { api_key_prefix: apiKey.prefix, pilot_days: pilotDays });

// AFTER
db.transaction(() => {
  db.prepare(`INSERT INTO accounts ...`).run(...);
  const sync = syncBadge(db, body.tenant_id, accountId, { policy_state: null });
  badgeSignature = sync.signature;
  commercialAuditLog(db, body.tenant_id, actorId, "account", accountId,
    "create", null, JSON.stringify({ tier, status: "pilot" }),
    { api_key_prefix: apiKey.prefix, pilot_days: pilotDays });
})();
```

### 7. `changeTier` (around line 145)

No existing transaction — add one wrapping both the UPDATE and the audit:

```ts
const now = new Date().toISOString();
db.transaction(() => {
  db.prepare("UPDATE accounts SET tier = ?, updated_at = ? WHERE id = ?")
    .run(tier, now, id);
  commercialAuditLog(db, current.tenant_id, actorId, "account", id,
    "tier_change", current.tier, tier);
})();
res.json({ id, tier, previous_tier: current.tier, changed_at: now });
```

### 8. `rotateApiKey` (around line 175)

Same pattern:

```ts
const now = new Date().toISOString();
db.transaction(() => {
  db.prepare(`UPDATE accounts SET api_key_hash = ?, api_key_prefix = ?, api_key_rotated_at = ?, updated_at = ? WHERE id = ?`)
    .run(apiKey.hash, apiKey.prefix, now, now, id);
  commercialAuditLog(db, current.tenant_id, actorId, "account", id,
    "key_rotation", current.api_key_prefix, apiKey.prefix);
})();
res.status(200).json({ ... });
```

---

## File: src/routes/insurance.ts

### 9. `bindPolicy` (around line 168)

Same pattern as `provisioning.ts createAccount` — existing transaction,
audit call sits outside it. Move inside:

```ts
// BEFORE
db.transaction(() => {
  db.prepare(`INSERT INTO ai_insurance_warranties ...`).run(...);
  syncBadge(db, account.tenant_id, account.id, { policy_state: "ACTIVE" });
})();
commercialAuditLog(db, account.tenant_id, actorId, id, "bind", null,
  "ACTIVE", { account_id, coverage_ends_at });

// AFTER
db.transaction(() => {
  db.prepare(`INSERT INTO ai_insurance_warranties ...`).run(...);
  syncBadge(db, account.tenant_id, account.id, { policy_state: "ACTIVE" });
  commercialAuditLog(db, account.tenant_id, actorId, id, "bind", null,
    "ACTIVE", { account_id, coverage_ends_at });
})();
```

### 10. `attachExternal` (around line 250)

No existing transaction. Add one:

```ts
const now = new Date().toISOString();
db.transaction(() => {
  db.prepare(`UPDATE ai_insurance_warranties
              SET external_carrier_id = ?, external_policy_number = ?, updated_at = ?
              WHERE id = ?`)
    .run(external_carrier_id ?? warranty.external_carrier_id,
         external_policy_number ?? warranty.external_policy_number,
         now, id);
  commercialAuditLog(db, warranty.tenant_id, actorId, id, "external_attach",
    JSON.stringify({ carrier: warranty.external_carrier_id,
                     policy: warranty.external_policy_number }),
    JSON.stringify({ carrier: external_carrier_id ?? warranty.external_carrier_id,
                     policy: external_policy_number ?? warranty.external_policy_number }));
})();
res.json({ id, updated_at: now });
```

---

## Verification

After applying all 10 edits:

1. `npm test` — must still be 124+/124+ green. The audit coverage test from
   slice 5 also still passes (atomicity isn't detected by it; behavior is
   unchanged from its perspective).
2. Spot-check one handler under deliberate failure. In a REPL or scratch
   test, monkey-patch `auditLog` to throw, then call (for example)
   `assignRole`. Before this fix: the role update commits, no audit row,
   `auditLog`'s throw becomes the response. After this fix: the role
   update rolls back along with the (failed) audit insert, leaving DB
   in pre-call state. The response is still a 500 — but state is consistent.

## What this slice does NOT fix

- The audit helpers are still duplicated across files (Issue B). Slice 6c.
- The four open audit gaps (Issue G — `change-password`, `onboard`,
  `frameworks/:code`, `register`). Slice 6b.
- Engine-layer audit verification. Slice 6e.

## Edits not yet made

I'm intentionally NOT writing the final `.ts` files for this slice. Reason:
I have your compiled `.js` from the slice 5 review, not the `.ts` source.
The transformation above is identical in both languages, but the file I
would produce would carry `.js` artifacts (`__importDefault`, `(0, x.y)(...)`
shims) that don't belong in your `.ts` tree.

**Two options for you:**

1. Apply these 10 edits by hand to your `.ts` files. Each is a localized
   transformation — find the audit call, find the preceding mutation,
   wrap in `db.transaction(() => { ... })()`. The patterns above are
   line-for-line accurate.

2. Re-upload `src/routes/users.ts`, `src/routes/provisioning.ts`, and
   `src/routes/insurance.ts` as `.ts` sources. I'll produce real diffs.

Option 1 is faster if you trust the pattern; option 2 is safer if you'd
rather have me do the surgery and you review the diff. I'd suggest option 2
for `insurance.ts` (which has the most subtle case in `bindPolicy` with
the `syncBadge` call inside the existing transaction) and option 1 is
fine for the simpler files.
