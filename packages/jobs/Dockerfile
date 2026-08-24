# syntax=docker/dockerfile:1.7
#
# @fretik/jobs — production image
#
# Built from the monorepo root (context = `backend/`). Build with:
#   docker build -f packages/jobs/Dockerfile -t fretik-jobs:dev .
#
# Same Bun-monorepo pattern as packages/api/Dockerfile (see the notes
# there): `--filter` scopes the install graph, no `--production`,
# `FROM install AS release` keeps workspace symlinks intact.

FROM oven/bun:1 AS base
WORKDIR /app

# ---- install: workspace graph, hoisted layout -----------------------
FROM base AS install
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/ai/package.json packages/ai/
COPY packages/providers/package.json packages/providers/
COPY packages/jobs/package.json packages/jobs/
# `bun install` validates every workspace declared in the root package.json,
# even ones this image doesn't build — its package.json must exist in the
# build context or it fails with "Workspace not found".
COPY packages/workflows/package.json packages/workflows/
COPY .husky .husky
COPY patches patches
ENV CI=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --filter '@fretik/jobs' --filter '@fretik/shared' --filter '@fretik/providers'

# ---- release: extend install (symlinks stay in place) ---------------
FROM install AS release
ENV NODE_ENV=production

# poppler-utils: the document-processing worker parses PDFs via
# node-poppler (@fretik/shared/services/file-extraction).
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Source last so source-only changes don't invalidate the install layer.
# @fretik/providers ships as workspace source: the mcp-refresh worker imports
# @fretik/providers/mcp, so a missing source dir would leave a dangling symlink
# and crash the process at boot.
COPY packages/shared packages/shared
COPY packages/providers packages/providers
COPY packages/jobs packages/jobs

RUN rm -rf .husky

USER bun

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8084)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "packages/jobs/src/index.ts"]
