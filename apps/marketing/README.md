# @basefyio/marketing

The basefyio marketing site, built with [Astro](https://astro.build). Static,
fast, and SEO-first. Home of landing pages and high-intent SEO content such as
the **Supabase alternative** comparison page.

## Pages

| Route | Purpose |
|---|---|
| `/` | Home / overview |
| `/supabase-alternative` | High-intent SEO comparison page (basefyio vs Supabase) |

## Develop

```bash
pnpm --filter @basefyio/marketing dev      # local dev server
pnpm --filter @basefyio/marketing build    # static build → dist/
pnpm --filter @basefyio/marketing preview  # preview the build
```

## Configuration

The production domain drives canonical URLs, OpenGraph URLs, and the generated
sitemap. Set it in [`astro.config.mjs`](./astro.config.mjs) (default
`https://basefyio.com`) or override at build time:

```bash
SITE_URL=https://basefyio.com pnpm --filter @basefyio/marketing build
```

Also update the `Sitemap:` line in [`public/robots.txt`](./public/robots.txt)
if the domain changes.

## SEO notes

- Per-page `<title>`, meta description, canonical, and OpenGraph tags live in
  [`BaseLayout.astro`](./src/layouts/BaseLayout.astro).
- The Supabase page emits `FAQPage` + `SoftwareApplication` JSON-LD for rich
  results.
- All product claims are kept consistent with the repo's actual status
  (early alpha; Admin UI in progress; AI stack deferred to `agentfyio`).
  Keep them honest — overstating shipped features hurts both trust and SEO.
