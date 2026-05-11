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

FROM oven/bun:1 AS base
WORKDIR /app

# ---- install (production deps only) ---------------------------------
FROM base AS install
COPY package.json bun.lock tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/ai/package.json packages/ai/
ENV CI=true
RUN bun install --frozen-lockfile --production

# ---- release --------------------------------------------------------
FROM base AS release
ENV NODE_ENV=production

# poppler-utils for PDF parsing in shared/file-parsing. `sharp` ships
# its own prebuilt libvips binaries so no extra apt deps for it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY --from=install /app/node_modules ./node_modules
COPY --from=install /app/package.json /app/bun.lock /app/tsconfig.base.json ./
COPY --from=install /app/packages/shared/package.json packages/shared/
COPY --from=install /app/packages/api/package.json packages/api/
COPY --from=install /app/packages/ai/package.json packages/ai/

# Source last so it doesn't bust the install layer. The .dockerignore
# strips tests/, evals/, and .eval-runs/ from the build context so they
# never end up in the image.
COPY packages/shared packages/shared
COPY packages/ai packages/ai

USER bun

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD bun -e "fetch('http://localhost:'+(process.env.PORT||8083)+'/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

ENTRYPOINT ["bun", "run", "packages/ai/src/index.ts"]
