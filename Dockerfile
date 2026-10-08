# LivePulse production image (Phase 9.1).
#
# Multi-stage: the build stage carries the full toolchain (TypeScript,
# Prisma CLI, all dependencies) and compiles src/ -> dist/; the runtime
# stage ships only compiled output plus production dependencies and runs
# as a non-root user.
#
# No secrets: configuration arrives exclusively via runtime environment
# variables (see docker-compose.prod.yml + .env.prod.example). The image
# contains no .env, no credentials, no source TypeScript, no dev tooling.
#
# Prisma: the generated client is produced in the build stage
# (`prisma generate`, default output under node_modules/.prisma) and
# carried into the runtime image. Migrations are NOT run on container
# startup — the operator applies them explicitly with
# `prisma migrate deploy` (documented in README / docs).

# ---------------------------------------------------------------------------
# Stage 1: install everything, generate Prisma client, compile TypeScript.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS build

# pnpm pinned to the version declared in package.json packageManager.
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate

WORKDIR /app

# Manifests first for better layer caching.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Prisma schema first: client generation is needed before compile and runtime.
COPY prisma ./prisma
RUN pnpm exec prisma generate

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

# ---------------------------------------------------------------------------
# Stage 2: minimal runtime — compiled output + production deps only.
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime

# Prisma query-engine support on musl (Alpine).
RUN apk add --no-cache libc6-compat openssl

ENV NODE_ENV=production

WORKDIR /app

# Production dependencies only (devDependencies excluded). The lockfile keeps
# this reproducible: same pnpm + same lockfile = same tree.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack prepare pnpm@12.5.1 --activate \
  && pnpm install --prod --frozen-lockfile \
  && pnpm store prune \
  && rm -rf /root/.cache /root/.local/share/pnpm \
  && chown -R node:node /app

# Generate the Prisma client into this stage's own (pnpm-layout) store.
# The CLI is fetched transiently and pinned to the locked version — it never
# becomes a runtime dependency and `package.json`/lockfile are untouched.
# (Copying the artifact from the build stage is not stable: pnpm isolates it
# inside a version-and-peer-hashed store path that differs between full and
# prod installs.)
COPY prisma ./prisma
RUN pnpm dlx prisma@6.19.3 generate --schema ./prisma/schema.prisma \
  && rm -rf /root/.cache /root/.local/share/pnpm \
  && chown -R node:node /app

# Compiled application (plain JS — no TypeScript, no tsx at runtime).
COPY --from=build /app/dist ./dist
# Schema + migrations for operator reference (e.g. host-side
# `prisma migrate deploy`). The container never migrates on boot.
COPY --from=build --chown=node:node /app/prisma ./prisma

EXPOSE 3000

USER node

# Liveness only, mirroring GET /health semantics (no PG/Redis dependency).
# Uses the Node 22 built-in fetch — no curl/wget in the image.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
