# syntax=docker/dockerfile:1
# Build context is the repo root (see docker-compose.yml).

FROM node:20-alpine AS base
# openssl + libc6-compat are required by Prisma's query engine on Alpine/musl
# (schema generator targets linux-musl-openssl-3.0.x).
RUN apk add --no-cache openssl libc6-compat
RUN corepack enable
WORKDIR /app

# ── Install workspace deps ────────────────────────────────
# platform-api depends on the @basefyio/data-engine workspace package, so its
# manifest must be present for pnpm to resolve the `workspace:*` dependency.
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/platform-api/package.json apps/platform-api/
COPY packages/data-engine/package.json packages/data-engine/
RUN pnpm install --filter @basefyio/platform-api... --frozen-lockfile

# ── Build ─────────────────────────────────────────────────
# `...` builds the dependency closure (data-engine) before platform-api, in
# topological order. platform-api's prebuild runs `prisma generate`.
FROM deps AS build
COPY apps/platform-api apps/platform-api
COPY packages/data-engine packages/data-engine
RUN pnpm --filter @basefyio/platform-api... run build

# ── Runtime ───────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
# pnpm's isolated linker resolves platform-api's direct deps (e.g. @nestjs/core)
# through this per-package symlink tree into the root .pnpm store — without it,
# `node dist/main.js` throws MODULE_NOT_FOUND despite the store being present.
COPY --from=build /app/apps/platform-api/node_modules ./apps/platform-api/node_modules
COPY --from=build /app/apps/platform-api/dist ./apps/platform-api/dist
COPY --from=build /app/apps/platform-api/package.json ./apps/platform-api/
# data-engine's compiled output backs the workspace symlink in node_modules.
COPY --from=build /app/packages/data-engine/dist ./packages/data-engine/dist
COPY --from=build /app/packages/data-engine/package.json ./packages/data-engine/
WORKDIR /app/apps/platform-api
EXPOSE 4000
CMD ["node", "dist/main.js"]
