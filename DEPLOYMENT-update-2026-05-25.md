# DEPLOYMENT.md updates — 25 May 2026

This file is **not a replacement** for `DEPLOYMENT.md`. It contains two things to merge into the existing file:

1. A new top-level section **"Session: 25 May 2026 — First production login proven"**, intended to go immediately before the existing `## File index` (or after `## Open decisions (deferred)`, whichever you prefer).
2. **Surgical corrections** to existing sections that this session proved out-of-date or wrong. Each correction is marked with the section it belongs in and the exact text to replace.

Merge by section, not by overwriting the file. The existing file is well-organised; this is supplementary.

---

## Section to ADD: "Session: 25 May 2026 — First production login proven"

Paste this as a new top-level section. Suggested position: after `## Open decisions (deferred)` and before `## File index`.

---

````markdown
## Session: 25 May 2026 — First production login proven

This was the session where the dashboard was confirmed reachable end-to-end by a real browser, signed in by a real user, against the production Fly deployment. The four-item plan that opened the session is fully closed.

What follows is what we learned, what changed, and what we deliberately left for another day.

### Outcome

- Browser successfully loaded the dashboard at `https://caas-lite.fly.dev/dashboard`.
- New daily-driver admin (`odeijsom`) signed in via the production login flow.
- argon2 hashing pipeline (hash on bootstrap, verify on login) confirmed working against the live `auth.js` route.
- Tenant `tenant-aitw-001` now has a proper `accounts` row backing it.
- Tenant API key generated, hashed, and stored on the `accounts` row; plaintext captured in Bitwarden for handoff to the integration team.

### Production state of record (changes since previous entry)

- **Tenant `tenant-aitw-001`** now has an `accounts` row. Tier `GROWTH`, status `active`. The previous "no `accounts` row exists, yet `aitw-ops` works" mystery is resolved: the API was happy without it because the relationship between `users.tenant_id` and `accounts.tenant_id` is by convention, not by FK. The row exists now so that the tenant API key has a place to live.
- **Three users in `tenant-aitw-001`:**
  - `aitw-ops` — superadmin, break-glass only, password unchanged.
  - `odeijsom` — daily admin (`Executive` / `client_executive`), email `odeijsom@gmail.com`, used for day-to-day operations. Password in Bitwarden.
  - `akasiodei` — integration test user (`Partner` / `client_partner`), email `akasiodeisom@gmail.com`. Password in Bitwarden, intended for handoff to the integration team. Lower-privilege on purpose, so the integration team's code is forced to test against a non-admin user.
- **Stale `display_name` on the `aitw-ops` profile** was corrected from `Akasi Odei Som` (seed data) to `AITW Superadmin`. `kyc_tier` left at `basic`.
- **Code state at last deploy:**
  - Branch: `master`
  - HEAD: `a1e698a` ("Use window.location.origin as default server URL")
  - Plus one `fly secrets set` that does not produce a commit: `RATE_LIMIT_ALLOW_UNKNOWN_TIER=true`.

### Configuration changes that ship as code

`public/index.html` — three lines changed:

- The Server URL input now defaults to empty with placeholder `leave blank to use this server` instead of being hardcoded to a specific hostname.
- The JS state default for `server` is now `window.location.origin` instead of a hardcoded URL string.
- The `doLogin` handler now falls back to `window.location.origin` when the input is empty: `state.server = document.getElementById('login-server').value.trim().replace(/\/$/, '') || window.location.origin;`

Net effect: the dashboard now talks to whichever server served it. Local dev, Fly, custom domain, staging — all work without code changes. The next hostname migration costs zero edits.

### Configuration changes that live as Fly secrets

- `RATE_LIMIT_ALLOW_UNKNOWN_TIER=true` — set as a defensive measure. Background: the rate limiter returns `tier: "PAY_AS_YOU_GO", limit: 0` (a sentinel) when the `X-CaaS-Tier` header is missing AND `allowUnknownTier` is false. This sentinel is dressed up as a real 429 response and is genuinely indistinguishable from an actual rate limit being exceeded. Setting this to `true` makes missing-header requests default to PAY_AS_YOU_GO's actual 60 req/min config. **This is a workaround, not a fix.** The proper fix is on the slice 7 hardening tracker (see below).

### Lessons (what would have saved hours)

**The dashboard is at `/dashboard`, not `/`.** Browsing to `https://caas-lite.fly.dev/` returns the rate limiter's limit-0 JSON, not a 404, because `/` is not a registered route AND not in `bypassPaths`, so unmatched-path traffic gets rate-limited before it can hit the 404 handler. The dashboard is mounted explicitly via `app.get("/dashboard", ...)` at app.js:625-627. Document the URL up front; don't expect anyone to guess.

**The "not listening" warning during `fly deploy` is a false positive** when the Node app takes a few seconds to boot (Litestream restore + queue handlers + cron scheduling all happen before `app.listen`). The deploy summary will say:

```
WARNING The app is not listening on the expected address and will not be reachable by fly-proxy.
```

Ignore the warning. Verify with `fly logs` — look for the line `CaaS-Lite listening` (with `port: 8080`). If you see it within ~5 seconds of the deploy summary, the app is fine. The first reflex of "the deploy failed" is wrong.

**The tenant registry table is named `accounts`, not `tenants`.** Earlier plans (and the old Bootstrap section in this file) referenced a `tenants` table. That table does not exist. `accounts` has the `tenant_id` (unique), the `tier` (CHECK-constrained to LITE/GROWTH/ENTERPRISE), the `status`, and the `api_key_hash`. Any tenant that lacks an `accounts` row is in a half-state — users in it can probably log in (because the schema relationship is by convention) but any feature that reads `tier` or `api_key_*` will fail or get defaults.

**argon2 (0.44.0) defaults are sufficient.** No custom `memoryCost` / `timeCost` / `type` parameters needed when bootstrapping. The hash format encodes its own parameters; `argon2.verify` reads them out of the stored hash, so any defaults you use will verify correctly. The existing Bootstrap section's use of `bcryptjs` is wrong — see corrections below.

**`X-CaaS-Tier` is a load-bearing header** for every non-bypassed endpoint. The dashboard's `api()` function sends `X-CaaS-Tier: GROWTH` on authenticated requests but the `doLogin` fetch doesn't (login is in `bypassPaths`, so it doesn't matter for login itself). For the integration team: their request library must add this header to every authenticated call. Until the limit-0 fix lands, omitting the header on a rate-limited endpoint returns a misleading 429 with `limit: 0`.

**Bash heredoc paste-traps.** When pasting a multi-line script into `cat > file << 'EOF'`, do not include instruction-to-the-human placeholder lines like `[paste the entire script above here]` inside the heredoc — they get saved as literal content and Node tries to execute them. The fix is to send the actual script text, not a placeholder. Mentioned because we hit this twice in one session.

**Interactive password prompts in Node are stdin-sensitive.** Three pitfalls hit during the user bootstrap, all worth noting:

1. **Hidden input shows nothing.** No characters, no asterisks, no cursor movement. Looks frozen. Type your password anyway. The most common reason "it's frozen" is "it's working and you can't tell."
2. **Separate `readline.createInterface()` calls for back-to-back prompts will sometimes exit silently between the two.** The second call gets a stdin that's already paused/ended. Use one interface for the whole script.
3. **`process.stdin.setRawMode` is unreliable in some SSH contexts.** Detect `process.stdin.isTTY` and refuse to run if false; print the TTY state at startup so silent exits become diagnosable.

**Password-at-bash-prompt risk.** If the script exits prematurely and the user types their password at the next bash prompt, bash interprets it as a command and the password ends up in `~/.bash_history`. `!` in a password additionally trips bash's history-expansion (`event not found`). When this happens: `history -c && history -w && cat /dev/null > ~/.bash_history && unset HISTFILE && clear && reset` to wipe, and treat the password as burned — pick a fresh one.

**Browser autofill is a silent identity-mixing risk.** When the dashboard loaded successfully after the URL change, the browser's password manager autofilled `test-user-02` in the Username field — a stored credential from an earlier session that no longer exists. If signed in without checking, the audit log would have recorded actions under the wrong identity. Always clear autofilled username/password before signing into a freshly-deployed dashboard, especially when account names are short and similar to test names that may already be in the password manager.

### Bugs found this session (recorded for the hardening tracker)

These are all real bugs we deliberately did not fix tonight because they are not blocking. They go to the slice 7 hardening tracker, not into the open-decisions list above.

1. **`limit: 0` sentinel masquerading as a 429.** When the rate limiter returns a "tier could not be resolved" rejection, the response is HTTP 429 with `{"error":"Too Many Requests","tier":"PAY_AS_YOU_GO","limit":0}`. Semantically wrong: the request didn't exceed any rate limit; the header was missing or invalid. Correct behaviour: HTTP 400 with `{"error":"Tier header required"}` or fall back to PAY_AS_YOU_GO's real 60/min config. Location: `src/middleware/rateLimiter.ts`, function `evaluateRateLimit`, lines 219-230 of the compiled `dist/middleware/rateLimiter.js`.

2. **Unmatched routes get 429'd instead of 404'd.** Because the rate limiter runs before the 404 handler, any unmatched path (including the root `/`) hits the limiter first. Combined with bug 1, this produces a confusing JSON rate-limit response for what should be a clean 404. Fix is order-of-middleware: either move the rate limiter to run after route matching, or have it skip paths that won't match any route. The simpler fix is to add a root-route handler that either redirects to `/dashboard` or returns a clean 404.

3. **`bypassPaths` covers the dashboard route but not its static assets.** Currently the dashboard is a single self-contained HTML file (CSS and JS inline), so this isn't biting. The moment someone splits CSS or JS into separate files served by `express.static`, those requests will hit the rate limiter without `X-CaaS-Tier` and fail. Either move `express.static` (which currently isn't even registered — `/app/dist/app.js` uses explicit `res.sendFile` calls, not `express.static`) ahead of the rate limiter, or add the static asset paths to `bypassPaths`.

4. **Dashboard ribbon label is hardcoded.** The top ribbon shows `CLIENT PLANE · client partner · tenant-aitw-001` regardless of the logged-in user's actual `plane_role`. `odeijsom` has `plane_role: client_executive` but the ribbon still says `client partner`. Cosmetic, but misleading; should reflect the live role.

5. **Stale defaults in `index.html`'s JS state.** The state object still initializes with `tenant: 'tenant-demo-001'`. Harmless because the Tenant ID input doesn't display this default, but stale code is stale code.

6. **`aitw-ops` profile's `kyc_tier`** remains `basic`. The superadmin should presumably be `enhanced` (or whatever the highest tier is). Cosmetic; no functional impact. One `UPDATE user_profiles SET kyc_tier='enhanced' WHERE user_id='f77db9d1-...'` to fix.

7. **No API-key auth code path verified end-to-end.** The `accounts` table has `api_key_hash` columns, the bootstrap script generated and stored a key, the comment in the schema says "API key for SDK auth," and the type system handles it. None of this proves a request authenticating via API key actually works in production today. A grep for `api_key_hash` usage in `/app/dist` came back narrow. Worth a 30-minute spike to find or build the verify path before the integration team relies on the key.

8. **`api.aitwcloud.com` mystery resolved retroactively.** Earlier in this session there was confusion about what was answering at this hostname before we pointed it deliberately. Turns out it WAS pointed at this Fly app the whole time (the existing DEPLOYMENT.md confirms the A/AAAA records in Cloudflare). The "Too Many Requests" responses we were seeing from `api.aitwcloud.com` were just this same Fly app, behind that hostname, hitting the limit-0 bug above. Not a separate mystery; one bug seen from two URLs.

### Required documentation gap (for the integration team handoff)

When the integration team arrives, they will need to know — and do not yet have written down anywhere — at minimum:

- The dashboard URL (`/dashboard`, not `/`).
- `X-CaaS-Tier: GROWTH` (or their tenant's actual tier) must be sent on every authenticated request. Until the limit-0 fix lands, omitting it produces a misleading 429.
- The full `bypassPaths` list, so they know which endpoints don't need the tier header: `/health`, `/health/db`, `/health/performance`, `/healthz`, `/readyz`, `/metrics`, `/dashboard`, `/register`, `/api/v1/auth`, `/api/v1/admin`, `/api/v1/fx`.
- Their tenant ID, integration test username, password (for the user-password auth path), and tenant API key (for the SDK auth path).
- A note that the API key auth path is schema-supported but not verified end-to-end as of 25 May 2026, so first contact may be password-auth via `/api/v1/auth/login` and the key is for later.

This is API documentation territory and belongs in OpenAPI / Postman / similar — see Group 1 item 1 of the original outstanding-work list. Until then, an email summary captures the minimum.

### Bootstrap recipe — the way it actually worked

The Bootstrap section earlier in this file describes the procedure. Two corrections from doing it for real this session:

1. **The hashing algorithm is argon2, not bcrypt.** The existing Bootstrap section uses `bcryptjs`. Any hash produced by bcryptjs will NOT verify against `argon2.verify` and login will fail with "Invalid credentials" even though the password is "correct." See § Bootstrap the first user (corrected) below.
2. **You must also insert an `accounts` row.** A user without a backing `accounts` row in their tenant is in a half-state — login works but tier-related lookups don't. The corrected recipe does this in the same transaction.

For future bootstraps, the working pattern is a single Node script (CommonJS, `.cjs` extension) that:

- Prompts for both passwords interactively via a single shared `readline.createInterface`.
- Refuses to run if `process.stdin.isTTY` is false (so non-TTY contexts fail loudly instead of silently).
- Prints `[admin received, N chars]`-style confirmations between prompts so the user knows the first password landed before the second prompt appears.
- Hashes with argon2 defaults.
- Generates the tenant API key from `crypto.randomBytes(24).toString('base64url')`, hashes it, prints the raw key ONCE.
- Wraps all inserts (`accounts`, `users`, `user_profiles`) in a single `db.transaction(() => { ... })` so partial failures roll back cleanly.
- Lives in `/data/` during the run (the only writable directory in the production volume), and is `rm`'d immediately afterwards.

The script is not committed to the repo because it has to be re-created with current-schema awareness each time it runs.

### Things deferred to next session

In priority order:

1. **Fix the limit-0 sentinel.** Either return 400 with a sensible error or fall back to PAY_AS_YOU_GO's real config. While in `rateLimiter.ts`, also clean up the misleading `tier: "PAY_AS_YOU_GO"` in the rejection response (the request didn't have a tier; reporting PAY_AS_YOU_GO is a lie).
2. **Fix the root-route 429.** Add `app.get('/', (_req, res) => res.redirect('/dashboard'))` or similar.
3. **Re-verify the API key auth flow.** Find or build the verify path. Document for the integration team.
4. **Configure `api.aitwcloud.com` as the primary serving URL.** Cert exists (per Cloudflare records section above), the dashboard now uses `window.location.origin` so no code change needed; just verify TLS handshake works end-to-end and update any external link copy that still says `caas-lite.fly.dev`.
5. **Audit other tables for stale seed data.** Found one stale row on `user_profiles` this session; there may be similar leftovers elsewhere.
````

---

## Surgical corrections to existing sections

### Correction 1 — § Bootstrap the first user (the bcrypt issue)

**Section:** `## Bootstrap the first user` → `### Generate the password and hash locally`

**Replace** the existing code block:

```powershell
# 1. Pick a strong password and put it in pw.txt (gitignored / will be deleted)
#    Use a password manager to generate it.

# 2. Hash it with bcrypt
node -e "console.log(require('bcryptjs').hashSync(require('fs').readFileSync('pw.txt','utf8').trim(), 12))" > hash.txt

# 3. Generate the user UUID
node -e "console.log(require('crypto').randomUUID())" > userid.txt
```

**With:**

```powershell
# 1. Pick a strong password in a password manager. Don't write it to disk.

# 2. Hash it with argon2 (the algorithm the live auth path actually uses).
#    This script reads the password from stdin so it never appears on the
#    command line or in shell history.
node -e "
  const argon2 = require('argon2');
  process.stdin.on('data', async d => {
    console.log(await argon2.hash(d.toString().trim()));
    process.exit(0);
  });
"
# (paste the password, press Enter, copy the resulting $argon2id$... hash)

# 3. Generate the user ID
node -e "console.log('usr_' + require('crypto').randomBytes(12).toString('hex'))"
```

Then **add this paragraph immediately after** the corrected code block:

```markdown
> **_Note (2026-05-25):_** the previous version of this section instructed
> hashing with `bcryptjs`. The live auth route uses `argon2.verify` — a
> bcrypt hash will not verify and login will fail with "Invalid credentials"
> even though the password matches what the user typed. Confirmed by direct
> inspection of `/app/dist/routes/auth.js` (references to `argon2.verify`)
> and the presence of `argon2` 0.44.0 in `node_modules`. If a previous
> bootstrap attempt produced a bcrypt hash and the user can't log in, that's
> almost certainly why.
```

### Correction 2 — § Bootstrap the first user, the INSERT step

**Section:** `## Bootstrap the first user` → `### Insert the user`

**Add this paragraph immediately before** the `INSERT INTO users (...` SQL block:

```markdown
> **_Note (2026-05-25):_** a user without a matching row in the `accounts`
> table is in a functional half-state — login works because the
> `users.tenant_id` → `accounts.tenant_id` relationship is by convention
> (no FK), but features that read `tier`, `status`, or `api_key_hash` will
> fail or fall back to defaults. The recipe below should be paired with an
> `INSERT INTO accounts` for the same tenant. The schema of `accounts` is:
>
> ```
> id, tenant_id (UNIQUE), tier (LITE|GROWTH|ENTERPRISE),
> status (pilot|active|suspended|churned),
> api_key_hash, api_key_prefix (both NOT NULL),
> display_name (NOT NULL), contact_email,
> created_at, updated_at
> ```
>
> Generate the API key the same way the live system would
> (`'aitw_' + crypto.randomBytes(24).toString('base64url')`), hash it with
> argon2, store only the hash and the first 12 chars as the prefix.
```

### Correction 3 — § Production state of record → § Bootstrap production user

**Section:** `## Production state of record` → `### Bootstrap production user`

**At the end of that subsection** (after the existing `Note (2026-05-22)` block about `permission_level`), **add:**

```markdown
> **_Note (2026-05-25):_** `aitw-ops` remains the superadmin and is used
> for break-glass only. A second daily-driver admin (`odeijsom`,
> `client_executive`, email `odeijsom@gmail.com`) and an integration test
> user (`akasiodei`, `client_partner`, email `akasiodeisom@gmail.com`) were
> created this session and now exist in the same tenant. Passwords are in
> Bitwarden. The `accounts` row backing `tenant-aitw-001` was also created
> this session — it had not existed before, and `aitw-ops` had been
> operating against a tenant with no `accounts` record.
```

### Correction 4 — § Code state at last deploy

**Section:** `## Production state of record` → `### Code state at last deploy`

**Replace** the existing block:

```markdown
- Branch: `master`
- HEAD: `d1d81b7` (URL change)
- Preceded by `92ab0e5` (Dockerfile static-file COPY + `/readyz`)
- Preceded by `ce6cd18` (CSP env-var refactor)
- All pushed to `origin`
```

**With:**

```markdown
- Branch: `master`
- HEAD: `a1e698a` (`Use window.location.origin as default server URL`)
- Preceded by `d1d81b7` (earlier URL change — superseded by HEAD)
- Preceded by `92ab0e5` (Dockerfile static-file COPY + `/readyz`)
- Preceded by `ce6cd18` (CSP env-var refactor)
- All pushed to `origin`
- Plus one Fly secret with no commit: `RATE_LIMIT_ALLOW_UNKNOWN_TIER=true`
  (set via `fly secrets set` 25 May 2026 as a defensive workaround for
  the limit-0 sentinel bug — see Session: 25 May 2026 for details)
```

### Correction 5 — § Common failures (add a new entry)

**Section:** `## Common failures`

**Add** this new subsection after `### Machine boots but Litestream replicates nothing`:

````markdown
### Browser shows `{"error":"Too Many Requests","limit":0}` for every request

**Symptom:** Loading any page in the browser — including the dashboard, the root URL, anything — returns a JSON rate-limit response with `tier: "PAY_AS_YOU_GO"` and `limit: 0`. The HTML never loads.

**Most likely cause:** The path you're requesting is not in `bypassPaths` AND the browser isn't sending the `X-CaaS-Tier` header AND the `RATE_LIMIT_ALLOW_UNKNOWN_TIER` env var is unset (or set to anything other than the literal string `true`). The rate limiter's `resolveTier()` returns null, and the rejection path returns the limit-0 sentinel.

**Two fixes, increasing order of effort:**

1. **You're loading the wrong URL.** The dashboard is at `/dashboard`, not `/`. The root path `/` is not registered as a route and falls to the rate limiter before reaching the 404 handler. Browse to `https://caas-lite.fly.dev/dashboard` instead.
2. **The dashboard URL IS being loaded but `RATE_LIMIT_ALLOW_UNKNOWN_TIER` is unset.** Set it: `fly secrets set RATE_LIMIT_ALLOW_UNKNOWN_TIER=true -a caas-lite`. Fly will restart the machine; the next page load will work.

**Diagnosis:** Run this from inside the VM, replacing the password with a wrong one:

```
node -e "
const http = require('http');
const data = JSON.stringify({username:'whoever',password:'wrong',tenant_id:'whatever'});
const req = http.request({host:'localhost',port:8080,path:'/api/v1/auth/login',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}},res=>{console.log('STATUS:',res.statusCode);let b='';res.on('data',c=>b+=c);res.on('end',()=>console.log('BODY:',b))});req.write(data);req.end();
"
```

If you get STATUS 401 with "Invalid credentials", the auth path works and the issue is on the page-serving side (URL or `allowUnknownTier`). If you get STATUS 429 with limit:0, something is wrong with the bypass logic itself and the limit-0 sentinel needs the proper fix (see slice 7 hardening tracker).
````

### Correction 6 — § Open decisions (deferred), point 3

**Section:** `## Open decisions (deferred)`, item 3 about self-registration.

**Append to** item 3:

```markdown
   As of 25 May 2026, `/register` is gated behind `ENABLE_PUBLIC_REGISTRATION` (default unset = disabled) and falls through to the Step 13 catch-all 404 when disabled. So the route is safely closed today — the open decision is about when and how to open it, not about closing it.
```

---

## Merge checklist

When you do the merge:

- [ ] Add the new `## Session: 25 May 2026 — First production login proven` section.
- [ ] Apply Correction 1 (bcrypt → argon2 in Bootstrap recipe).
- [ ] Apply Correction 2 (note about `accounts` row needed alongside `users` insert).
- [ ] Apply Correction 3 (note about `odeijsom` and `akasiodei` in Production state of record).
- [ ] Apply Correction 4 (HEAD commit hash + Fly secret note in Code state).
- [ ] Apply Correction 5 (new Common Failures entry for the limit-0 bug).
- [ ] Apply Correction 6 (Open decisions clarification on `/register`).
- [ ] Commit with a message like `docs: deployment notes from first-login session`.
- [ ] Push.

Nothing in this update changes runtime behaviour. It is all documentation.
