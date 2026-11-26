import type { Comparison } from "./comparisons";

/**
 * Hand-reviewed comparisons (answer-first, sourced, with "when to choose" lists).
 *
 * Rules for this file:
 *  - basefyio claims must be backed by the repo (README, docs, product code).
 *  - Competitor claims link to the competitor's own documentation or pricing page.
 *    Claims were checked against those official pages on 2026-11-26 (`CHECKED:` comments);
 *    anything still unconfirmed carries a `VERIFY:` comment.
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
        // CHECKED 2026-11-26: database overview: "Every Supabase project gets a full Postgres database".
        competitor: "Dedicated Postgres database per project",
        competitorSource: "https://supabase.com/docs/guides/database/overview",
      },
      {
        feature: "Auto-generated REST API",
        basefyio: "Yes, an auto-generated data API over your tables",
        // CHECKED 2026-11-26: API guide: RESTful API using PostgREST.
        competitor: "Yes, PostgREST-based data API",
        competitorSource: "https://supabase.com/docs/guides/api",
      },
      {
        feature: "Authentication",
        basefyio: "Isolated auth realm per project: email/password and OAuth providers, JWT-secured API",
        // CHECKED 2026-11-26: auth guide: password, magic link, OTP, social sign-in, SSO; JWT-based.
        competitor: "Supabase Auth: email, OAuth and more, JWT-based",
        competitorSource: "https://supabase.com/docs/guides/auth",
      },
      {
        feature: "File storage",
        basefyio: "S3-compatible per-project object storage",
        // CHECKED 2026-11-26: storage guide: "S3 compatible Storage".
        competitor: "Supabase Storage, with an S3-compatible API",
        competitorSource: "https://supabase.com/docs/guides/storage",
      },
      {
        feature: "Realtime",
        basefyio: "Change events for enabled tables and collections, presence and broadcast over one SSE stream",
        // CHECKED 2026-11-26: realtime guide: Postgres Changes, Broadcast, Presence.
        competitor: "Realtime: database changes, broadcast and presence",
        competitorSource: "https://supabase.com/docs/guides/realtime",
      },
      {
        feature: "Serverless functions",
        basefyio: "No general-purpose function runtime documented; automation flows run trigger-and-action workflows on a job queue",
        // CHECKED 2026-11-26: functions guide: serverless TypeScript functions on a Deno-compatible runtime.
        competitor: "Edge Functions",
        competitorSource: "https://supabase.com/docs/guides/functions",
      },
      {
        feature: "AI and vector search",
        basefyio: "Embeddings, semantic search and RAG queries",
        // CHECKED 2026-11-26: AI guide: toolkit using Postgres and pgvector.
        competitor: "Vector search with pgvector and an AI toolkit",
        competitorSource: "https://supabase.com/docs/guides/ai",
      },
      {
        feature: "Self-hosting",
        basefyio: "Designed for it: Docker Compose files for the whole stack",
        // CHECKED 2026-11-26: self-hosting guide: Docker is the recommended way.
        competitor: "Supported via Docker",
        competitorSource: "https://supabase.com/docs/guides/self-hosting",
      },
      {
        feature: "License",
        basefyio: "Server and dashboard AGPL-3.0-or-later; SDK and CLI MIT",
        // CHECKED 2026-11-26: the main repository shows the Apache-2.0 license (components can differ).
        competitor: "Main repository under Apache-2.0",
        competitorSource: "https://github.com/supabase/supabase",
      },
      {
        feature: "Maturity",
        basefyio: "Beta",
        // Not a documented fact, kept neutral; replace with a sourced statement if you have one.
        competitor: "Established hosted platform",
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
        // CHECKED 2026-11-26: Firestore is "a cloud-hosted, NoSQL database"; the SQL option is documented as Firebase SQL Connect (backed by Cloud SQL).
        competitor: "NoSQL databases (Cloud Firestore, Realtime Database); Firebase SQL Connect adds a relational option",
        competitorSource: "https://firebase.google.com/docs/firestore",
      },
      {
        feature: "Querying",
        basefyio: "Full SQL through the SQL editor and a direct connection, plus a REST query syntax",
        // CHECKED 2026-11-26: the queries page documents query limits (for example, not-in cannot be combined with in); "no joins" was not found, so it is not claimed.
        competitor: "Firestore query API with documented query limits",
        competitorSource: "https://firebase.google.com/docs/firestore/query-data/queries",
      },
      {
        feature: "Authentication",
        basefyio: "Isolated auth realm per project: email/password and OAuth providers",
        // CHECKED 2026-11-26: auth page: passwords, phone numbers, federated identity providers.
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
        // CHECKED 2026-11-26: the listen page documents onSnapshot listeners; the Firestore overview says the client caches data so the app works offline.
        competitor: "Realtime listeners, and offline use through client-side caching",
        competitorSource: "https://firebase.google.com/docs/firestore",
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
        // CHECKED 2026-11-26: build index lists Apple platforms, Android, Web, Flutter, C++ and Unity.
        competitor: "SDKs for Apple platforms, Android, web, Flutter, Unity and C++",
        competitorSource: "https://firebase.google.com/docs/build",
      },
      {
        feature: "Self-hosting",
        basefyio: "Yes: Docker Compose files for the whole stack",
        // CHECKED 2026-11-26: emulator page: "Do not attempt to use these emulators as self-hosted versions of Firebase services".
        competitor: "Google-managed service; the emulators are for local development, not self-hosting",
        competitorSource: "https://firebase.google.com/docs/emulator-suite",
      },
      {
        feature: "Portability",
        basefyio: "Standard SQL data you can dump and restore",
        // CHECKED 2026-11-26: managed export and import exists; the page says it requires the Blaze plan.
        competitor: "Managed export and import is available (pay-as-you-go plan)",
        competitorSource: "https://firebase.google.com/docs/firestore/manage-data/export-import",
      },
      {
        feature: "Pricing",
        basefyio: "Free plan plus paid plans; see pricing and limits",
        // CHECKED 2026-11-26: plans are named No-cost (Spark) and Pay as you go (Blaze).
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
      "Appwrite and basefyio are both open-source backends you can self-host with Docker. Appwrite offers broader client SDKs and built-in functions and messaging; basefyio gives each project a dedicated SQL database you can query directly, with a per-project auth realm and built-in AI search. Appwrite's databases sit behind its own API, with native SQL engines available on dedicated infrastructure. Choose Appwrite for multi-platform app development and basefyio when direct SQL access to every project's database matters most.",
    intro:
      "Appwrite and basefyio are both self-hostable backend platforms with a database, authentication, storage and an API. They differ most in how you reach your data and in the surrounding tooling.",
    positioning:
      "basefyio exposes a real SQL database per project: a SQL editor, direct connection details and a read-only role for BI tools. Appwrite's managed databases sit behind its own API and SDKs (native SQL engines with direct connections are offered on dedicated infrastructure), and it adds functions, messaging and many client SDKs.",
    rows: [
      {
        feature: "Database access",
        basefyio: "Dedicated SQL database per project, queryable with SQL and standard connection details",
        // CHECKED 2026-11-26: the databases page lists managed databases with an Appwrite API on top, and native engines with direct connections on dedicated infrastructure.
        competitor: "Managed databases through the Appwrite API and SDKs; native SQL engines with direct connections on dedicated infrastructure",
        competitorSource: "https://appwrite.io/docs/products/databases",
      },
      {
        feature: "Auto-generated REST API",
        basefyio: "Yes, an auto-generated data API over your tables",
        // CHECKED 2026-11-26: REST, GraphQL and Realtime protocols are documented.
        competitor: "REST endpoints for each service, plus SDKs",
        competitorSource: "https://appwrite.io/docs/apis/rest",
      },
      {
        feature: "Authentication",
        basefyio: "Isolated auth realm per project: email/password and OAuth providers",
        // CHECKED 2026-11-26: email and password, phone, magic URL, email OTP, OAuth 2 (30+ providers), anonymous, passkeys, LDAP, MFA.
        competitor: "Appwrite Auth: many sign-in methods, including OAuth, phone, passkeys and MFA",
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
        // CHECKED 2026-11-26: "an extensive list of runtimes"; not all are available on Appwrite Cloud yet.
        competitor: "Appwrite Functions, with many runtimes",
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
        // CHECKED 2026-11-26: client SDKs for Web, Flutter, React Native, Apple, Android, Unity; server SDKs for Node.js, Python, Go and more.
        competitor: "SDKs for web, mobile and many server languages",
        competitorSource: "https://appwrite.io/docs/sdks",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose files for the whole stack",
        // CHECKED 2026-11-26: self-hosting page: run on any OS that can run Docker.
        competitor: "Docker-based self-hosting",
        competitorSource: "https://appwrite.io/docs/advanced/self-hosting",
      },
      {
        feature: "License",
        basefyio: "Server and dashboard AGPL-3.0-or-later; SDK and CLI MIT",
        // CHECKED 2026-11-26: the LICENSE file is a permissive BSD-style license (it does not name itself).
        competitor: "Open source under a permissive BSD-style license",
        competitorSource: "https://github.com/appwrite/appwrite",
      },
      {
        feature: "Pricing",
        basefyio: "Free plan plus paid plans; see pricing and limits",
        // CHECKED 2026-11-26: the pricing page names Free and Pro plans.
        competitor: "Free and paid cloud plans; see their pricing page",
        competitorSource: "https://appwrite.io/pricing",
      },
    ],
    whenCompetitor: [
      "You build apps for several client platforms and want broad official SDK coverage.",
      "You want functions, messaging and hosting from the same platform.",
      "You are happy accessing data through the platform API and SDKs rather than a SQL connection.",
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
          "basefyio gives each project a dedicated SQL database with a SQL editor, direct connection details and an optional read-only role. Appwrite's managed databases are reached through its own API and SDKs; its documentation also lists native SQL engines with direct connections on dedicated infrastructure.",
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
