# Kolaybase marketing site (`apps/website`)

Next.js app for **kolaybase.com**: landing, docs, SEO (metadata, Open Graph, JSON-LD, sitemap, robots).

## Development

```bash
cd apps/website
cp .env.example .env
npm install
npm run dev
```

Default dev URL: **http://localhost:3002**

## Environment

See `.env.example` for `NEXT_PUBLIC_*` variables (site URL, GA measurement ID, billing API URL, etc.). Public env vars are baked at **build** time for Docker/production.

## Production build

```bash
npm run build
npm run start
```

Docker: see repo root `docker-compose.yml` / `Dockerfile` in this directory.
