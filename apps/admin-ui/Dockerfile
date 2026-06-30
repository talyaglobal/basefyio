# syntax=docker/dockerfile:1
# Build context is the repo root (see docker-compose.yml).

FROM node:20-alpine AS base
# libc6-compat covers glibc-linked binaries some toolchains pull in on musl.
RUN apk add --no-cache libc6-compat
RUN corepack enable
WORKDIR /app

# ── Install workspace deps ────────────────────────────────
# admin-ui depends on the @basefyio/sdk workspace package, so its manifest must
# be present for pnpm to resolve the `workspace:*` dependency.
FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/admin-ui/package.json apps/admin-ui/
COPY packages/sdk/package.json packages/sdk/
RUN pnpm install --filter @basefyio/admin-ui... --frozen-lockfile

# ── Build ─────────────────────────────────────────────────
# Build the @basefyio/sdk dependency first (admin-ui imports its dist/), then
# produce the Next.js standalone server bundle.
FROM deps AS build
ENV NEXT_TELEMETRY_DISABLED=1
COPY apps/admin-ui apps/admin-ui
COPY packages/sdk packages/sdk
RUN pnpm --filter @basefyio/sdk run build
RUN pnpm --filter @basefyio/admin-ui run build

# ── Runtime ───────────────────────────────────────────────
# Next.js standalone output bundles a minimal server + traced node_modules.
# With outputFileTracingRoot set to the repo root (next.config.js), the bundle
# preserves the monorepo layout, so the entrypoint is apps/admin-ui/server.js
# and static assets must be placed alongside it under apps/admin-ui/.next.
FROM base AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=build /app/apps/admin-ui/.next/standalone ./
COPY --from=build /app/apps/admin-ui/.next/static ./apps/admin-ui/.next/static
# (No public/ directory in v0.1 — add a COPY for it here if one is introduced.)
EXPOSE 3000
CMD ["node", "apps/admin-ui/server.js"]
