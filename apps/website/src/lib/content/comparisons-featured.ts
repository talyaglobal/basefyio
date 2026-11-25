import type { Comparison } from "./comparisons";

/**
 * Hand-reviewed comparisons (answer-first, sourced, with "when to choose" lists).
 *
 * Rules for this file:
 *  - basefyio claims must be backed by the repo (README, docs, product code).
 *  - Competitor claims link to the competitor's own documentation or pricing page.
 *    Anything not re-checked against that page carries a `VERIFY:` comment and is
 *    listed in the hand-over report; do not remove the comment until it is checked.
 *  - No prices or limits for competitors: the cell points at their pricing page.
 *  - Public copy does not name basefyio's database engine (owner decision, v3.5.7):
 *    it says "SQL database".
 */

const UPDATED = "2026-11-25";

export const FEATURED_COMPARISONS: Record<string, Comparison> = {
  "basefyio-vs-supabase": {
    slug: "basefyio-vs-supabase",
    competitor: "Supabase",
    title: "basefyio vs. Supabase: Which Backend Should You Use?",
    description:
      "basefyio vs. Supabase compared on database, auth, storage, realtime, self-hosting, licensing and maturity, with sources and when to pick each one.",
    lastUpdated: UPDATED,
    quickAnswer:
      "Both platforms give every project a SQL database with an auto-generated REST API, authentication, storage and realtime. Supabase is the more established platform with a larger ecosystem and edge functions; basefyio is a newer, self-hostable platform (server under AGPL-3.0) that adds per-project auth realms, automation flows and built-in AI search, and can import an existing Supabase project.",
    intro:
      "Both basefyio and Supabase give you a SQL database with an auto-generated REST API, authentication, storage and realtime. The practical differences are maturity and ecosystem, licensing, and the extra platform features each one ships.",
    positioning:
      "basefyio is newer (currently in beta) and is built to be self-hosted with Docker Compose. Each project gets a dedicated database and its own authentication realm, and the platform adds automation flows, AI search and an App Builder on top. Supabase is the more established choice with a bigger community and edge functions.",
    rows: [
      {
        feature: "Database",
        basefyio: "Dedicated SQL database per project, with a SQL editor and direct connection details",
        // VERIFY: Supabase gives each project its own dedicated Postgres database (not a shared schema).
        competitor: "Dedicated Postgres database per project",
        competitorSource: "https://supabase.com/docs/guides/database/overview",
      },
      {
        feature: "Auto-generated REST API",
        basefyio: "Yes, an auto-generated data API over your tables",
        // VERIFY: Supabase serves its data API through PostgREST.
        competitor: "Yes, PostgREST-based data API",
        competitorSource: "https://supabase.com/docs/guides/api",
      },
      {
        feature: "Authentication",
        basefyio: "Isolated auth realm per project: email/password and OAuth providers, JWT-secured API",
        // VERIFY: Supabase Auth providers list (email, OAuth, magic link, phone, SSO) and that it issues JWTs.
        competitor: "Supabase Auth: email, OAuth and more, JWT-based",
        competitorSource: "https://supabase.com/docs/guides/auth",
      },
      {
        feature: "File storage",
        basefyio: "S3-compatible per-project object storage",
        // VERIFY: Supabase Storage exposes an S3-compatible API.
        competitor: "Supabase Storage, with an S3-compatible API",
        competitorSource: "https://supabase.com/docs/guides/storage",
      },
      {
        feature: "Realtime",
        basefyio: "Change events for enabled tables and collections, presence and broadcast over one SSE stream",
        // VERIFY: Supabase Realtime features (database changes, broadcast, presence).
        competitor: "Realtime: database changes, broadcast and presence",
        competitorSource: "https://supabase.com/docs/guides/realtime",
      },
      {
        feature: "Serverless functions",
        basefyio: "No general-purpose function runtime documented; automation flows run trigger-and-action workflows on a job queue",
        // VERIFY: Supabase Edge Functions (Deno-based) still the current serverless offering.
        competitor: "Edge Functions",
        competitorSource: "https://supabase.com/docs/guides/functions",
      },
      {
        feature: "AI and vector search",
        basefyio: "Embeddings, semantic search and RAG queries",
        // VERIFY: Supabase vector/AI toolkit based on pgvector.
        competitor: "Vector search with pgvector and an AI toolkit",
        competitorSource: "https://supabase.com/docs/guides/ai",
      },
      {
        feature: "Self-hosting",
        basefyio: "Designed for it: Docker Compose files for the whole stack",
        // VERIFY: Supabase documents Docker-based self-hosting.
        competitor: "Supported via Docker",
        competitorSource: "https://supabase.com/docs/guides/self-hosting",
      },
      {
        feature: "License",
        basefyio: "Server and dashboard AGPL-3.0-or-later; SDK and CLI MIT",
        // VERIFY: Supabase's main repositories are Apache-2.0 (check each component).
        competitor: "Mostly permissive open source (check each component)",
        competitorSource: "https://github.com/supabase/supabase",
      },
      {
        feature: "Maturity",
        basefyio: "Beta",
        // VERIFY: wording on Supabase's maturity/community size; keep it neutral or drop it.
        competitor: "Established hosted platform with a large community",
        competitorSource: "https://supabase.com/docs",
      },
      {
        feature: "Moving between them",
        basefyio: "Built-in import of a Supabase project: schema, data and users",
        competitor: "Standard SQL database, so data can be dumped and restored elsewhere",
        competitorSource: "https://supabase.com/docs/guides/database/overview",
      },
      {
        feature: "Pricing",
        basefyio: "Free plan plus paid plans; see pricing and limits",
        competitor: "Free and paid tiers; see their pricing page",
        competitorSource: "https://supabase.com/pricing",
      },
    ],
    whenCompetitor: [
      "You want the most established platform, with a larger community, more tutorials and more third-party integrations.",
      "You need serverless functions at the edge from the same platform.",
      "You prefer a permissive license across the stack.",
      "You want a managed service that is already generally available rather than a beta.",
    ],
    whenBasefyio: [
      "You want to run the whole platform on your own infrastructure with Docker Compose, under an AGPL server license.",
      "You want each project to have its own authentication realm and dedicated database.",
      "You want automation flows, AI search and an App Builder (spreadsheet to tables) built into the same dashboard.",
      "You are moving off Supabase: basefyio can import a project's schema, data and users.",
    ],
    sources: [
      { label: "Supabase documentation", url: "https://supabase.com/docs" },
      { label: "Supabase pricing", url: "https://supabase.com/pricing" },
      { label: "Supabase self-hosting guide", url: "https://supabase.com/docs/guides/self-hosting" },
    ],
    faqs: [
      {
        question: "How does basefyio compare to Supabase?",
        answer:
          "They cover the same core: a SQL database per project, an auto-generated REST API, authentication, storage and realtime. Supabase is more established and adds edge functions; basefyio is newer, self-hostable, and adds per-project auth realms, automation flows and built-in AI search.",
      },
      {
        question: "Can I migrate from Supabase to basefyio?",
        answer:
          "Yes. basefyio includes an import for existing Supabase projects that brings over the schema, the data and the users. Check the import documentation for what is supported before you start.",
      },
      {
        question: "Does basefyio have realtime?",
        answer:
          "Yes. It publishes change events for enabled tables and collections, plus presence and client-to-client broadcast, over one server-sent-events stream. Row-level security is applied per subscriber on tables that use it.",
      },
      {
        question: "Which one is better for a startup?",
        answer:
          "If you want the safest, most established choice with the biggest ecosystem, Supabase is hard to argue with. If you want to self-host, need per-project isolation, or want automation and AI search in the same platform, basefyio is worth evaluating.",
      },
    ],
  },

  "basefyio-vs-firebase": {
    slug: "basefyio-vs-firebase",
    competitor: "Firebase",
    title: "basefyio vs. Firebase: Which Backend Should You Use?",
    description:
      "basefyio vs. Firebase compared on data model, auth, storage, realtime, self-hosting, lock-in and mobile SDKs, with sources and when to pick each one.",
    lastUpdated: UPDATED,
    quickAnswer:
      "Firebase is Google's managed app platform built around NoSQL document databases and strong mobile SDKs. basefyio is a SQL-first backend with a dedicated database per project that you can self-host. Pick Firebase for mobile-first apps inside the Google ecosystem, and basefyio when you want relational data, plain SQL and control over where it runs.",
    intro:
      "Firebase and basefyio both remove the need to write a backend from scratch, but they start from different data models: Firebase from document databases, basefyio from a relational SQL database (with an optional document store).",
    positioning:
      "basefyio gives each project a dedicated SQL database you can query directly, with a REST API generated from your tables, and it can run on infrastructure you control. Firebase is a managed Google service with deep mobile SDKs and a long track record.",
    rows: [
      {
        feature: "Data model",
        basefyio: "Relational SQL tables, plus optional schema-flexible document collections",
        // VERIFY: Firestore and Realtime Database are document/JSON stores; Firebase Data Connect adds a SQL option backed by Cloud SQL.
        competitor: "Document databases (Cloud Firestore, Realtime Database); Data Connect adds a SQL option",
        competitorSource: "https://firebase.google.com/docs/firestore",
      },
      {
        feature: "Querying",
        basefyio: "Full SQL through the SQL editor and a direct connection, plus a REST query syntax",
        // VERIFY: Firestore query limitations (joins, aggregation) as they stand today.
        competitor: "Firestore query API with indexes; no SQL joins",
        competitorSource: "https://firebase.google.com/docs/firestore/query-data/queries",
      },
      {
        feature: "Authentication",
        basefyio: "Isolated auth realm per project: email/password and OAuth providers",
        // VERIFY: Firebase Authentication providers (email, phone, federated identity).
        competitor: "Firebase Authentication: email, phone and federated providers",
        competitorSource: "https://firebase.google.com/docs/auth",
      },
      {
        feature: "File storage",
        basefyio: "S3-compatible per-project object storage",
        competitor: "Cloud Storage for Firebase",
        competitorSource: "https://firebase.google.com/docs/storage",
      },
      {
        feature: "Realtime",
        basefyio: "Change events, presence and broadcast over one SSE stream",
        // VERIFY: realtime listeners and offline persistence are core Firestore SDK features.
        competitor: "Realtime listeners with offline persistence in the client SDKs",
        competitorSource: "https://firebase.google.com/docs/firestore/query-data/listen",
      },
      {
        feature: "Serverless functions",
        basefyio: "Automation flows (trigger-and-action workflows); no general-purpose function runtime documented",
        competitor: "Cloud Functions for Firebase",
        competitorSource: "https://firebase.google.com/docs/functions",
      },
      {
        feature: "Client SDKs",
        basefyio: "basefyio-js (JavaScript/TypeScript), a Python SDK and the basefyio CLI",
        // VERIFY: Firebase client SDK platform list (iOS, Android, web, Flutter, Unity, C++).
        competitor: "SDKs for iOS, Android, web, Flutter and more",
        competitorSource: "https://firebase.google.com/docs/build",
      },
      {
        feature: "Self-hosting",
        basefyio: "Yes: Docker Compose files for the whole stack",
        // VERIFY: Firebase has no self-hosted production option; the Emulator Suite is for local development.
        competitor: "Google-managed service; the Emulator Suite is for local development",
        competitorSource: "https://firebase.google.com/docs/emulator-suite",
      },
      {
        feature: "Portability",
        basefyio: "Standard SQL data you can dump and restore",
        // VERIFY: Firebase data is exportable but uses Google-specific data models and APIs.
        competitor: "Data is exportable, but built on Google-specific APIs",
        competitorSource: "https://firebase.google.com/docs/firestore/manage-data/export-import",
      },
      {
        feature: "Pricing",
        basefyio: "Free plan plus paid plans; see pricing and limits",
        competitor: "No-cost and pay-as-you-go plans; see their pricing page",
        competitorSource: "https://firebase.google.com/pricing",
      },
    ],
    whenCompetitor: [
      "You are building a mobile-first app and want mature iOS, Android and Flutter SDKs.",
      "Your data fits documents well and you rely on offline-first client sync.",
      "You already use Google Cloud and want one vendor for hosting, analytics and messaging.",
      "You want a fully managed service with no infrastructure to run.",
    ],
    whenBasefyio: [
      "Your data is relational and you want joins, constraints and plain SQL.",
      "You want to self-host or choose where your data lives.",
      "You want a dedicated database per project that any SQL tool can connect to.",
      "You want to avoid building on a proprietary data model.",
    ],
    sources: [
      { label: "Firebase documentation", url: "https://firebase.google.com/docs" },
      { label: "Firebase pricing", url: "https://firebase.google.com/pricing" },
      { label: "Cloud Firestore overview", url: "https://firebase.google.com/docs/firestore" },
    ],
    faqs: [
      {
        question: "Is basefyio SQL or NoSQL?",
        answer:
          "SQL first: every project gets a dedicated relational database. basefyio also offers schema-flexible document collections through its data engine, so you can mix both in one project.",
      },
      {
        question: "Can I self-host basefyio but not Firebase?",
        answer:
          "Yes. basefyio ships Docker Compose files for the whole stack. Firebase is a Google-managed service, and its Emulator Suite is intended for local development rather than production hosting.",
      },
      {
        question: "Does basefyio have mobile SDKs like Firebase?",
        answer:
          "basefyio ships a JavaScript/TypeScript SDK, a Python SDK and a CLI. It does not have native iOS or Android SDKs; mobile apps use the REST API or the JavaScript SDK. If native mobile SDKs matter most, Firebase is the stronger fit.",
      },
      {
        question: "Which is better for a startup?",
        answer:
          "For a mobile-first product that fits documents, Firebase is a proven choice. For a relational product, or if you want to keep the option to self-host, basefyio is worth evaluating.",
      },
    ],
  },

  "basefyio-vs-appwrite": {
    slug: "basefyio-vs-appwrite",
    competitor: "Appwrite",
    title: "basefyio vs. Appwrite: Which Backend Should You Use?",
    description:
      "basefyio vs. Appwrite compared on database access, auth, storage, functions, SDKs, self-hosting and licensing, with sources and when to pick each one.",
    lastUpdated: UPDATED,
    quickAnswer:
      "Appwrite and basefyio are both open-source backends you can self-host with Docker. Appwrite offers broader client SDKs and built-in functions and messaging; basefyio gives each project a dedicated SQL database you can query directly, with a per-project auth realm and built-in AI search. Choose Appwrite for multi-platform app development and basefyio when SQL access matters most.",
    intro:
      "Appwrite and basefyio are both self-hostable backend platforms with a database, authentication, storage and an API. They differ most in how you reach your data and in the surrounding tooling.",
    positioning:
      "basefyio exposes a real SQL database per project: a SQL editor, direct connection details and a read-only role for BI tools. Appwrite exposes its database through its own collections API and SDKs, and adds functions, messaging and many client SDKs.",
    rows: [
      {
        feature: "Database access",
        basefyio: "Dedicated SQL database per project, queryable with SQL and standard connection details",
        // VERIFY: Appwrite Databases are accessed through its API/SDKs (tables/collections), not a raw SQL connection.
        competitor: "Databases accessed through the Appwrite API and SDKs",
        competitorSource: "https://appwrite.io/docs/products/databases",
      },
      {
        feature: "Auto-generated REST API",
        basefyio: "Yes, an auto-generated data API over your tables",
        // VERIFY: Appwrite exposes REST (and GraphQL) endpoints for its services.
        competitor: "REST endpoints for each service, plus SDKs",
        competitorSource: "https://appwrite.io/docs/apis/rest",
      },
      {
        feature: "Authentication",
        basefyio: "Isolated auth realm per project: email/password and OAuth providers",
        // VERIFY: Appwrite Auth methods (email, OAuth, phone, magic URL, anonymous...).
        competitor: "Appwrite Auth: many sign-in methods, teams and roles",
        competitorSource: "https://appwrite.io/docs/products/auth",
      },
      {
        feature: "File storage",
        basefyio: "S3-compatible per-project object storage",
        competitor: "Appwrite Storage",
        competitorSource: "https://appwrite.io/docs/products/storage",
      },
      {
        feature: "Serverless functions",
        basefyio: "Automation flows (trigger-and-action workflows); no general-purpose function runtime documented",
        // VERIFY: Appwrite Functions supports many runtimes.
        competitor: "Appwrite Functions",
        competitorSource: "https://appwrite.io/docs/products/functions",
      },
      {
        feature: "Realtime",
        basefyio: "Change events, presence and broadcast over one SSE stream",
        competitor: "Realtime subscriptions",
        competitorSource: "https://appwrite.io/docs/apis/realtime",
      },
      {
        feature: "Client SDKs",
        basefyio: "basefyio-js (JavaScript/TypeScript), a Python SDK and the basefyio CLI",
        // VERIFY: Appwrite's client and server SDK platform list.
        competitor: "SDKs for web, mobile and many server languages",
        competitorSource: "https://appwrite.io/docs/sdks",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose files for the whole stack",
        // VERIFY: Appwrite documents Docker-based self-hosting.
        competitor: "Docker-based self-hosting",
        competitorSource: "https://appwrite.io/docs/advanced/self-hosting",
      },
      {
        feature: "License",
        basefyio: "Server and dashboard AGPL-3.0-or-later; SDK and CLI MIT",
        // VERIFY: Appwrite's server license (BSD-3-Clause at the time of writing).
        competitor: "Open source; see the repository for the license",
        competitorSource: "https://github.com/appwrite/appwrite",
      },
      {
        feature: "Pricing",
        basefyio: "Free plan plus paid plans; see pricing and limits",
        competitor: "Free and paid cloud plans; see their pricing page",
        competitorSource: "https://appwrite.io/pricing",
      },
    ],
    whenCompetitor: [
      "You build apps for several client platforms and want broad official SDK coverage.",
      "You want functions, messaging and hosting from the same platform.",
      "You are happy accessing data through the platform API rather than raw SQL.",
    ],
    whenBasefyio: [
      "You want a real SQL database per project that your existing SQL tools can connect to.",
      "You want a read-only database role for BI and reporting tools.",
      "You want built-in AI search (embeddings and RAG queries) and automation flows.",
      "You are comfortable with an AGPL-licensed server and want per-project auth realms.",
    ],
    sources: [
      { label: "Appwrite documentation", url: "https://appwrite.io/docs" },
      { label: "Appwrite pricing", url: "https://appwrite.io/pricing" },
      { label: "Appwrite self-hosting guide", url: "https://appwrite.io/docs/advanced/self-hosting" },
    ],
    faqs: [
      {
        question: "Can I self-host both basefyio and Appwrite?",
        answer:
          "Yes. Both run on your own infrastructure with Docker. basefyio ships Docker Compose files for the whole stack, including the dashboard, the database, authentication and storage.",
      },
      {
        question: "How is database access different?",
        answer:
          "basefyio gives each project a dedicated SQL database with a SQL editor, direct connection details and an optional read-only role. Appwrite exposes its database through its own API and SDKs.",
      },
      {
        question: "Does basefyio have as many SDKs as Appwrite?",
        answer:
          "No. basefyio ships a JavaScript/TypeScript SDK, a Python SDK and a CLI, and any language can call the REST API. If you need official SDKs for many client platforms, Appwrite covers more.",
      },
      {
        question: "Which is better for a startup?",
        answer:
          "If you build for many client platforms, Appwrite is a strong default. If your team thinks in SQL and wants a database it can query directly, basefyio is worth evaluating.",
      },
    ],
  },
};
