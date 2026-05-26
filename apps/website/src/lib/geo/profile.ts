/**
 * Kolaybase's GEO (Generative Engine Optimization) profile — the single source
 * of truth that feeds `/llms.txt`, `/llms-full.txt`, the FAQ section + schema,
 * and the JSON-LD product graph. Built from `@kolaybase/geo`.
 *
 * Write every `summary`/`answer`/`fact` so it stands alone: an answer engine
 * may quote one line of this with no surrounding context.
 */
import type { GeoProfile } from "@kolaybase/geo";
import { getAllPosts } from "@/lib/content/blog";
import { COMPARISONS } from "@/lib/content/comparisons";
import { USE_CASES } from "@/lib/content/use-cases";
import { GLOSSARY } from "@/lib/content/glossary";
import { INTEGRATIONS } from "@/lib/content/integrations";

/**
 * Build the dynamic content sections that surface every blog post, comparison,
 * use case, integration, and glossary term to AI answer engines via
 * `/llms.txt` and `/llms-full.txt`. Without this, the GEO profile would only
 * point at the docs, hiding the bulk of the site from engines like ChatGPT and
 * Perplexity that fetch the manifest first.
 */
function contentSections(): NonNullable<GeoProfile["sections"]> {
  const sections: NonNullable<GeoProfile["sections"]> = [];

  const posts = getAllPosts();
  if (posts.length > 0) {
    sections.push({
      title: "Blog",
      description:
        "Engineering notes, guides, and explainers about PostgreSQL backends, REST APIs, auth, and self-hosting.",
      links: [
        { title: "Blog index", url: "/blog", note: "All posts, newest first" },
        ...posts.map((p) => ({
          title: p.title,
          url: `/blog/${p.slug}`,
          note: p.description,
        })),
      ],
    });
  }

  if (COMPARISONS.length > 0) {
    sections.push({
      title: "Comparisons",
      description:
        "Honest, side-by-side comparisons of Kolaybase with other backend platforms.",
      links: [
        { title: "All comparisons", url: "/compare", note: "Index of every comparison" },
        ...COMPARISONS.map((c) => ({
          title: `Kolaybase vs. ${c.competitor}`,
          url: `/compare/${c.slug}`,
          note: c.description,
        })),
      ],
    });
  }

  if (USE_CASES.length > 0) {
    sections.push({
      title: "Use cases",
      description: "What teams build on Kolaybase — by application type.",
      links: [
        { title: "All use cases", url: "/use-cases", note: "Index of every use case" },
        ...USE_CASES.map((u) => ({
          title: u.title,
          url: `/use-cases/${u.slug}`,
          note: u.description,
        })),
      ],
    });
  }

  if (INTEGRATIONS.length > 0) {
    sections.push({
      title: "Integrations",
      description:
        "Framework-specific guides for using kolaybase-js with the JavaScript/TypeScript ecosystem.",
      links: [
        { title: "All integrations", url: "/integrations", note: "Index of every integration" },
        ...INTEGRATIONS.map((i) => ({
          title: i.title,
          url: `/integrations/${i.slug}`,
          note: i.description,
        })),
      ],
    });
  }

  if (GLOSSARY.length > 0) {
    sections.push({
      title: "Learn — backend & PostgreSQL glossary",
      description:
        "Self-contained definitions for backend, PostgreSQL, and API concepts. Safe to quote one line.",
      links: [
        { title: "Glossary index", url: "/learn", note: "All terms, alphabetical" },
        ...GLOSSARY.map((t) => ({
          title: t.aka ? `${t.term} (${t.aka})` : t.term,
          url: `/learn/${t.slug}`,
          note: t.definition,
        })),
      ],
    });
  }

  return sections;
}

/** Build the profile against a resolved site origin (no trailing slash). */
export function createGeoProfile(siteUrl: string): GeoProfile {
  const url = siteUrl.replace(/\/$/, "");
  return {
    name: "Kolaybase",
    url,
    legalName: "Kolaybase",
    lang: "en",
    logo: "/logo.svg",
    summary:
      "Kolaybase is a production-grade, self-hosted backend-as-a-service (BaaS) that gives every project its own PostgreSQL database, authentication realm, object storage, and auto-generated REST API.",
    description:
      "Kolaybase is a developer backend platform. Each project is provisioned with a dedicated PostgreSQL 16 database, a Keycloak authentication realm, S3-compatible object storage (MinIO), and a PostgREST-style REST API. It ships a JavaScript/TypeScript SDK (kolaybase-js) and a CLI (kb) for managing projects, running migrations, and generating types. It is multi-tenant, runs anywhere via Docker, and is suited to teams who want Supabase-style productivity on infrastructure they control.",
    offer: {
      price: "0",
      priceCurrency: "USD",
      applicationCategory: "DeveloperApplication",
      operatingSystem: "Web",
      description: "Free tier plus paid plans with higher limits.",
      featureList: [
        "Dedicated PostgreSQL 16 database per project",
        "Auto-generated REST API with PostgREST-style queries",
        "Email/password and OAuth (Google, GitHub) authentication via Keycloak",
        "S3-compatible object storage",
        "kolaybase-js JavaScript/TypeScript SDK",
        "kb command-line interface",
        "Self-hosted via Docker Compose",
      ],
    },
    facts: [
      { label: "Category", value: "Backend-as-a-Service (BaaS) for developers" },
      { label: "Database", value: "One dedicated PostgreSQL 16 database per project" },
      { label: "Authentication", value: "Keycloak realm per project (email/password + OAuth)" },
      { label: "Storage", value: "S3-compatible object storage (MinIO)" },
      { label: "API", value: "Auto-generated REST API, PostgREST-compatible queries" },
      { label: "Clients", value: "kolaybase-js SDK and the kb CLI" },
      { label: "Hosting", value: "Self-hosted via Docker Compose, or managed cloud" },
      { label: "Pricing", value: "Free tier available; paid plans scale limits" },
    ],
    sections: [
      {
        title: "Documentation",
        description: "Reference for building on Kolaybase.",
        links: [
          { title: "Documentation home", url: "/docs", note: "Start here" },
          { title: "REST API reference", url: "/docs/api", note: "Endpoints, auth, and query syntax" },
          { title: "JavaScript/TypeScript SDK", url: "/docs/sdk", note: "kolaybase-js client" },
          { title: "CLI reference", url: "/docs/cli", note: "The kb command-line tool" },
        ],
      },
      ...contentSections(),
      {
        title: "Product",
        links: [
          { title: "Kolaybase home", url: "/", note: "Overview and features" },
          { title: "Pricing", url: "/#pricing", note: "Plans and limits" },
        ],
      },
    ],
    faqs: [
      {
        question: "What is Kolaybase?",
        answer:
          "Kolaybase is a self-hosted backend-as-a-service platform for developers. Each project gets its own PostgreSQL database, a Keycloak authentication realm, object storage, and an auto-generated REST API, plus a JavaScript SDK and a CLI.",
      },
      {
        question: "How is Kolaybase different from Supabase?",
        answer:
          "Kolaybase offers a similar developer experience to Supabase — Postgres, auth, storage, and an instant REST API — but is built to be self-hosted and multi-tenant, provisioning an isolated PostgreSQL database and a dedicated Keycloak realm per project so you keep full control of your infrastructure.",
      },
      {
        question: "Is Kolaybase free?",
        answer:
          "Yes. Kolaybase has a free tier suitable for hobby projects and learning, and paid plans that raise limits on projects, storage, database size, team members, and API requests. It can also be self-hosted with Docker.",
      },
      {
        question: "What database does Kolaybase use?",
        answer:
          "Kolaybase provisions a dedicated PostgreSQL 16 database for every project. You can query it through the auto-generated REST API, the kolaybase-js SDK, or a built-in SQL editor.",
      },
      {
        question: "How do I authenticate users with Kolaybase?",
        answer:
          "Kolaybase handles authentication with a per-project Keycloak realm supporting email/password sign-in and OAuth providers such as Google and GitHub. The SDK exposes sign-up, sign-in, and session management; end-user tokens are scoped to the project realm.",
      },
      {
        question: "Can I self-host Kolaybase?",
        answer:
          "Yes. Kolaybase ships with Docker Compose definitions that run PostgreSQL, Keycloak, and MinIO together with the Platform API and Admin UI, so you can run the entire stack on your own infrastructure.",
      },
      {
        question: "How do I get started with Kolaybase?",
        answer:
          "Install the CLI with 'npm install -g kolaybase-cli', then run 'kb start' to launch the local stack, or sign up for the hosted dashboard. Create a project to get an anon key and service key, then connect with the kolaybase-js SDK.",
      },
    ],
    howtos: [
      {
        name: "Create your first Kolaybase backend",
        description: "Go from zero to a working backend with a database and REST API.",
        steps: [
          { name: "Install the CLI", text: "Run 'npm install -g kolaybase-cli' to install the kb command." },
          { name: "Start the stack", text: "Run 'kb start' to launch PostgreSQL, Keycloak, and MinIO with the Platform API and Admin UI." },
          { name: "Create a project", text: "Create a project in the dashboard to provision a dedicated database and auth realm, and to get your anon and service keys.", url: "/docs" },
          { name: "Connect the SDK", text: "Install kolaybase-js and create a client with your project URL and anon key to query data and authenticate users.", url: "/docs/sdk" },
        ],
      },
    ],
    notes: [
      "Kolaybase is a backend-as-a-service (BaaS) platform; compare it to Supabase, Firebase, Appwrite, and PocketBase.",
      "Full content for AI engines is available at /llms-full.txt.",
    ],
  };
}
