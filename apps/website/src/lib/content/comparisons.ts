import type { FaqItem } from "@/lib/seo/json-ld";
import { FEATURED_COMPARISONS } from "./comparisons-featured";

/**
 * Data registry powering the programmatic `/compare/[slug]` pages. Add an entry
 * here and the comparison page, index card, sitemap, and JSON-LD all update
 * automatically — no per-page React required.
 */
export type ComparisonRow = {
  feature: string;
  basefyio: string;
  competitor: string;
  /** Official competitor doc/pricing page that backs the competitor cell. */
  competitorSource?: string;
};

export type SourceLink = { label: string; url: string };

export type Comparison = {
  slug: string;
  /** Competitor display name, e.g. "Supabase". */
  competitor: string;
  title: string;
  description: string;
  /** Lead paragraph shown under the H1. */
  intro: string;
  /** Honest, specific positioning — what basefyio does differently. */
  positioning: string;
  rows: ComparisonRow[];
  faqs: FaqItem[];
  /** Featured (answer-first) pages only. ISO date shown as "Last updated". */
  lastUpdated?: string;
  /** 2-3 sentence direct answer shown first; quoted by answer engines. */
  quickAnswer?: string;
  whenCompetitor?: string[];
  whenBasefyio?: string[];
  /** Official competitor pages the claims rest on. */
  sources?: SourceLink[];
};

const BASE_COMPARISONS: Comparison[] = [
  {
    slug: "basefyio-vs-supabase",
    competitor: "Supabase",
    title: "basefyio vs. Supabase: Which Backend Should You Use?",
    description:
      "A detailed, honest comparison of basefyio and Supabase: hosting model, database isolation, REST API, auth, pricing, and lock-in. Find the right backend for your stack.",
    intro:
      "Both basefyio and Supabase give you a database with an auto-generated REST API, authentication, and storage. The differences come down to isolation, self-hosting, and how the platform is operated.",
    positioning:
      "basefyio provisions a dedicated database and an isolated auth realm per project, and is built to be self-hosted with Docker Compose from day one. If you want true single-tenant isolation and full control of where your data runs, that's the core distinction.",
    rows: [
      {
        feature: "Database model",
        basefyio: "Dedicated database per project",
        competitor: "Shared database (schema-based isolation)",
      },
      {
        feature: "Self-hosting",
        basefyio: "First-class, Docker Compose included",
        competitor: "Supported, more involved setup",
      },
      {
        feature: "Auto REST API",
        basefyio: "Yes, auto-generated REST API",
        competitor: "Yes, auto-generated REST API",
      },
      {
        feature: "Authentication",
        basefyio: "Dedicated auth realm per project (OAuth + email)",
        competitor: "GoTrue (email, OAuth, magic links)",
      },
      {
        feature: "Storage",
        basefyio: "S3-compatible object storage",
        competitor: "S3-compatible",
      },
      {
        feature: "Query language",
        basefyio: "Standard SQL, no lock-in",
        competitor: "Standard SQL, no lock-in",
      },
      {
        feature: "Realtime",
        basefyio: "Change events, presence and broadcast over one SSE stream",
        competitor: "Built-in",
      },
    ],
    faqs: [
      {
        question: "Is basefyio a Supabase alternative?",
        answer:
          "Yes. basefyio offers the same core building blocks — a dedicated database, an auto-generated REST API, authentication, and object storage — with per-project isolation and a self-hosting-first design.",
      },
      {
        question: "Can I migrate from Supabase to basefyio?",
        answer:
          "Because both use standard SQL, you can export your schema and data and import it into a basefyio project. There is no proprietary query language to rewrite.",
      },
      {
        question: "Does basefyio have realtime subscriptions?",
        answer:
          "Realtime is on the roadmap. Today basefyio focuses on database, REST API, auth, and storage. If realtime is a hard requirement right now, factor that into your decision.",
      },
    ],
  },
  {
    slug: "basefyio-vs-firebase",
    competitor: "Firebase",
    title: "basefyio vs. Firebase: SQL Backend or NoSQL? A Practical Comparison",
    description:
      "Compare basefyio and Firebase across data model, queries, relational integrity, pricing predictability, and vendor lock-in. Choose the right backend for your app.",
    intro:
      "Firebase is a NoSQL document platform; basefyio is built on a relational database. The choice shapes how you model data, query it, and avoid lock-in.",
    positioning:
      "If your data is relational — users, orders, posts with relationships — basefyio's SQL foundation lets you express joins, constraints, and transactions natively. Firebase shines for simple document/realtime workloads but makes complex queries and migrations harder, and its data model is proprietary.",
    rows: [
      {
        feature: "Data model",
        basefyio: "Relational database",
        competitor: "NoSQL document store",
      },
      {
        feature: "Queries",
        basefyio: "Full SQL: joins, aggregates, transactions",
        competitor: "Limited; no server-side joins",
      },
      {
        feature: "Schema & constraints",
        basefyio: "Enforced by the database",
        competitor: "Schemaless; enforced in app/rules",
      },
      {
        feature: "REST API",
        basefyio: "Auto-generated REST API",
        competitor: "SDK-first; REST is limited",
      },
      {
        feature: "Lock-in",
        basefyio: "Standard SQL, portable",
        competitor: "Proprietary data model",
      },
      {
        feature: "Pricing model",
        basefyio: "Predictable, self-hostable",
        competitor: "Usage-based, can spike",
      },
      {
        feature: "Realtime",
        basefyio: "Change events, presence and broadcast over one SSE stream",
        competitor: "Core strength",
      },
    ],
    faqs: [
      {
        question: "Is basefyio a good Firebase alternative?",
        answer:
          "For relational data and apps that benefit from SQL, yes. basefyio gives you a dedicated database with auth, storage, and a REST API. If you need NoSQL documents and best-in-class realtime above all, Firebase may fit better.",
      },
      {
        question: "Can I do complex queries in basefyio that I can't in Firebase?",
        answer:
          "Yes. basefyio supports joins, aggregations, window functions, and transactions on the server, which document databases like Firestore handle awkwardly or not at all.",
      },
      {
        question: "Will I get locked in with basefyio?",
        answer:
          "No. basefyio uses standard SQL, so your schema and data are fully portable. You can self-host or move providers at any time.",
      },
    ],
  },
  {
    slug: "basefyio-vs-neon",
    competitor: "Neon",
    title: "basefyio vs. Neon: Full Backend or Serverless Database?",
    description:
      "Compare basefyio and Neon: Neon is a serverless database with branching; basefyio is a full backend with auth, storage, and an auto REST API.",
    intro:
      "Both provide a SQL database. Neon began as a serverless database with branching and scale-to-zero, and its documentation now lists more backend services beside it. basefyio is a complete backend from the start: a database, authentication, storage and an auto-generated REST API for every project.",
    positioning:
      "If you mainly want a managed, serverless database with branching, Neon is a strong choice. If you want a self-hostable backend where each project gets its own database, authentication realm and API, that is what basefyio provides.",
    rows: [
      {
        feature: "What it is",
        basefyio: "Full backend (DB + auth + storage + API)",
        competitor: "Serverless database",
      },
      // CHECKED 2026-11-26: Neon's docs index now lists managed auth, a Data API, realtime, functions and object storage next to the database.
      {
        feature: "Auto REST API",
        basefyio: "Yes, auto-generated",
        competitor: "A Data API is listed in its documentation",
        competitorSource: "https://neon.com/docs",
      },
      {
        feature: "Authentication",
        basefyio: "Built in (dedicated realm per project)",
        competitor: "Managed authentication, listed in its documentation",
        competitorSource: "https://neon.com/docs",
      },
      {
        feature: "Storage",
        basefyio: "Built in (S3-compatible)",
        competitor: "Object storage, listed in its documentation",
        competitorSource: "https://neon.com/docs",
      },
      {
        feature: "Database branching",
        basefyio: "Preview branches: disposable projects created from a project's schema, optionally its data",
        // VERIFY: Neon's branching wording; its docs say its auth "branches with your database".
        competitor: "Yes, a core feature",
        competitorSource: "https://neon.com/docs",
      },
      {
        feature: "Self-hosting",
        basefyio: "First-class (Docker Compose)",
        competitor: "Managed cloud service",
      },
    ],
    faqs: [
      {
        question: "How does basefyio compare to Neon?",
        answer:
          "They overlap more than they used to: Neon's documentation now lists managed auth, a data API and storage beside its database. The main differences are that basefyio is self-hostable and gives every project a dedicated database and authentication realm, while Neon is a managed service built around branching and scale-to-zero.",
      },
      {
        question: "Does basefyio support database branching like Neon?",
        answer:
          "basefyio has preview branches: disposable projects created from a project's schema, optionally with its data, so you can try a migration without touching the original. Neon's branching is a core part of its platform, so compare the details on both documentation pages.",
      },
    ],
  },
  {
    slug: "basefyio-vs-appwrite",
    competitor: "Appwrite",
    title: "basefyio vs. Appwrite: SQL-Native or Abstracted Backend?",
    description:
      "Compare basefyio and Appwrite: both are open, self-hostable backends with auth, storage, and databases. basefyio offers direct SQL access; Appwrite abstracts the database.",
    intro:
      "basefyio and Appwrite are both self-hostable backend platforms offering authentication, storage, and a database. The biggest difference is the database layer: basefyio gives you a standard SQL database with full SQL access, while Appwrite provides its own database abstraction.",
    positioning:
      "basefyio is SQL-native: you write real SQL, use row-level security, and keep full portability. Appwrite offers a polished cross-platform SDK suite and its own collections model. If direct SQL, relational power, and data portability matter most, basefyio fits; if you want Appwrite's broad SDK ecosystem and document-style collections, that's its strength.",
    rows: [
      {
        feature: "Database",
        basefyio: "Standard SQL database, full SQL",
        competitor: "Abstracted collections (over MariaDB)",
      },
      {
        feature: "Direct SQL access",
        basefyio: "Yes",
        competitor: "Limited; via the collections API",
      },
      {
        feature: "Auto REST API",
        basefyio: "Auto-generated from your schema",
        competitor: "REST/GraphQL via SDK",
      },
      {
        feature: "Authentication",
        basefyio: "Dedicated auth realm per project",
        competitor: "Built-in auth + OAuth providers",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Docker (open source)",
      },
      {
        feature: "Portability",
        basefyio: "Standard SQL, fully portable",
        competitor: "Appwrite-specific data model",
      },
    ],
    faqs: [
      {
        question: "Is basefyio an Appwrite alternative?",
        answer:
          "Yes. Both are open, self-hostable backends with auth, storage, and databases. The deciding factor is usually whether you want direct SQL access (basefyio) or Appwrite's collections model and SDK ecosystem.",
      },
      {
        question: "Can I use raw SQL with basefyio but not Appwrite?",
        answer:
          "basefyio exposes a standard SQL database, so you write SQL directly and use features like joins, transactions, and row-level security. Appwrite works through its own database API rather than raw SQL.",
      },
    ],
  },
  {
    slug: "basefyio-vs-pocketbase",
    competitor: "PocketBase",
    title: "basefyio vs. PocketBase: Full Platform or Single-File SQLite?",
    description:
      "Compare basefyio and PocketBase: PocketBase is a single Go binary on SQLite; basefyio is a full backend with a dedicated database per project. Pick the right scale.",
    intro:
      "PocketBase is a small open source backend on an embedded SQLite database, with auth, realtime and an admin dashboard in one executable. basefyio runs a dedicated database per project and is built for teams that want separate, isolated projects and a hosted or self-hosted platform.",
    positioning:
      "PocketBase is a good fit for a quick prototype or a small app you want to run from one file; its own documentation notes that it is not yet recommended for production-critical applications. basefyio gives each project its own database and authentication realm, which suits several projects or teams that need isolation.",
    rows: [
      {
        feature: "Database",
        basefyio: "Dedicated database (per-project)",
        // CHECKED 2026-11-26: docs: embedded database (SQLite) with realtime subscriptions.
        competitor: "SQLite (embedded)",
        competitorSource: "https://pocketbase.io/docs/",
      },
      {
        feature: "Deployment",
        basefyio: "Docker Compose stack",
        competitor: "A single executable (Go)",
        competitorSource: "https://pocketbase.io/docs/",
      },
      {
        feature: "Concurrency / scale",
        basefyio: "Dedicated database per project, with connection pooling",
        competitor: "Its docs say it is not yet recommended for production-critical applications",
        competitorSource: "https://pocketbase.io/docs/",
      },
      {
        feature: "Auth",
        basefyio: "Dedicated auth realm per project",
        competitor: "Built-in auth",
      },
      {
        feature: "Realtime",
        basefyio: "Change events, presence and broadcast over one SSE stream",
        competitor: "Built-in",
      },
      {
        feature: "Admin UI",
        basefyio: "Admin dashboard + SQL editor",
        competitor: "Built-in admin UI",
      },
    ],
    faqs: [
      {
        question: "How does basefyio compare to PocketBase?",
        answer:
          "PocketBase is a small open source backend on an embedded SQLite database, run from one executable. basefyio gives each project a dedicated database and authentication realm and can be self-hosted or used as a hosted service. PocketBase's own documentation says it is not yet recommended for production-critical applications.",
      },
      {
        question: "When is PocketBase the better choice?",
        answer:
          "For a prototype or a small app you want to run from one file, with auth, realtime and an admin dashboard included. Choose basefyio when you need several isolated projects, a dedicated SQL database per project, or a platform with a dashboard and SQL editor.",
      },
    ],
  },
  {
    slug: "basefyio-vs-nhost",
    competitor: "Nhost",
    title: "basefyio vs. Nhost: REST or GraphQL Backend?",
    description:
      "Compare basefyio and Nhost: both are open backends with auth and storage. Nhost is GraphQL-first via Hasura; basefyio offers an auto-generated REST API.",
    intro:
      "basefyio and Nhost are both open backends with authentication and storage built on a relational database. The headline difference is the API style: Nhost is GraphQL-first, while basefyio exposes an auto-generated REST API.",
    positioning:
      "If your team prefers GraphQL, Nhost is a strong choice. If you prefer REST, with simple HTTP and no GraphQL client, basefyio's auto-generated REST API maps onto your schema and row-level security.",
    rows: [
      {
        feature: "API style",
        basefyio: "REST (auto-generated)",
        // CHECKED 2026-11-26: README names Hasura; its docs describe its own GraphQL engine too, so the engine is not claimed.
        competitor: "GraphQL-first API",
        competitorSource: "https://docs.nhost.io/products/graphql",
      },
      {
        feature: "Database",
        basefyio: "Dedicated database, per-project",
        competitor: "Dedicated database instance per project",
        competitorSource: "https://docs.nhost.io/products/database",
      },
      {
        feature: "Authentication",
        basefyio: "Dedicated auth realm per project",
        competitor: "Built-in authentication service",
        competitorSource: "https://docs.nhost.io/products/auth",
      },
      {
        feature: "Storage",
        basefyio: "S3-compatible",
        competitor: "S3-compatible file storage",
        competitorSource: "https://docs.nhost.io/products/storage",
      },
      {
        feature: "Permissions",
        basefyio: "Row-level security",
        competitor: "Role-based permissions at row and column level",
        competitorSource: "https://docs.nhost.io/products/graphql",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Open source (MIT) and a hosted platform",
        competitorSource: "https://github.com/nhost/nhost",
      },
    ],
    faqs: [
      {
        question: "How does basefyio compare to Nhost?",
        answer:
          "Both are open backends with authentication and storage on a relational database. The main choice is the API style: Nhost is GraphQL-first, basefyio exposes an auto-generated REST API.",
      },
      {
        question: "Does basefyio support GraphQL?",
        answer:
          "basefyio focuses on a REST API. If GraphQL is a hard requirement, Nhost's GraphQL-first approach may suit you better; if you prefer REST, basefyio is a natural fit.",
      },
    ],
  },
  {
    slug: "basefyio-vs-render",
    competitor: "Render",
    title: "basefyio vs. Render: Backend Platform or App Hosting?",
    description:
      "Compare basefyio and Render: Render hosts apps and managed databases; basefyio gives you a ready backend — auth, storage, and an auto REST API — without writing the server.",
    intro:
      "Render is a cloud platform for deploying web services, workers, and managed databases. basefyio is a backend itself: it provides the database plus auth, storage, and an auto-generated REST API, so you don't write that server code at all.",
    positioning:
      "With Render you deploy and operate your own backend code next to a managed database. With basefyio the backend already exists — define a table and it's instantly an API with auth and storage. Use Render when you need to run custom services; use basefyio when you want the backend handed to you.",
    rows: [
      {
        feature: "What it is",
        basefyio: "Backend-as-a-service",
        competitor: "App hosting + managed database",
      },
      {
        feature: "Auto REST API",
        basefyio: "Yes, from your schema",
        // CHECKED 2026-11-26: docs list no data API or end-user auth product (its REST API manages Render infrastructure); stated by absence.
        competitor: "No data API in its docs; you build it",
        competitorSource: "https://render.com/docs",
      },
      {
        feature: "Authentication",
        basefyio: "Built in",
        competitor: "No end-user auth product in its docs; you implement it",
        competitorSource: "https://render.com/docs",
      },
      {
        feature: "Storage",
        basefyio: "Built in (S3-compatible)",
        competitor: "Persistent disks; no object storage product listed in its docs",
        competitorSource: "https://render.com/docs",
      },
      {
        feature: "Custom services",
        basefyio: "Use alongside your own apps",
        competitor: "Core strength",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Managed cloud platform",
      },
    ],
    faqs: [
      {
        question: "How does basefyio relate to Render?",
        answer:
          "They sit at different layers. Render hosts the code you write, alongside managed databases; basefyio is the backend itself, so you write less of it. Many teams could run custom services on a platform like Render and use basefyio for the data, auth and storage backend.",
      },
      {
        question: "Can I run custom services next to basefyio?",
        answer:
          "Yes. basefyio handles the database, auth, storage and REST API; you can run any custom services you need alongside it and call the basefyio API from them.",
      },
    ],
  },
  {
    slug: "basefyio-vs-aws-amplify",
    competitor: "AWS Amplify",
    title: "basefyio vs. AWS Amplify: Standard SQL or the AWS Stack?",
    description:
      "Compare basefyio and AWS Amplify: Amplify ties your backend to AWS services like Cognito and DynamoDB; basefyio is a standard SQL backend, self-hostable, with no vendor lock-in.",
    intro:
      "AWS Amplify bundles AWS building blocks — Cognito for auth, AppSync/DynamoDB or relational data, S3 for storage — behind a unified developer experience. basefyio delivers similar capabilities on a standard SQL database, self-hostable, without committing to one cloud.",
    positioning:
      "If you are all-in on AWS, Amplify's integration is convenient. If you want a standard SQL database you can export and move, and the option to self-host with no proprietary services to learn, basefyio is built for that.",
    rows: [
      {
        feature: "Database",
        basefyio: "Standard SQL database",
        // CHECKED 2026-11-26: data is DynamoDB via AppSync; existing MySQL/Postgres databases can be connected.
        competitor: "DynamoDB through AppSync; existing MySQL or Postgres databases can be connected",
        competitorSource: "https://docs.amplify.aws/react/build-a-backend/data/set-up-data/",
      },
      {
        feature: "Authentication",
        basefyio: "Dedicated auth realm per project",
        competitor: "Amazon Cognito",
        competitorSource: "https://docs.amplify.aws/react/build-a-backend/auth/set-up-auth/",
      },
      {
        feature: "API",
        basefyio: "Auto-generated REST API",
        competitor: "AppSync (GraphQL) / REST",
      },
      {
        feature: "Storage",
        basefyio: "S3-compatible object storage",
        competitor: "Amazon S3",
        competitorSource: "https://docs.amplify.aws/react/build-a-backend/storage/set-up-storage/",
      },
      {
        feature: "Lock-in",
        basefyio: "Portable, no cloud lock-in",
        competitor: "Built on AWS services",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose, any host",
        competitor: "Deploys to your own AWS account",
        competitorSource: "https://docs.amplify.aws/",
      },
    ],
    faqs: [
      {
        question: "How does basefyio compare to AWS Amplify?",
        answer:
          "Amplify bundles AWS services, such as Cognito for auth, AppSync and DynamoDB for data and S3 for storage, and deploys them to your AWS account. basefyio offers auth, storage and an API on a standard SQL database that you can run on your own infrastructure.",
      },
      {
        question: "Can I move my data later?",
        answer:
          "basefyio uses a standard SQL database, so you can dump and restore your data elsewhere. Moving off AWS-specific services such as Cognito and DynamoDB depends on how your app uses them.",
      },
    ],
  },
  {
    slug: "basefyio-vs-convex",
    competitor: "Convex",
    title: "basefyio vs. Convex: Standard SQL or a Reactive TS Backend?",
    description:
      "Compare basefyio and Convex: Convex is a reactive, TypeScript-first backend with its own database; basefyio is a standard SQL backend with a REST API, auth, and storage.",
    intro:
      "Convex is a reactive backend where you write TypeScript functions against its own database and get realtime updates built in. basefyio is built on a standard SQL database with an auto-generated REST API, authentication, storage and realtime change events.",
    positioning:
      "Convex is compelling if you want a tightly integrated, realtime, TypeScript-native model. basefyio is for teams who want standard SQL, data they can dump and restore, and a self-hostable platform with REST rather than a function-based model.",
    rows: [
      {
        feature: "Database",
        basefyio: "Standard SQL database",
        competitor: "Reactive database with TypeScript queries",
        competitorSource: "https://docs.convex.dev/",
      },
      {
        feature: "Programming model",
        basefyio: "SQL + REST API",
        competitor: "TypeScript functions",
      },
      {
        feature: "Realtime",
        basefyio: "Change events, presence and broadcast over one SSE stream",
        competitor: "Built in, reactive by default",
        competitorSource: "https://docs.convex.dev/realtime",
      },
      {
        feature: "Authentication",
        basefyio: "Dedicated auth realm per project",
        // CHECKED 2026-11-26: Convex Auth is built in; Clerk, WorkOS, Auth0 and custom OIDC are supported too.
        competitor: "Convex Auth built in, plus third-party providers",
        competitorSource: "https://docs.convex.dev/auth/overview",
      },
      {
        feature: "Portability",
        basefyio: "Standard SQL, fully portable",
        competitor: "Its own data model; data can be exported to a zip file",
        competitorSource: "https://docs.convex.dev/database/import-export/export",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        // CHECKED 2026-11-26: docs: the open-source backend can be self-hosted; license is FSL Apache 2.0 (fair source).
        competitor: "Cloud, or self-hosted under a fair-source license",
        competitorSource: "https://docs.convex.dev/self-hosting",
      },
    ],
    faqs: [
      {
        question: "How does basefyio compare to Convex?",
        answer:
          "Convex is a reactive backend with its own database and TypeScript functions, and realtime built in. basefyio is built on a standard SQL database with a REST API, authentication, storage and realtime change events. Convex's backend can be self-hosted under a fair-source license; basefyio's server is AGPL-3.0-or-later.",
      },
      {
        question: "Does basefyio have realtime like Convex?",
        answer:
          "basefyio publishes change events for the tables and collections you enable, plus presence and broadcast, over one server-sent-events stream. Convex's reactive queries are a core part of its model and work differently, so compare them against your needs.",
      },
    ],
  },
  {
    slug: "basefyio-vs-hasura",
    competitor: "Hasura",
    title: "basefyio vs. Hasura: REST Backend or GraphQL Engine?",
    description:
      "Compare basefyio and Hasura: Hasura generates a GraphQL API over your database; basefyio is a full backend with a REST API plus built-in auth and storage.",
    intro:
      "Hasura is a GraphQL engine that instantly exposes your database as a GraphQL API with a powerful permission system. basefyio is a complete backend with a REST API plus built-in authentication and storage.",
    positioning:
      "If you want GraphQL and a rich permissions layer over an existing database, Hasura is purpose-built for that. If you prefer REST and want auth and storage included as part of one backend — not assembled separately — basefyio fits better.",
    rows: [
      {
        feature: "API style",
        basefyio: "REST (auto-generated)",
        competitor: "GraphQL (a REST-style JSON:API is in alpha in v3)",
        competitorSource: "https://hasura.io/docs/3.0/json-api/overview/",
      },
      {
        feature: "Scope",
        basefyio: "Full backend (DB + auth + storage + API)",
        competitor: "API layer over your database",
      },
      {
        feature: "Authentication",
        basefyio: "Built in (dedicated auth realm)",
        // CHECKED 2026-11-26: docs: Hasura is agnostic about authentication (JWT, webhook or no auth); it bundles no auth service.
        competitor: "Bring your own auth (JWT or webhook)",
        competitorSource: "https://hasura.io/docs/3.0/auth/overview/",
      },
      {
        feature: "Storage",
        basefyio: "Built in (S3-compatible)",
        competitor: "No file storage product in its docs",
        competitorSource: "https://hasura.io/docs/",
      },
      {
        feature: "Permissions",
        basefyio: "Row-level security",
        competitor: "Access-control rules (permissions)",
        competitorSource: "https://hasura.io/docs/3.0/auth/overview/",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Open-source engine (Apache-2.0) and a managed cloud",
        competitorSource: "https://github.com/hasura/graphql-engine",
      },
    ],
    faqs: [
      {
        question: "How does basefyio compare to Hasura?",
        answer:
          "They overlap on exposing a database as an API but differ in style and scope. Hasura is GraphQL-focused and expects you to bring your own authentication; basefyio offers a REST API with authentication and storage built in.",
      },
      {
        question: "When should I choose Hasura?",
        answer:
          "When GraphQL and its permission model are central to your stack, or you already have a database and an auth provider. Choose basefyio if you want a REST API and a backend that already includes authentication and storage.",
      },
    ],
  },
  {
    slug: "basefyio-vs-directus",
    competitor: "Directus",
    title: "basefyio vs. Directus: App Backend or Headless Data Platform?",
    description:
      "Compare basefyio and Directus: Directus wraps a SQL database with an admin app and APIs as a headless CMS/data platform; basefyio is an app backend with per-project database, auth, and REST.",
    intro:
      "Directus is a data platform and headless CMS that layers an admin app and REST/GraphQL APIs over an existing SQL database. basefyio is an application backend that provisions a dedicated database per project with authentication and a REST API.",
    positioning:
      "Directus shines when you want a polished admin and content studio over a database, often for content and internal data management. basefyio is aimed at application backends: a dedicated database and authentication realm per project, and a REST API for your application to build on.",
    rows: [
      {
        feature: "Primary focus",
        basefyio: "Application backend",
        competitor: "Headless CMS / data platform",
      },
      {
        feature: "Database",
        basefyio: "Dedicated database, per-project",
        competitor: "Wraps existing SQL DBs",
      },
      {
        feature: "Admin app",
        basefyio: "Dashboard + SQL editor",
        competitor: "Rich data studio / CMS",
      },
      {
        feature: "API",
        basefyio: "REST (auto-generated)",
        competitor: "REST + GraphQL",
      },
      {
        feature: "Authentication",
        basefyio: "Dedicated auth realm per project",
        competitor: "Built-in users & roles",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        // CHECKED 2026-11-26: README: Monospace Sustainable Core License 1.0, source-available; self-host or cloud.
        competitor: "Self-hosted or cloud; source-available license (MSCL)",
        competitorSource: "https://github.com/directus/directus",
      },
    ],
    faqs: [
      {
        question: "How does basefyio compare to Directus?",
        answer:
          "They overlap because both put an API over a SQL database, but their focus differs. Directus is a headless CMS and data studio that you can self-host or use in its cloud; basefyio is an application backend with a dedicated database and authentication realm per project and a REST API.",
      },
      {
        question: "Which license does Directus use?",
        answer:
          "Its repository describes the Monospace Sustainable Core License, a source-available license. Check the repository for the current terms. basefyio's server is AGPL-3.0-or-later and its SDK and CLI are MIT.",
      },
    ],
  },
  {
    slug: "basefyio-vs-strapi",
    competitor: "Strapi",
    title: "basefyio vs. Strapi: Database Backend or Headless CMS?",
    description:
      "Compare basefyio and Strapi: Strapi is a Node.js headless CMS for content types and editorial workflows; basefyio is a database backend with direct SQL, auth, and a REST API.",
    intro:
      "Strapi is a popular open-source headless CMS for modeling content types and powering editorial workflows, with REST and GraphQL APIs. basefyio is a database-first backend with direct SQL access, authentication, and a REST API.",
    positioning:
      "Strapi is the right tool when content management — editors, drafts, media libraries — is the job. basefyio is the right tool when you want a real database with SQL, row-level security, and an API for your application, rather than a CMS abstraction.",
    rows: [
      {
        feature: "Primary focus",
        basefyio: "Database/app backend",
        competitor: "Headless CMS",
        competitorSource: "https://docs.strapi.io/",
      },
      {
        feature: "Database access",
        basefyio: "Direct SQL access",
        competitor: "Through CMS content types",
        competitorSource: "https://docs.strapi.io/",
      },
      {
        feature: "API",
        basefyio: "REST (auto-generated)",
        competitor: "REST + GraphQL",
        competitorSource: "https://github.com/strapi/strapi",
      },
      {
        feature: "Authentication",
        basefyio: "Dedicated auth realm per project",
        competitor: "Users & permissions plugin",
        competitorSource: "https://docs.strapi.io/cms/features/users-permissions",
      },
      {
        feature: "Storage",
        basefyio: "S3-compatible",
        competitor: "Media library (providers)",
        competitorSource: "https://docs.strapi.io/cms/features/media-library",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Node.js (self-host)",
        competitorSource: "https://docs.strapi.io/cms/deployment",
      },
    ],
    faqs: [
      {
        question: "How does basefyio compare to Strapi?",
        answer:
          "Strapi is a headless CMS for modeling content and editorial workflows, with REST and GraphQL APIs. basefyio gives you a real database with direct SQL access, authentication and a REST API, rather than a CMS abstraction.",
      },
      {
        question: "When should I choose Strapi?",
        answer:
          "When your core need is content management, such as editors, drafts and a media library. For an application database with SQL and row-level security, choose basefyio.",
      },
    ],
  },
  {
    slug: "basefyio-vs-xata",
    competitor: "Xata",
    title: "basefyio vs. Xata: Full Backend or Serverless Data Platform?",
    description:
      "Compare basefyio and Xata: Xata is a serverless data platform with branching and search; basefyio is a full backend with auth, storage, and a REST API.",
    intro:
      "Xata is a branch-native Postgres platform with copy-on-write branches and anonymized clones. basefyio is a complete backend that adds authentication, storage and a REST API around the database, with preview branches of its own.",
    positioning:
      "Xata is a strong choice if you want a branching database layer to plug into your own app code. basefyio is for teams who want the backend itself, with auth, storage and an API included, and the option to self-host the whole stack.",
    rows: [
      {
        feature: "What it is",
        basefyio: "Full backend (DB + auth + storage + API)",
        // CHECKED 2026-11-26: docs describe a branch-native Postgres platform.
        competitor: "Branch-native Postgres platform",
        competitorSource: "https://xata.io/docs",
      },
      {
        feature: "Built-in auth",
        basefyio: "Yes (dedicated auth realm)",
        competitor: "No end-user auth product in its docs",
        competitorSource: "https://xata.io/docs/llms.txt",
      },
      {
        feature: "Built-in storage",
        basefyio: "Yes (S3-compatible)",
        competitor: "No file storage product in its docs",
        competitorSource: "https://xata.io/docs/llms.txt",
      },
      {
        feature: "Search",
        basefyio: "Full-text search filters in the REST API",
        // CHECKED 2026-11-26: no search-engine product in its docs; Postgres extensions for trigram and vector similarity search are listed.
        competitor: "Postgres extensions for text and vector similarity search",
        competitorSource: "https://xata.io/docs/platform/extensions.md",
      },
      {
        feature: "Branching",
        basefyio: "Preview branches: disposable projects created from a project's schema, optionally its data",
        competitor: "Yes",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        // CHECKED 2026-11-26: docs: cloud, your own cloud account or on-prem (BYOC); the control plane stays with Xata.
        competitor: "Xata cloud, or in your own cloud or on-prem (BYOC)",
        competitorSource: "https://xata.io/docs/core-concepts/deployment.md",
      },
    ],
    faqs: [
      {
        question: "How does basefyio compare to Xata?",
        answer:
          "Xata is a branch-native Postgres platform with copy-on-write branches. basefyio is a full backend with authentication, storage and a REST API around a dedicated database, and it can be self-hosted. Both offer branching: basefyio's preview branches are disposable projects created from a project's schema.",
      },
      {
        question: "Does basefyio have search?",
        answer:
          "basefyio's REST API supports full-text search filters. Xata's documentation lists Postgres extensions for text and vector similarity search rather than a separate search engine.",
      },
    ],
  },
];

/** Hand-reviewed, answer-first entries replace the generic ones with the same slug. */
export const COMPARISONS: Comparison[] = BASE_COMPARISONS.map(
  (c) => FEATURED_COMPARISONS[c.slug] ?? c,
);

export function getComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

export function getComparisonSlugs(): string[] {
  return COMPARISONS.map((c) => c.slug);
}
