FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Build the @basefyio/geo workspace package
FROM base AS geo
COPY packages/geo /geo
RUN cd /geo && npm ci && npm run build

FROM base AS deps
COPY apps/website/package.json ./
# Remove the local file: dependency before installing — we'll link it manually
RUN sed -i '/"@basefyio\/geo"/d' package.json && npm install --ignore-scripts
# Copy built geo package into node_modules
COPY --from=geo /geo ./node_modules/@basefyio/geo

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY apps/website/ .

ARG NEXT_PUBLIC_SITE_URL=https://basefyio.com
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}

ARG NEXT_PUBLIC_GA_MEASUREMENT_ID=G-7Q90HE6Z02
ENV NEXT_PUBLIC_GA_MEASUREMENT_ID=${NEXT_PUBLIC_GA_MEASUREMENT_ID}

RUN npm run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
