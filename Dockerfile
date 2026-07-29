# No `# syntax=` directive: it would fetch a mutable frontend image at build
# time, and nothing here needs a feature beyond the built-in Dockerfile syntax.
#
# The base image is pinned by immutable digest, not by a floating tag. Update it
# through the cadence in docs/technical/supply-chain-security.md and record the
# replacement digest in the same commit.
ARG NODE_IMAGE=node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

# ---------------------------------------------------------------------------
# Install stage: lockfile-immutable install of the whole workspace.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS install
WORKDIR /workspace
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/queue/package.json packages/queue/package.json
RUN npm ci

# ---------------------------------------------------------------------------
# Build stage: compile packages, the worker and the standalone web server.
# ---------------------------------------------------------------------------
FROM install AS build
COPY . .
RUN npm run build

# ---------------------------------------------------------------------------
# Prune stage: reduce the installed tree to production dependencies only.
# ---------------------------------------------------------------------------
FROM build AS prune
RUN npm ci --omit=dev

# ---------------------------------------------------------------------------
# Runtime base: no build toolchain, no package manager work, non-root by default.
# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime-base
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false
WORKDIR /app
RUN chown node:node /app
USER node

# ---------------------------------------------------------------------------
# Web runtime: Next.js standalone output only.
# ---------------------------------------------------------------------------
FROM runtime-base AS web
COPY --from=build --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static
RUN node --eval "const { writeFileSync } = require('node:fs'); writeFileSync('/app/build-info.json', JSON.stringify({ service: 'web', node: process.versions.node, openssl: process.versions.openssl }) + '\n');"
ENV PORT=3000 \
    HOSTNAME=0.0.0.0
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node --eval "fetch('http://127.0.0.1:' + (process.env.PORT ?? 3000) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));"
CMD ["node", "apps/web/server.js"]

# ---------------------------------------------------------------------------
# Worker runtime: production dependencies, compiled output and the media probe.
#
# ffmpeg lives only in the worker image. The web image never decodes media, so
# it does not carry the media parser attack surface or its patch obligations.
# ---------------------------------------------------------------------------
FROM runtime-base AS worker
USER root
RUN apt-get update \
  && apt-get install --no-install-recommends --yes ffmpeg \
  && rm -rf /var/lib/apt/lists/*
USER node
COPY --from=prune --chown=node:node /workspace/package.json ./package.json
COPY --from=prune --chown=node:node /workspace/node_modules ./node_modules
COPY --from=prune --chown=node:node /workspace/apps/worker/package.json ./apps/worker/package.json
COPY --from=prune --chown=node:node /workspace/apps/worker/dist ./apps/worker/dist
COPY --from=prune --chown=node:node /workspace/packages/config/package.json ./packages/config/package.json
COPY --from=prune --chown=node:node /workspace/packages/config/dist ./packages/config/dist
COPY --from=prune --chown=node:node /workspace/packages/db/package.json ./packages/db/package.json
COPY --from=prune --chown=node:node /workspace/packages/db/dist ./packages/db/dist
COPY --from=prune --chown=node:node /workspace/packages/domain/package.json ./packages/domain/package.json
COPY --from=prune --chown=node:node /workspace/packages/domain/dist ./packages/domain/dist
COPY --from=prune --chown=node:node /workspace/packages/observability/package.json ./packages/observability/package.json
COPY --from=prune --chown=node:node /workspace/packages/observability/dist ./packages/observability/dist
COPY --from=prune --chown=node:node /workspace/packages/queue/package.json ./packages/queue/package.json
COPY --from=prune --chown=node:node /workspace/packages/queue/dist ./packages/queue/dist
# Record the exact runtime and media-tool versions that shipped in this image so
# a scan finding can be matched to a running container without guessing.
RUN set -eux; \
    printf '{"service":"worker","node":"%s","openssl":"%s","ffmpeg":"%s","ffprobe":"%s"}\n' \
      "$(node --print 'process.versions.node')" \
      "$(node --print 'process.versions.openssl')" \
      "$(ffmpeg -version | head -n 1 | cut -d ' ' -f 3)" \
      "$(ffprobe -version | head -n 1 | cut -d ' ' -f 3)" \
      > /app/build-info.json
ENV WORKER_HEALTH_PORT=3001
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node --eval "fetch('http://127.0.0.1:' + (process.env.WORKER_HEALTH_PORT ?? 3001) + '/health/live').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1));"
CMD ["node", "apps/worker/dist/index.js"]
