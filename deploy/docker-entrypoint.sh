#!/usr/bin/env bash
#
# docker-entrypoint.sh
#
# Container entrypoint. Orchestrates the boot sequence for a SQLite +
# Litestream + Node app on Fly.
#
# Sequence:
#   1. If /data/caas.db doesn't exist (fresh machine, e.g. first deploy
#      or after a volume swap), attempt `litestream restore` to pull
#      the latest snapshot from S3. If no remote snapshot exists either
#      (very first deploy ever, or restore disabled), proceed with an
#      empty DB — the app's migration step on boot will create the schema.
#   2. Exec `litestream replicate -exec "node dist/index.js"`.
#      This is the standard Litestream supervisor pattern: Litestream
#      becomes the parent of the Node process, replicates the SQLite WAL
#      to S3 in the background, and forwards signals (SIGTERM, SIGINT)
#      to Node for graceful shutdown.
#
# Why `exec`:
#   Replaces the shell with litestream in the process tree, so tini's
#   PID-1 signal forwarding reaches litestream directly (not via a shell
#   middleman that would swallow signals). Without `exec`, SIGTERM from
#   Fly's deploy/restart machinery would kill the shell but leave Node
#   running until the kernel SIGKILLs it on container teardown.
#
# Why no `set -e` at the top:
#   Litestream restore can legitimately fail (no remote snapshot exists
#   yet on first-ever deploy). We handle that case explicitly with an `||`
#   below and continue. `set -e` would convert the recoverable error into
#   a container crash.
#
# Required env vars (must be set via `fly secrets set`):
#   LITESTREAM_ACCESS_KEY_ID       — AWS-compatible access key
#   LITESTREAM_SECRET_ACCESS_KEY   — AWS-compatible secret key
#   LITESTREAM_BUCKET              — S3 bucket name (or "" to disable replication)
#   LITESTREAM_REGION              — S3 region (e.g. us-east-1) or R2/B2 endpoint config
#
# Plus the app's own secrets (JWT_*, HMAC_*, etc.) which Node reads from env.

set -u   # unset variable references are errors. Do NOT add -e (see above).

DB_PATH="/data/caas.db"

echo "[entrypoint] boot at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── Restore from Litestream if the local DB is missing ────────────────────────
#
# Replication is OPTIONAL. If LITESTREAM_BUCKET is empty or unset, we skip
# the restore entirely — useful for ephemeral test environments or for the
# very first deploy before S3 is configured. The app will then start with
# whatever is (or isn't) in /data/caas.db.

if [ -n "${LITESTREAM_BUCKET:-}" ]; then
  if [ ! -f "$DB_PATH" ]; then
    echo "[entrypoint] no local DB at $DB_PATH; attempting Litestream restore..."
    # -if-replica-exists: don't error if there's no remote snapshot yet
    #                     (first deploy ever, or fresh bucket).
    # -if-db-not-exists:  don't error if local DB exists (defense in depth;
    #                     we already checked, but this guards against races).
    litestream restore \
        -config /etc/litestream.yml \
        -if-replica-exists \
        -if-db-not-exists \
        "$DB_PATH" \
      || echo "[entrypoint] no remote snapshot to restore from; starting fresh"
  else
    echo "[entrypoint] existing DB found at $DB_PATH; skipping restore"
  fi
else
  echo "[entrypoint] LITESTREAM_BUCKET not set; running without replication"
  echo "[entrypoint] WARNING: no backup will be taken. Configure S3 before going to production."
fi

# ─── Hand off to Litestream replicate-with-exec ────────────────────────────────
#
# When LITESTREAM_BUCKET is unset we still need to start Node, but without
# Litestream's supervision. Branch accordingly.

if [ -n "${LITESTREAM_BUCKET:-}" ]; then
  echo "[entrypoint] starting Node under Litestream replication"
  exec litestream replicate \
      -config /etc/litestream.yml \
      -exec "node dist/index.js"
else
  echo "[entrypoint] starting Node without replication (LITESTREAM_BUCKET unset)"
  exec node dist/index.js
fi
