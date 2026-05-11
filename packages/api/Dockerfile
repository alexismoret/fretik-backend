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
#
# Pattern is the community-recommended Bun-monorepo Dockerfile (Bun
# discussion #12763, hbinduni/bun-hono-react-monorepo, dev.to/is_bik):
#   - `--filter` scopes the install graph to api + shared
#   - NO `--production`: known to break workspaces in Docker — see
#     Bun #21949, #12252, #8033, #15102, #25804, #28278
#   - `FROM install AS release`: extending the install stage keeps the
#     `node_modules/@fretik/shared → ../../packages/shared` symlink
#     intact by construction, so we don't depend on cross-stage symlink
#     fidelity in BuildKit

FROM oven/bun:1 AS base
WORKDIR /app

# ---- install: workspace graph, hoisted layout -----------------------
FROM base AS install
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/ai/package.json packages/ai/
# The root `prepare` script literally execs `node .husky/install.mjs`,
# so the file must be present. The script self-exits on CI=true, so
# husky binaries are not installed. .husky is removed below before
# the image is finalized.
COPY .husky .husky
ENV CI=true
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --filter '@fretik/api' --filter '@fretik/shared'

# ---- release: extend install (symlinks stay in place) ---------------
FROM install AS release
ENV NODE_ENV=production

# poppler-utils is required by node-poppler (PDF parsing inside
# @fretik/shared/file-parsing).
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Source last so source-only changes don't invalidate the install
# layer. `@fretik/shared` ships as workspace source (including
# drizzle/ migrations loaded by runMigrationsWithLock at boot).
COPY packages/shared packages/shared
COPY packages/api packages/api

# Husky was only needed to satisfy the root `prepare` during install.
RUN rm -rf .husky

USER bun

# Healthcheck reads PORT from the runtime env (Dokploy injects it).
# The `|| 8080` fallback only matters for local `docker run` without
# -e PORT.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "packages/api/src/index.ts"]
