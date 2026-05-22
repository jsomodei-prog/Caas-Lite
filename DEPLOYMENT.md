# CaaS-Lite Deployment

**Target:** Fly.io (v2 / machines platform), single primary region, SQLite + Litestream replication to S3-compatible storage.

**Audience:** anyone deploying this for the first time, anyone debugging a deploy that went wrong, anyone who inherits this in six months and needs to know what was decided and why.

---

## Production state of record

This section describes the current live deployment. Update it whenever the underlying facts change.

### Domain and DNS

- Apex domain: `aitwcloud.com`
- Registrar: Cloudflare (auto-renew ON)
- Registrant email: `jsomodei@gmail.com`
- DNS provider: Cloudflare
- API subdomain: `api.aitwcloud.com` → Fly app `caas-lite`
  - `A` record: `66.241.124.99`
  - `AAAA` record: `2a09:8280:1::118:c812:0`
  - Proxy status: **grey cloud (DNS only)** — not proxied
  - TLS: Let's Encrypt cert issued by Fly, ~2 months until renewal at time of writing
- Frontend subdomain: `app.aitwcloud.com` — **not yet set up** (see Open decisions)
- Frontend currently served at: `https://caas-lite.fly.dev/dashboard`

### Fly application

- App name: `caas-lite`
- Region: as configured in `fly.toml`
- Process: single web process, serves both API and static frontend from one Node container
- Health check: `/readyz` (added in commit `92ab0e5`)

### Backups

- Backup tool: Litestream
- Destination: Cloudflare R2 bucket `caas-lite-backups`
- Sync interval: 1s (continuous)
- Verified replicating at last check

### Bootstrap production user

The first Executive was created by direct DB insert (see § Bootstrap the first user). Recorded here for reference:

- Username: `aitw-ops`
- Tenant: `tenant-aitw-001`
- Role: `Executive`
- Permission level: `client_super_admin`
- UUID: `f77db9d1-3ef9-47c4-bd01-895e4bc3899e`
- Created at: `2026-05-21T14:50:22.585Z`
- Password: stored in Bitwarden (vault entry `aitw-ops production`)
- Password hash: stored in Bitwarden Notes on the same entry

### Code state at last deploy

- Branch: `master`
- HEAD: `d1d81b7` (URL change)
- Preceded by `92ab0e5` (Dockerfile static-file COPY + `/readyz`)
- Preceded by `ce6cd18` (CSP env-var refactor)
- All pushed to `origin`

---

## TL;DR — first-ever deploy

```bash
# 0. One-time prerequisites
fly auth login
fly auth whoami

# 1. Create the app (don't deploy yet; we need to configure first)
fly launch --no-deploy --name caas-lite --region ord --copy-config

# 2. Create the persistent volume for SQLite + Litestream
fly volumes create caas_data --region ord --size 3

# 3. Set required secrets (replace placeholders with real values)
fly secrets set \
  JWT_ACCESS_SECRET="$(openssl rand -hex 32)" \
  JWT_REFRESH_SECRET="$(openssl rand -hex 32)" \
  LITESTREAM_BUCKET=your-bucket-name \
  LITESTREAM_REGION=us-east-1 \
  LITESTREAM_ACCESS_KEY_ID=AKIA... \
  LITESTREAM_SECRET_ACCESS_KEY=...

# 4. Deploy
fly deploy

# 5. Verify
fly status
curl https://caas-lite.fly.dev/healthz
```

If step 4 fails, see § Common failures below.

---

## Architecture decisions worth knowing

These are the choices baked into `Dockerfile`, `fly.toml`, `litestream.yml`, and `docker-entrypoint.sh`. Knowing them keeps you from accidentally undoing them.

**One machine, one region, one SQLite file.** Fly's autoscaling and multi-region are not safe with SQLite — two machines writing to the same file (even via a shared volume, which Fly doesn't support anyway) corrupts the WAL. The app is pinned to `min_machines_running = 1` and `auto_stop_machines = false`. If you ever need horizontal scale, the right answer is migrating off SQLite, not loosening these settings.

**Litestream is supervisor, Node is supervised.** The container's entrypoint exec's `litestream replicate -exec "node dist/index.js"`. This means Litestream is the parent process of Node, replicates the WAL continuously, and forwards signals. If Litestream crashes, Node crashes with it; if Node crashes, Litestream stays up to drain the WAL before exit. This is the [recommended Litestream pattern](https://litestream.io/guides/) — not a sidecar.

**Restore on cold boot is automatic and conditional.** On every container start, the entrypoint checks for `/data/caas.db`. If absent (fresh machine, e.g. after a volume swap or first deploy), it runs `litestream restore` to pull the latest snapshot from S3. If present, it skips restore (the volume's local copy is authoritative). The restore step is idempotent and tolerates a missing remote — first-ever deploy succeeds with an empty DB.

**`tini` is PID 1.** Without it, Node-as-PID-1 mishandles SIGTERM and doesn't reap zombies. With it, `fly deploy` and `fly machine stop` produce clean shutdowns instead of SIGKILLs at the `kill_timeout` boundary.

**Non-root runtime user.** The container runs as `node` (uid 1000), not root. The `/data` directory is `chown`'d to `node:node` at image build time so the runtime user can write there. If you ever need to debug as root, `fly ssh console` lets you in as root regardless of the runtime user.

---

## Secrets

All secrets MUST be set via `fly secrets set`. They arrive in the container as env vars and are NOT visible in `fly.toml`, the Dockerfile, or any log output that respects the convention.

### Required (app refuses to boot without them)

| Secret | Used by | Generate with |
|---|---|---|
| `JWT_ACCESS_SECRET` | `src/routes/auth.ts` | `openssl rand -hex 32` |
| `JWT_REFRESH_SECRET` | `src/routes/auth.ts` | `openssl rand -hex 32` |

### Required for Litestream replication (entrypoint warns loudly if unset)

| Secret | Notes |
|---|---|
| `LITESTREAM_BUCKET` | S3 bucket name (just the name, no `s3://` prefix). Bucket should be in a region close to the Fly primary region for low replication latency. |
| `LITESTREAM_REGION` | e.g. `us-east-1`. For non-AWS providers (R2, B2), see § S3-compatible providers below. |
| `LITESTREAM_ACCESS_KEY_ID` | IAM credentials. The user/role needs only `s3:GetObject`, `s3:PutObject`, `s3:ListBucket`, `s3:DeleteObject` on the bucket. Tighter scope than full S3 access. |
| `LITESTREAM_SECRET_ACCESS_KEY` | matching secret |

### Required for frontend hosting and CORS (added in slice-7 deploy)

| Secret | Notes |
|---|---|
| `FRONTEND_ORIGIN` | Origin the frontend is served from; used in CSP and link generation. Currently `https://api.aitwcloud.com` (until app subdomain exists). |
| `API_ORIGIN` | Canonical API origin; used in CSP `connect-src` and CORS allow logic. Currently `https://api.aitwcloud.com`. |
| `CORS_ORIGINS` | Comma-separated list of origins allowed for CORS. Currently `https://api.aitwcloud.com,https://caas-lite.fly.dev`. |

### Application-level secrets (likely required, depending on which routes you use)

Search the source for `process.env.` to enumerate. As of slice 7, the routes that read env include the badge HMAC secret (`badge-secrets.ts`), the commercial engine HMAC (`commercialEngine.ts:loadHmacSecret`), and the rate-limiting config. Set whatever those need.

### Rotating a secret

```bash
fly secrets set JWT_ACCESS_SECRET="$(openssl rand -hex 32)"
```

This triggers a deploy. The new secret takes effect when the new machine becomes healthy. **JWT secret rotation invalidates all existing access tokens** — clients re-auth. Plan rotations during low-traffic windows or accept the auth-storm.

### Verifying what is actually set

```bash
fly secrets list -a caas-lite
```

Shows names and digests, not values. Compare against the tables above; missing entries are the most common cause of a machine that boots but immediately exits.

### Local secrets hygiene

Several files get created on the operator's laptop during bootstrap and secret rotation. None of them belong in git, and none of them belong on disk after the operation is done:

- `insert_user.sql` — contains the bcrypt hash used to bootstrap the first user
- `pw.txt` — plaintext password scratch file
- `hash.js` — bcrypt hashing helper script
- `hash.txt` / `userid.txt` — intermediate outputs from the bootstrap recipe
- `genids.js` — UUID generation helper

PowerShell cleanup at end of session:

```powershell
Remove-Item insert_user.sql, pw.txt, hash.js, hash.txt, userid.txt, genids.js -ErrorAction SilentlyContinue
Test-Path insert_user.sql, pw.txt, hash.js, hash.txt, userid.txt, genids.js
```

All `Test-Path` results must be `False`.

---

## Custom-domain setup

This section records how `api.aitwcloud.com` was wired up, so it can be repeated for `app.aitwcloud.com` or any other subdomain.

### Prerequisites

- Domain registered at Cloudflare with DNS hosted there.
- Fly app deployed and reachable at its `*.fly.dev` hostname.
- `flyctl` authenticated.

### Steps

1. Tell Fly about the hostname so it can request a cert:

   ```bash
   fly certs add api.aitwcloud.com -a caas-lite
   fly certs show api.aitwcloud.com -a caas-lite
   ```

   The `show` output prints the exact `A`, `AAAA`, and (optionally) `_acme-challenge` records Fly needs.

2. In Cloudflare DNS, add the records Fly printed:
   - `A` record: name `api`, value = Fly IPv4, **Proxy status: DNS only (grey cloud)**.
   - `AAAA` record: name `api`, value = Fly IPv6, **Proxy status: DNS only (grey cloud)**.
   - If Fly asks for an `_acme-challenge` CNAME, add it as well.

3. Wait for DNS propagation, then re-run `fly certs show`. The cert status should move to `Ready`.

4. Update Fly secrets that reference the origin (`FRONTEND_ORIGIN`, `API_ORIGIN`, `CORS_ORIGINS`) and redeploy.

5. Smoke test:

   ```bash
   curl -v https://api.aitwcloud.com/readyz
   ```

### Notes on proxied (orange-cloud) mode

We are currently running grey-cloud. Switching to orange-cloud would add Cloudflare's CDN, WAF, and DDoS protections in front of Fly, but introduces a second TLS hop and changes the IP the app sees for clients. This decision is deferred (see Open decisions).

---

## Bootstrap the first user

There is no UI for creating the first Executive. The procedure is intentional but undocumented elsewhere. Use this exact sequence.

### What you will need

- `flyctl` authenticated.
- A throwaway working directory on your laptop.
- Node.js locally for hashing.
- Bitwarden (or equivalent) open to record the password and hash.

### Generate the password and hash locally

```powershell
# 1. Pick a strong password and put it in pw.txt (gitignored / will be deleted)
#    Use a password manager to generate it.

# 2. Hash it with bcrypt
node -e "console.log(require('bcryptjs').hashSync(require('fs').readFileSync('pw.txt','utf8').trim(), 12))" > hash.txt

# 3. Generate the user UUID
node -e "console.log(require('crypto').randomUUID())" > userid.txt
```

Store the password and the bcrypt hash in Bitwarden **now**, before continuing. Hash goes in the Notes field of the same vault entry.

### SSH into the running app and insert

```bash
fly ssh console -a caas-lite
```

Inside the container:

```sh
cd /data                                  # or wherever the SQLite DB lives
sqlite3 caas.db
```

Then in `sqlite3` (adjust table/column names to match the actual schema if they have drifted):

```sql
INSERT INTO users (
  id, username, tenant_id, role, permission_level,
  password_hash, created_at, is_active
) VALUES (
  '<paste UUID from userid.txt>',
  'aitw-ops',
  'tenant-aitw-001',
  'Executive',
  'client_super_admin',
  '<paste bcrypt hash here>',
  strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  1
);
.quit
```

Exit the container.

### Verify

From your laptop:

1. Browse to the frontend.
2. Log in with `aitw-ops` and the password from Bitwarden.
3. Confirm Executive-level UI is visible.

### Clean up immediately

On your laptop, delete every artifact that touched the password or hash. See the cleanup commands in § Secrets → Local secrets hygiene. All `Test-Path` results must be `False` before the session ends.

---

## Common failures

### `fly deploy` fails during the build

**Symptom:** Build logs show `npm ci` or `tsc` failing.

**Most likely cause:** lockfile out of sync, or a TypeScript error landed.

**Fix:** Reproduce locally with `docker compose build`. If it fails the same way locally, fix it there first. Don't push fixes blind to Fly — the remote builder has the same toolchain but slower iteration loop.

### `fly deploy` succeeds but the machine never becomes healthy

**Symptom:** `fly status` shows `up` but the machine cycles between healthy/unhealthy or stays at `starting`.

**Most likely causes:**

1. **`/healthz` returns 503.** The app started but the DB ping fails. Check `fly logs` for the actual error. Common cause: migrations didn't run, so the SQLite file is empty / lacks the tables that `SELECT 1` works against. (We use `SELECT 1` specifically to avoid this, but if your migrations leave the DB in a half-state, even `SELECT 1` can fail.)
2. **App listens on the wrong port.** `fly.toml` sets `internal_port = 8080` and the Dockerfile sets `PORT=8080`. If `src/index.ts` hardcodes a different port (e.g. `app.listen(3000)`) and ignores `process.env.PORT`, the healthcheck hits a closed port. Fix by changing the source to honor `PORT`.
3. **Litestream restore took too long.** `grace_period = 30s` covers most cases, but a large remote snapshot (GB+) can exceed it. Bump `grace_period` in `fly.toml` if your snapshots are large.

**Diagnosis:** `fly ssh console`, then `curl localhost:8080/healthz` from inside the machine. Bypasses the load balancer and tells you what Node itself returns.

### Machine boots but Litestream replicates nothing

**Symptom:** `fly logs` shows the app running but no `litestream ... synced` lines.

**Most likely cause:** `LITESTREAM_BUCKET` is unset and the entrypoint took the no-replication branch. Check `fly secrets list` — if `LITESTREAM_BUCKET` isn't there, set it and redeploy.

**Or:** S3 credentials are wrong. Litestream's first sync attempt will log a clear error in `fly logs`. Most commonly: bucket exists in a different region than `LITESTREAM_REGION` claims.

### Volume runs out of space

**Symptom:** `SQLITE_FULL` errors in `fly logs`, OR `fly volumes list` shows >80% used.

**Fix:** `fly volumes extend <volume-id> --size <new-gb>`. Volumes can grow but not shrink — start conservatively (3 GB) and extend as needed.

### "I made a bad deploy and need to roll back"

```bash
fly releases                       # list releases
fly releases rollback <version>    # roll back to a previous release
```

Rollback is a redeploy under the hood — it re-runs the entrypoint, which means Litestream restore happens again, which means **the DB state after rollback is whatever's in the volume**, not whatever was in the bad release. If the bad release wrote data you now want gone, see § Disaster recovery.

---

## Disaster recovery

### Restoring from a Litestream snapshot

Litestream snapshots are the source of truth for "the DB at a past point in time." To restore:

```bash
# From your local machine, with AWS CLI and the same credentials Litestream uses
litestream snapshots -config litestream.yml /data/caas.db
# Lists available snapshots with timestamps. Pick one.

litestream restore -config litestream.yml \
  -timestamp 2026-05-15T12:00:00Z \
  -o restored.db \
  /data/caas.db
# Restores the DB as of the specified time to ./restored.db
```

You'd then `fly ssh sftp` the restored file onto the volume, replacing `/data/caas.db`. **Do this with the app stopped** (`fly scale count 0`, restore the file, `fly scale count 1`) to avoid clobbering live writes.

### Periodic restore test (recommended)

Once a quarter, run a restore against a non-production bucket and `sqlite3 restored.db ".tables"` to confirm the schema is intact. A backup you've never tested is a backup you don't have.

### What Litestream does NOT protect against

- **Logical corruption.** A bad migration that drops a table is replicated faithfully; the snapshot from after the migration also lacks the table. Use point-in-time restore to roll back.
- **Bucket loss.** If your S3 bucket is deleted, Litestream can't restore. Mitigate by enabling versioning on the bucket and a separate offline backup.
- **Single-region failure.** Fly volumes are region-local; if the region goes down, the machine is unavailable until the region comes back. The volume's data is intact. For region-failover you'd need a second machine in a second region — incompatible with single-writer SQLite.

---

## S3-compatible providers (cost / latency notes)

The Litestream config and secrets work with any S3-compatible service. Realistic options:

| Provider | Pros | Cons | Endpoint config |
|---|---|---|---|
| **AWS S3** | Reliable, well-documented, integrates with everything. | Costs add up for high write volumes (PUT pricing). | Default; no `endpoint` line needed. |
| **Cloudflare R2** | Zero egress fees, S3-compatible. | Class A operations (PUTs) priced separately; check the math for your write volume. | Set `LITESTREAM_ENDPOINT=https://<account>.r2.cloudflarestorage.com` and uncomment the `endpoint:` line in `litestream.yml`. |
| **Backblaze B2** | Cheapest by a wide margin for storage; predictable pricing. | Latency higher than S3/R2. | Set `LITESTREAM_ENDPOINT=https://s3.<region>.backblazeb2.com`. |
| **MinIO (self-hosted)** | Full control; useful for air-gapped deployments. | You're now operating an S3, which is a real job. | Set `LITESTREAM_ENDPOINT=https://...` and possibly `force-path-style: true`. |

For CaaS-Lite's likely write volume (moderate), **R2 is the cheapest no-surprises choice**. Egress matters because restores download the snapshot. The current deployment uses R2 (bucket `caas-lite-backups`).

---

## Windows operational notes

The dev and ops laptop is Windows + PowerShell. These notes capture what bit us during deployment.

### Line endings

`git` on Windows defaults to converting `LF`↔`CRLF`. The Docker image is Linux. Shell scripts copied into the image must be `LF` only. Set:

```powershell
git config --global core.autocrlf input
```

and ensure any `.sh` files have a `.gitattributes` entry:

```
*.sh text eol=lf
```

### Quoting in PowerShell

PowerShell does not pass single-quoted strings to subprocesses the way bash does. When invoking `fly secrets set` with values that contain commas or special characters, prefer double quotes and escape inner quotes:

```powershell
fly secrets set CORS_ORIGINS="https://api.aitwcloud.com,https://caas-lite.fly.dev" -a caas-lite
```

### `curl` on Windows

`curl` in PowerShell is an alias for `Invoke-WebRequest`, which behaves differently from real curl. For diagnostic work, use `curl.exe` explicitly:

```powershell
curl.exe -v https://api.aitwcloud.com/readyz
```

### `Remove-Item` quirks

`Remove-Item` errors loudly if a file does not exist. When cleaning up potentially-absent secrets files, always pass `-ErrorAction SilentlyContinue` and follow with `Test-Path` to confirm.

### SQLite client locally

`sqlite3.exe` is not on `PATH` by default on Windows. For local DB inspection, either install it explicitly or use `fly ssh console` and run `sqlite3` inside the container, which is what we do for production.

---

## What this deployment story does NOT cover

Honest scope-limiting list — things that need separate work before this is truly "production":

- **User & Tenant Management (required module, not yet built).** This is the largest application-level gap. Specifically:
  - Bootstrap (first Executive) requires direct DB access — no UI for it, by design.
  - Subsequent user creation by an Executive requires the API endpoint directly; no admin UI exists for user CRUD.
  - Self-registration via `/register` works but has unclear security posture (see Open decisions).
  - No tenant management UI. Tenants are implicit strings (e.g. `tenant-aitw-001`) with no governance, no provisioning flow, no rename, no archive.
  - No user listing, editing, deactivation, role-change, or password-reset UI.
  - Audit log of user actions is captured in the DB but there is no UI to read it.
- **Observability:** the app has `prom-client` in dependencies, implying a Prometheus endpoint exists somewhere. This deployment doesn't configure scraping. Set up Grafana Cloud or Better Stack or similar; expose the metrics endpoint to whatever you choose.
- **Log aggregation:** Fly captures stdout/stderr and serves them via `fly logs`. For structured search across a deploy history, ship them to Logtail / Datadog / etc. — Fly has built-in log shippers.
- **Alerting:** healthcheck failures show in `fly logs` but don't page anyone. Set up an external monitor (UptimeRobot, Better Stack) hitting `/healthz` and paging your on-call.
- **CDN / caching:** Fly's edge handles TLS but doesn't cache. If you start serving public-ish endpoints (like the badge route from slice 7), front with Cloudflare or similar. (Related: orange-cloud decision in Open decisions.)
- **Rate limiting beyond what's in-app:** `express-rate-limit` runs in-process. For DDoS protection, you need a layer in front (Cloudflare WAF, Fly's own DDoS protection at the edge).
- **Staging environment:** the setup above creates one app. For staging, repeat with `--name caas-lite-staging` and a separate bucket. The configs are identical, the secrets aren't.
- **Restore drill:** we have backups, we have never restored from them in anger. The procedure in § Disaster recovery is documented but unrehearsed.

These are real production concerns. They're each their own ticket — this deployment is the foundation, not the ceiling.

---

## Open decisions (deferred)

Recorded here so they are not forgotten. None of these block current operation.

1. **`app.aitwcloud.com` frontend subdomain.** Deferred. Today the frontend is served from the same Fly app as the API at `caas-lite.fly.dev/dashboard`. Splitting it requires either a second Fly app or a routing rule, plus CSP and CORS updates.
2. **Cloudflare proxy mode (orange cloud) for `api.aitwcloud.com`.** Currently grey cloud. Switching gains CDN/WAF/DDoS; costs a TLS hop and client-IP indirection. Needs a small spike to validate Fly + Cloudflare proxied compatibility with the auth flow.
3. **Self-registration security posture.** `/register` currently works but the threat model has not been agreed. Options range from disabling it entirely, to invite-token only, to email-verified open registration scoped by tenant. Needs an explicit design conversation before any public launch.
4. **FX provider configuration.** Which provider, on what plan, configured when. Untouched.
5. **Slice 7 hardening tracker.** 21 open items remain, untouched in this session. User & Tenant Management is being added to that tracker as the 22nd.
6. **Business registration documents.** Need updating with the trademark-check lessons from the recent naming exercise.

---

## File index

| File | Purpose |
|---|---|
| `Dockerfile` | Two-stage build: native module compilation then slim runtime. |
| `.dockerignore` | Excludes secrets, local DBs, tests, etc. from the build context. |
| `docker-entrypoint.sh` | Orchestrates Litestream restore → replicate-with-exec → Node. |
| `litestream.yml` | Replication config: S3 destination, snapshot/retention tuning. |
| `fly.toml` | Fly app config: volume mount, healthcheck, single-machine pin. |
| `docker-compose.yml` | Local-dev convenience; not used in production. |
| `src/routes/health.ts` | The `/healthz` endpoint hit by Fly + Docker healthchecks. |

Edit history of these files belongs in git, not here. If you change something major (e.g. flip `auto_stop_machines` or change the Litestream provider), note it in the slice 7 hardening tracker so the decision survives turnover.
