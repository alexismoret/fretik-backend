# syntax=docker/dockerfile:1.7
#
# @fretik/ai — production image
#
# Built from the monorepo root (context = `backend/`). Build with:
#   docker build -f packages/ai/Dockerfile -t fretik-ai:dev .
#
# Published to GHCR by .github/workflows/ai.yml and pulled by Dokploy,
# which injects PORT + all secrets at runtime — that's why no EXPOSE
# / ENV PORT lives here.
#
# See packages/api/Dockerfile for the rationale behind this pattern
# (Bun monorepo + workspace symlinks + no --production).

FROM oven/bun:1 AS base
WORKDIR /app

# ---- install: workspace graph, hoisted layout -----------------------
FROM base AS install
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/ai/package.json packages/ai/
COPY packages/providers/package.json packages/providers/
COPY .husky .husky
# `bun install` applies patchedDependencies (the ews-javascript-api XML-escaping
# fix used by the Exchange provider) — the patch file must be present beforehand.
COPY patches patches
ENV CI=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --filter '@fretik/ai' --filter '@fretik/shared' --filter '@fretik/providers'

# ---- release: extend install (symlinks stay in place) ---------------
FROM install AS release
ENV NODE_ENV=production

# poppler-utils for PDF parsing in shared/file-parsing. `sharp` ships
# its own prebuilt libvips binaries — no extra apt deps for it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Source last so source-only changes don't invalidate the install
# layer. The .dockerignore strips tests/, evals/, and .eval-runs/
# from the build context so they never end up in the image.
COPY packages/shared packages/shared
COPY packages/providers packages/providers
COPY packages/ai packages/ai

RUN rm -rf .husky

USER bun

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8083)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "packages/ai/src/index.ts"]
