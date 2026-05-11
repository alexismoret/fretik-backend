# syntax=docker/dockerfile:1.7
#
# @fretik/api — production image
#
# Built from the monorepo root (context = `backend/`). Build with:
#   docker build -f packages/api/Dockerfile -t fretik-api:dev .
#
# Published to GHCR by .github/workflows/api.yml and pulled by Dokploy,
# which injects PORT + all secrets at runtime — that's why no EXPOSE
# / ENV PORT lives here.

FROM oven/bun:1 AS base
WORKDIR /app

# ---- install (production deps only) ---------------------------------
# Mirrors Bun's recommended monorepo Dockerfile pattern: copy lockfile
# + every workspace package.json BEFORE source so the install layer is
# reused on source-only changes. `--production` strips devDeps so the
# release image stays lean (no oxlint / prettier / tsgo binaries).
FROM base AS install
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/ai/package.json packages/ai/
# The root `prepare` script runs `node .husky/install.mjs` — copy the
# folder so node can resolve it. The script self-exits on CI=true, so
# husky binaries are NOT installed. .husky stays inside this install
# stage and never gets copied to the release stage below.
COPY .husky .husky
ENV CI=true
RUN bun install --frozen-lockfile --production

# ---- release --------------------------------------------------------
FROM base AS release
ENV NODE_ENV=production

# poppler-utils is required by node-poppler (PDF parsing).
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Production node_modules from the install stage…
COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/package.json /app/bun.lock /app/tsconfig.base.json ./
COPY --from=install /app/packages/shared/package.json packages/shared/
COPY --from=install /app/packages/api/package.json packages/api/
COPY --from=install /app/packages/ai/package.json packages/ai/

# …then the actual source. `@fretik/shared` is consumed as a workspace
# link (workspace:*), so its full source must ship — including the
# drizzle/ migrations folder that runMigrationsWithLock loads at boot.
COPY packages/shared packages/shared
COPY packages/api packages/api

USER bun

# Healthcheck runs inside the container — it must read PORT from the
# runtime env (Dokploy sets it). The `|| 8080` fallback only matters
# for local `docker run` without -e PORT.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "packages/api/src/index.ts"]
