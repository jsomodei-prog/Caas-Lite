# Badge HMAC Secret Rotation

**Audience:** operators managing CaaS deployments.
**Goal:** rotate `BADGE_HMAC_SECRET` with zero downtime and without breaking embedded trust badges on customer sites.

## Why rotation matters

Every trust badge embedded on a customer site holds a signature minted by this secret. If you rotate the secret without coordination, every embed becomes a 404 until the embedder refreshes their pinned signature. The rotation procedure below avoids that by accepting both old and new signatures during a cutover window.

## When to rotate

- **Scheduled:** at least annually, more often if your threat model demands it.
- **On suspicion of compromise:** immediately, with no cutover window (accept the customer-visible breakage as the cost of containment).
- **After offboarding anyone with `.env` access:** within 24 hours.

## Procedure

### Phase 1 — Pre-rotation (no customer impact yet)

1. **Generate the new secret.**
   ```bash
   openssl rand -hex 32
   ```
   Store this somewhere safe before proceeding. If you lose it between here and the next step, you can't recover badges signed with it.

2. **Confirm current state.**
   ```bash
   # On the host running docker-compose
   docker compose exec caas-api sh -c 'echo $BADGE_HMAC_SECRET_CURRENT' | head -c 8
   ```
   You should see the first 8 chars of the current secret. If you see nothing, the env var isn't set (or you're using the legacy `BADGE_HMAC_SECRET` instead).

3. **Notify embedders if you have a customer-facing channel.** Even with the cutover window, customers should refresh their pins. Tell them when and where.

### Phase 2 — Apply rotation

4. **Edit `.env` to set both secrets.**
   ```env
   BADGE_HMAC_SECRET_CURRENT=<the new secret you generated>
   BADGE_HMAC_SECRET_PREVIOUS=<the old secret that was in _CURRENT>
   ```
   The old value moves to `_PREVIOUS`. The new value goes into `_CURRENT`. Save the file.

5. **Restart the container.**
   ```bash
   docker compose restart caas-api
   ```
   On boot, the server detects the secret change and resigns every badge automatically. Watch the logs:
   ```bash
   docker compose logs caas-api | grep badge-rotation
   ```
   Expected output:
   ```
   [badge-rotation] secret rotation detected — resigning all badges
   [badge-rotation] rotation complete: N badges resigned
   ```
   If you see only `secret fingerprint established (first boot)`, the rotation table didn't have a prior entry — that's fine, treat it as the new baseline.

6. **Confirm the rotation in the audit log.**
   ```bash
   docker compose exec caas-api sqlite3 /data/caas_evidence.db \
     "SELECT COUNT(*) FROM commercial_audit_log WHERE action='secret_rotation';"
   ```
   Should match the badge count from the rotation log line.

### Phase 3 — Cutover window (1–7 days)

7. **Embedders refresh their pinned signatures.**
   The dashboard surfaces the new signature on every account read. Embedders pull and update.
   During this window:
   - Requests with the **new** signature succeed (200 OK).
   - Requests with the **old** signature succeed (200 OK) but include the response header `X-Badge-Signature-Stale: true`. Embedder client code can read this and prompt a refresh.
   - Requests with neither succeed nor return 404 (unchanged behaviour).

8. **Monitor stale-signature volume.**
   You can query the audit log or count requests in your reverse-proxy logs. When stale requests trend to zero, you're safe to remove the previous secret.

### Phase 4 — Cleanup (after cutover)

9. **Remove the previous secret from `.env`.**
   Either delete the line or set it to empty:
   ```env
   BADGE_HMAC_SECRET_PREVIOUS=
   ```

10. **Restart the container.**
    ```bash
    docker compose restart caas-api
    ```
    Boot detection won't trigger because `_CURRENT` hasn't changed. The only difference is the server now refuses signatures from the old secret. Any embedder who hasn't refreshed yet starts getting 404s.

## Recovery scenarios

### "I rotated and embedders are seeing 404s"

If you set `_CURRENT` without setting `_PREVIOUS` to the old value, there's no cutover window. Recovery:
1. Put the **old** secret back in `_CURRENT`. Put the new one in `_PREVIOUS`.
2. Restart. Boot detection treats this as another rotation — badges get re-signed with the old secret, which matches what embedders have pinned.
3. Start over from step 1 with both secrets correctly set.

### "I lost the new secret between generating it and restarting"

If the container hasn't restarted yet, you haven't actually rotated — just generate a different one and use that.

If it has restarted: every badge is now signed with the lost secret. New badges work (server still has the secret in env), but if you ever lose the env value too (host reboot? someone deleted `.env`?), you're stuck. **Fix immediately:** rotate again to a secret you control, treating this as Phase 2 above.

### "The audit log shows 0 badges resigned but I expected many"

Two possibilities:
1. There genuinely are no badges yet (fresh deployment, no accounts provisioned). Check `SELECT COUNT(*) FROM trust_badge_registry;`.
2. The fingerprint check thinks the secret hasn't changed. Check `SELECT * FROM secret_state;` — the `fingerprint` column should be `sha256(_CURRENT)`. If it matches what you expect for the new secret, you may have set the same secret twice by accident.

### "I want to skip the cutover window and force immediate cutover"

Rotate without setting `_PREVIOUS`. Every embedder gets 404 until they refresh. Use only when you suspect the old secret is compromised.

## What this does NOT protect against

- **Secret leak via `.env` file disclosure.** If your `.env` is exposed (committed to git, leaked in a backup, readable to too many users on the host), rotation is reactive at best. Use proper secret stores (Vault, AWS Secrets Manager) before scale.
- **Signature replay on a compromised badge endpoint.** Rotation invalidates *old* signatures, but if an attacker captures a current signature and replays it, they can read the badge state. Badge state is intentionally low-sensitivity (just `green/amber/red` + reason), so this is acceptable for the pilot. Don't store secrets that *would* be sensitive in the badge response.
- **Multi-instance race conditions.** If two app instances boot simultaneously after rotation, both detect the change and both resign. SQLite serialises writes so you won't get corruption, but you may see double audit log entries. Plan rotation restarts as rolling, one instance at a time.
