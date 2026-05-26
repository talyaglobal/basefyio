# Kolaybase Website — SEO Engine

This site has a full programmatic SEO engine. This doc explains how it works, how
to add content, how to get pages indexed, and the keyword strategy behind the
existing pages.

---

## 1. How the engine works

| Piece | Where | What it does |
| --- | --- | --- |
| Metadata factory | `src/lib/seo/metadata.ts` | `buildMetadata()` — canonical, OG, Twitter, robots from one input |
| Site config | `src/lib/seo/site.ts` | Brand name, default copy, keyword set |
| JSON-LD builders | `src/lib/seo/json-ld.ts` | Organization, WebSite, Article, Breadcrumb, FAQ, ItemList |
| Blog | `src/content/blog/*.mdx` + `src/lib/content/blog.ts` | File-based MDX posts |
| Comparisons | `src/lib/content/comparisons.ts` | Data-driven `/compare/[slug]` pages |
| Use cases | `src/lib/content/use-cases.ts` | Data-driven `/use-cases/[slug]` pages |
| Learn / glossary | `src/lib/content/glossary.ts` | Data-driven `/learn/[slug]` term pages (long-tail) |
| Integrations | `src/lib/content/integrations.ts` | Data-driven `/integrations/[slug]` framework guides |
| Sitemap | `src/app/sitemap.ts` | Auto-discovers all content |
| RSS | `src/app/feed.xml/route.ts` | `/feed.xml` |

Every content page goes through `buildMetadata()` and emits the right JSON-LD, so
the SEO surface stays consistent. Adding content never requires touching the
sitemap.

---

## 2. Adding content

Use the generator:

```bash
npm run new:post -- "How to model multi-tenant data"   # creates an MDX file
npm run new:compare -- "PlanetScale"                    # prints a registry entry
npm run new:use-case -- "internal tools"                # prints a registry entry
npm run new:term -- "connection pooling"                # prints a glossary entry
```

- **Blog**: edit the created `.mdx`, fill frontmatter, set `draft: false`.
- **Comparison / use case**: paste the printed object into the matching registry
  array.

It then appears automatically in the page, the index, the sitemap, and (for blog)
the RSS feed.

### Quality bar (important for SEO)

Programmatic pages only rank if they're genuinely useful. Avoid thin, templated,
near-duplicate pages — Google demotes them. Each comparison/use-case should have
real, specific, accurate content. Keep competitor claims honest and current.

---

## 3. Getting indexed (do this once per environment)

Pages won't get traffic until search engines find and index them.

1. **Google Search Console** — add and verify `kolaybase.com`.
   - Verify via DNS, or set `NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION` (already wired
     in `src/app/layout.tsx`) to the meta-tag token.
2. **Submit the sitemap** — in Search Console → Sitemaps, submit
   `https://kolaybase.com/sitemap.xml`.
3. **Request indexing** for key pages (home, top comparisons) via the URL
   Inspection tool to speed up first crawl.
4. **Bing Webmaster Tools** — repeat 1–2 for Bing (you can import from Search
   Console).
5. **Verify robots** — `https://kolaybase.com/robots.txt` should allow `/` and
   list the sitemap (it does).
6. **Confirm canonicals** — each page should have a single self-referential
   canonical (handled by `buildMetadata`).

Re-check Search Console weekly for: Coverage (indexed vs. excluded), Core Web
Vitals, and which queries are bringing impressions.

---

## 4. Keyword strategy & target map

The pages are organized by search intent. Highest commercial intent first.

### Comparison pages (intent: evaluating alternatives — closest to signup)

| Page | Primary keywords |
| --- | --- |
| `/compare/kolaybase-vs-supabase` | supabase alternative, kolaybase vs supabase |
| `/compare/kolaybase-vs-firebase` | firebase alternative, sql vs nosql backend |
| `/compare/kolaybase-vs-neon` | neon alternative, serverless postgres backend |
| `/compare/kolaybase-vs-appwrite` | appwrite alternative, open source baas |
| `/compare/kolaybase-vs-pocketbase` | pocketbase alternative, postgres vs sqlite backend |
| `/compare/kolaybase-vs-nhost` | nhost alternative, rest vs graphql backend |
| `/compare/kolaybase-vs-render` | render alternative, backend hosting |
| `/compare/kolaybase-vs-aws-amplify` | aws amplify alternative, no lock-in backend |
| `/compare/kolaybase-vs-convex` | convex alternative, postgres vs convex |
| `/compare/kolaybase-vs-hasura` | hasura alternative, rest vs graphql engine |
| `/compare/kolaybase-vs-directus` | directus alternative, headless data platform |
| `/compare/kolaybase-vs-strapi` | strapi alternative, headless cms backend |
| `/compare/kolaybase-vs-xata` | xata alternative, serverless postgres platform |

### Use-case pages (intent: "backend for X")

| Page | Primary keywords |
| --- | --- |
| `/use-cases/saas-applications` | backend for saas, multi-tenant backend |
| `/use-cases/mobile-apps` | backend for mobile app, react native backend |
| `/use-cases/ecommerce` | backend for ecommerce, online store backend |
| `/use-cases/internal-tools` | backend for internal tools, admin panel api |
| `/use-cases/ai-applications` | backend for ai app, llm app backend |
| `/use-cases/realtime-chat` | chat app backend, messaging backend |
| `/use-cases/analytics-dashboards` | analytics dashboard backend, sql dashboard |

### Blog (intent: informational — top of funnel, high volume)

| Post | Primary keywords |
| --- | --- |
| getting-started-with-kolaybase | postgresql backend, baas getting started |
| rest-api-on-postgresql-without-boilerplate | postgresql rest api, postgrest |
| build-vs-buy-backend | build vs buy backend, baas vs custom |
| postgresql-row-level-security-guide | postgresql row level security, rls policy |
| choosing-a-backend-for-your-ai-app | ai app backend, llm backend |
| self-hosting-backend-with-docker | self-hosted backend, docker backend |
| rest-vs-graphql-backend-2026 | rest vs graphql, api comparison |
| multi-tenancy-database-patterns | multi-tenancy patterns, database per tenant |

### Learn / glossary (intent: definitional — high-volume long-tail)

The `/learn/[slug]` pages target "what is X" / "X definition" queries (e.g. "what
is row level security", "rest api meaning", "acid transactions"). Each term
cross-links to related terms, building a dense internal-link graph that lifts the
whole section. This is the largest long-tail surface — expand it steadily with
genuinely useful definitions.

### Integrations (intent: "<framework> backend" / "Kolaybase + X")

The `/integrations/[slug]` pages target developers searching for "Next.js
backend", "React backend", "use Kolaybase with X". Each shows install, setup, and
usage with the real `kolaybase-js` API. These pages are edited directly in
`src/lib/content/integrations.ts` (they have framework-specific code, so there's
no generator stub). Only add integrations where `kolaybase-js` actually
runs — the SDK is JavaScript/TypeScript.

### How to expand

1. Find real keywords (Search Console "Queries", Google autocomplete,
   "People also ask", a keyword tool) — prefer **low competition + real volume**.
2. Map each keyword to the right intent: comparison, use-case, or blog.
3. Generate the page, write genuinely useful content, ship.
4. Interlink: every new page should link to 2–3 related pages (the engine already
   cross-links comparisons, use cases, and related posts).

---

## 5. Off-page (not solved by code)

Rankings need authority. Plan for:

- **Distribution**: share posts on HN, Reddit, dev.to, X, LinkedIn.
- **Backlinks**: guest posts, comparison-site listings, open-source READMEs.
- **Freshness**: update top pages periodically; `updated` in blog frontmatter
  flows into the sitemap `lastModified`.

The engine handles on-page SEO at scale. Traffic growth = on-page (done) ×
content volume × indexing × backlinks.
