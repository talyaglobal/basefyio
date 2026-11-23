FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Build the @basefyio/geo workspace package
FROM base AS geo
COPY packages/geo /geo
RUN cd /geo && npm ci && npm run build

FROM base AS deps
# Install exactly what package-lock.json pins (npm ci). `npm install` without the
# lockfile resolved the newest versions on every build, and a package published
# minutes earlier once failed the deploy with a registry 404.
# The stage mirrors the repo layout so the lockfile's "file:../../packages/geo"
# entry matches; npm links it, and the link is replaced by a real copy so the
# next stage does not carry a dangling symlink.
WORKDIR /repo/apps/website
COPY --from=geo /geo /repo/packages/geo
COPY apps/website/package.json apps/website/package-lock.json ./
RUN npm ci --ignore-scripts \
  && rm -rf node_modules/@basefyio/geo \
  && cp -R /repo/packages/geo node_modules/@basefyio/geo

FROM base AS build
COPY --from=deps /repo/apps/website/node_modules ./node_modules
COPY apps/website/ .

ARG NEXT_PUBLIC_SITE_URL=https://basefyio.com
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}

ARG NEXT_PUBLIC_GA_MEASUREMENT_ID=G-99MKTVXWZV

# Which stage the product is in; "beta" shows the badge next to every mark.
ARG NEXT_PUBLIC_RELEASE_STAGE=beta
ENV NEXT_PUBLIC_RELEASE_STAGE=${NEXT_PUBLIC_RELEASE_STAGE}
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
