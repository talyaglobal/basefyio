# syntax=docker/dockerfile:1
# Build context is the repo root (see docker-compose.yml).

FROM node:20-alpine AS base
RUN corepack enable
WORKDIR /app

# ── Install workspace deps ────────────────────────────────
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/platform-api/package.json apps/platform-api/
RUN pnpm install --filter @basefyio/platform-api... --frozen-lockfile

# ── Build ─────────────────────────────────────────────────
FROM deps AS build
COPY apps/platform-api apps/platform-api
RUN pnpm --filter @basefyio/platform-api build

# ── Runtime ───────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/platform-api/dist ./apps/platform-api/dist
COPY --from=build /app/apps/platform-api/package.json ./apps/platform-api/
WORKDIR /app/apps/platform-api
EXPOSE 4000
CMD ["node", "dist/main.js"]
