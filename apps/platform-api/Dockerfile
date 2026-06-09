FROM node:20-alpine AS base
RUN apk add --no-cache openssl postgresql16-client
WORKDIR /app

# Build the data-engine package first
FROM base AS data-engine-build
WORKDIR /packages/data-engine
COPY packages/data-engine/package.json packages/data-engine/package-lock.json* ./
RUN npm install
COPY packages/data-engine/ .
RUN npm run build

FROM base AS deps
# Copy built data-engine to /packages/data-engine
COPY --from=data-engine-build /packages/data-engine /packages/data-engine
# Copy platform-api package files (only package.json, not lock file)
COPY apps/platform-api/package.json ./
# Fix the local dependency path for Docker context and install fresh
RUN sed -i 's|file:../../packages/data-engine|file:/packages/data-engine|g' package.json
RUN npm install

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /packages/data-engine /packages/data-engine
COPY apps/platform-api/ .
RUN sed -i 's|file:../../packages/data-engine|file:/packages/data-engine|g' package.json
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /packages/data-engine /packages/data-engine
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

EXPOSE 4000
CMD ["sh", "-c", "npx prisma db push --skip-generate --accept-data-loss && node dist/main"]
