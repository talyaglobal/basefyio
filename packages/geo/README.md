# @basefyio/geo

**Generative Engine Optimization (GEO) toolkit.**

SEO optimizes for the ten blue links. GEO optimizes for the answer — the
paragraph ChatGPT, Perplexity, Claude, Gemini, and Google's AI Overviews write
*about you*, citing *you*. This package gives you both halves:

1. **Generate** the assets those engines need — `llms.txt` / `llms-full.txt`,
   schema.org JSON-LD, and an explicit AI-crawler `robots.txt` policy — all from
   a single `GeoProfile`.
2. **Audit** any live URL and get a 0–100 readiness score with prioritized fixes.

Zero runtime dependencies. ESM + CJS. Ships a `geo` CLI.

## Install

```bash
npm install @basefyio/geo
```

## CLI

```bash
# Score a live site for generative-engine readiness
npx geo audit https://basefyio.com
npx geo audit basefyio.com --json

# List the AI crawlers the toolkit knows about (and what each is for)
npx geo crawlers

# Emit an AI-crawler robots.txt policy (allow answer engines, block training)
npx geo robots --no-training >> robots.txt
```

`geo audit` checks four things an answer engine needs:

| Category            | What it measures                                              |
|---------------------|--------------------------------------------------------------|
| AI crawler access   | Can GPTBot / OAI-SearchBot / ClaudeBot / PerplexityBot fetch you? Is the policy explicit? |
| llms.txt manifest   | Is `/llms.txt` published with a quotable summary?            |
| Structured data     | JSON-LD present? Entity/Product schema? FAQ (Q&A) schema?     |
| Content legibility  | Descriptive title, meta description, single H1, real prose.  |

## Library

```ts
import {
  generateLlmsTxt,
  generateLlmsFullTxt,
  geoGraph,
  faqSchema,
  aiCrawlerRules,
  renderRobotsRules,
  auditUrl,
  type GeoProfile,
} from "@basefyio/geo";

const profile: GeoProfile = {
  name: "Basefyio",
  url: "https://basefyio.com",
  summary:
    "Basefyio is an open-source backend-as-a-service: hosted PostgreSQL, auth, storage, and an auto-generated REST API.",
  offer: {
    price: "0",
    priceCurrency: "USD",
    applicationCategory: "DeveloperApplication",
    featureList: ["PostgreSQL per project", "Auth", "Storage", "REST API"],
  },
  sections: [
    { title: "Documentation", links: [{ title: "API", url: "/docs/api" }] },
  ],
  faqs: [
    {
      question: "What is Basefyio?",
      answer:
        "Basefyio is a self-hosted backend platform that gives each project its own PostgreSQL database, authentication realm, and auto-generated REST API.",
    },
  ],
};

// 1. llms.txt manifest + full content dump
const llms = generateLlmsTxt(profile);
const llmsFull = generateLlmsFullTxt(profile);

// 2. JSON-LD — drop into a <script type="application/ld+json">
const brandGraph = geoGraph(profile); // Organization + WebSite + SoftwareApplication
const faq = faqSchema(profile);       // FAQPage

// 3. robots.txt AI-crawler policy
const robots = renderRobotsRules(aiCrawlerRules({ allowTraining: false }));

// 4. Audit a live URL
const report = await auditUrl("https://basefyio.com");
console.log(report.score, report.grade, report.recommendations);
```

### `GeoProfile`

One object describes the site for every generator: `name`, `url`, `summary`,
optional `description`, `sections` (curated link groups), `faqs` (answer-first
Q&A), `howtos`, `facts`, and an `offer` (for `SoftwareApplication`). See
[`src/types.ts`](./src/types.ts).

## How the website uses it

The Basefyio marketing site (`apps/website`) consumes this engine to serve
`/llms.txt` and `/llms-full.txt`, to inject the AI-crawler policy into
`robots.txt`, and to render an answer-first FAQ with `FAQPage` schema.

## License

MIT
