# syntax=docker/dockerfile:1.7
#
# CaaS-Lite production Dockerfile.
#
# Two-stage build:
#   1. `builder` — full Node + Debian + Python/g++/make for native modules
#      (better-sqlite3, argon2). Runs npm ci, tsc, and prunes dev deps.
#   2. `runtime` — slim Debian + Node + tini + litestream binary. Copies
#      only the built dist/ and production node_modules from `builder`.
#      Runs as non-root user `node` (uid 1000) on port 8080.
#
# Why bookworm-slim and not alpine:
#   better-sqlite3 and argon2 are native modules. Alpine uses musl libc;
#   the prebuilt binaries these packages ship target glibc. Building from
#   source on Alpine works but is fragile (occasional silent corruption on
#   prebuilds, runtime SIGSEGVs that only manifest under load). Debian
#   bookworm-slim is ~30MB larger and removes the entire class of issue.
#
# Why tini:
#   Node as PID 1 doesn't reap zombies and handles SIGTERM oddly when not
#   using its own signal-handling library. tini takes PID 1, forwards
#   signals cleanly, and reaps zombies. Standard practice for containerised
#   Node apps; not optional for production.
#
# Litestream:
#   Embedded in the runtime stage (not a sidecar) per Fly's single-process
#   machine model. The entrypoint script handles `litestream restore` on
#   boot and `litestream replicate` for ongoing replication.

# ============================================================================
# Stage 1: builder
# ============================================================================
FROM node:20-bookworm AS builder

WORKDIR /app

# Install build toolchain for native modules. python3 is for node-gyp;
# build-essential pulls in gcc, g++, make, libc6-dev. The --no-install-recommends
# avoids dragging in docs and locale data we don't need at build time.
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        build-essential \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests first for better layer caching. Subsequent edits
# to source files won't re-run `npm ci` unless the manifests change.
COPY package.json package-lock.json* ./

# npm ci enforces the lockfile exactly. If no lockfile exists yet, this
# will fail with a clear error — generate one with `npm install` locally
# and commit it.
#
# --no-audit and --no-fund cut noise from the install output without
# affecting what gets installed.
RUN npm ci --no-audit --no-fund

# Copy source and TypeScript config. tsconfig.json drives the build;
# package.json's `scripts.build` runs `tsc` which reads it.
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/. Fails the build on any tsc error, which is
# the correct behavior for production — we don't want a silently-broken
# image landing on Fly.
RUN npm run build

# Prune devDependencies after the build. The runtime stage will copy only
# what's left in node_modules — keeping the image small and excluding
# things like ts-node, jest, eslint that have no business in production.
RUN npm prune --omit=dev

# ============================================================================
# Stage 2: runtime
# ============================================================================
FROM node:20-bookworm-slim AS runtime

# Install runtime-only dependencies:
#   - tini: PID 1 / signal-handling (see header).
#   - ca-certificates: for HTTPS calls (Litestream → S3, any outbound HTTPS).
#   - wget: used by the Dockerfile HEALTHCHECK directive and as a debug aid.
#   - sqlite3: convenience CLI for ad-hoc debugging via `fly ssh console`.
#     Adds ~3MB and is worth its weight the first time you need to inspect
#     the DB without leaving the machine.
RUN apt-get update && apt-get install -y --no-install-recommends \
        tini \
        ca-certificates \
        wget \
        sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Install Litestream from the official release. Pinned to a specific
# version — bumping requires a deliberate change here, not a silent
# "whatever's latest." Check https://github.com/benbjohnson/litestream/releases
# before upgrading and verify the SHA256 if you care (we don't pin SHA
# because the release URLs are content-addressed by tag).
ARG LITESTREAM_VERSION=0.3.13
RUN wget -qO /tmp/litestream.deb \
      "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-amd64.deb" \
    && dpkg -i /tmp/litestream.deb \
    && rm /tmp/litestream.deb

WORKDIR /app

# Copy built artifacts and pruned node_modules from the builder stage.
# Ownership set to node:node so the runtime user can read them; doing this
# via --chown avoids a separate `RUN chown` layer.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist          ./dist
COPY --from=builder --chown=node:node /app/package.json  ./package.json

# Litestream config + entrypoint. The entrypoint orchestrates:
#   1. litestream restore (idempotent: pulls latest snapshot if local DB missing)
#   2. exec litestream replicate -exec "node dist/index.js"
#      (runs the Node process under Litestream's supervision; SIGTERM
#       propagates through tini → litestream → node.)
COPY --chown=node:node deploy/litestream.yml      /etc/litestream.yml
COPY --chown=node:node deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The data directory holds the SQLite database file(s). On Fly this is
# mounted from a persistent volume (see fly.toml [mounts]); locally it's
# whatever you bind-mount in docker-compose.yml. Owned by node:node so
# the runtime user can write to it.
RUN mkdir -p /data && chown node:node /data

# Drop privileges. The `node` user is provided by the official Node image
# (uid/gid 1000). Running as root in a container is a security footgun;
# the only thing we lose by dropping is the ability to write outside
# /app and /data, which we don't need to do.
USER node

# Convention: app listens on $PORT, defaulting to 8080. Fly sets PORT
# automatically based on fly.toml; this default matches the [http_service]
# internal_port we'll declare there.
ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Docker-level healthcheck. Fly will ALSO healthcheck via fly.toml (the
# authoritative source for production). This one is here so that:
#   - `docker ps` shows healthy/unhealthy locally.
#   - Any non-Fly platform that respects HEALTHCHECK works out of the box.
#
# Failure mode: wget exits non-zero, container marked unhealthy, `docker
# compose` restart policy (if any) kicks in.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget --quiet --tries=1 --spider "http://localhost:${PORT}/healthz" || exit 1

# tini as PID 1 ensures clean signal forwarding to the entrypoint, which
# in turn manages litestream and the Node process. The `-g` flag tells
# tini to forward signals to the entire process group (so SIGTERM reaches
# the Node child via litestream).
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/docker-entrypoint.sh"]
