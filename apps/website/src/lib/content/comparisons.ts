import type { FaqItem } from "@/lib/seo/json-ld";

/**
 * Data registry powering the programmatic `/compare/[slug]` pages. Add an entry
 * here and the comparison page, index card, sitemap, and JSON-LD all update
 * automatically — no per-page React required.
 */
export type ComparisonRow = {
  feature: string;
  kolaybase: string;
  competitor: string;
};

export type Comparison = {
  slug: string;
  /** Competitor display name, e.g. "Supabase". */
  competitor: string;
  title: string;
  description: string;
  /** Lead paragraph shown under the H1. */
  intro: string;
  /** Honest, specific positioning — what Kolaybase does differently. */
  positioning: string;
  rows: ComparisonRow[];
  faqs: FaqItem[];
};

export const COMPARISONS: Comparison[] = [
  {
    slug: "kolaybase-vs-supabase",
    competitor: "Supabase",
    title: "Kolaybase vs. Supabase: Which PostgreSQL Backend Should You Use?",
    description:
      "A detailed, honest comparison of Kolaybase and Supabase: hosting model, database isolation, REST API, auth, pricing, and lock-in. Find the right PostgreSQL backend for your stack.",
    intro:
      "Both Kolaybase and Supabase give you a PostgreSQL database with an auto-generated REST API, authentication, and storage. The differences come down to isolation, self-hosting, and how the platform is operated.",
    positioning:
      "Kolaybase provisions a dedicated PostgreSQL database and an isolated auth realm per project, and is built to be self-hosted with Docker Compose from day one. If you want true single-tenant isolation and full control of where your data runs, that's the core distinction.",
    rows: [
      {
        feature: "Database model",
        kolaybase: "Dedicated PostgreSQL database per project",
        competitor: "PostgreSQL project (schema-based isolation)",
      },
      {
        feature: "Self-hosting",
        kolaybase: "First-class, Docker Compose included",
        competitor: "Supported, more involved setup",
      },
      {
        feature: "Auto REST API",
        kolaybase: "Yes, PostgREST-style",
        competitor: "Yes, PostgREST",
      },
      {
        feature: "Authentication",
        kolaybase: "Keycloak realm per project (OAuth + email)",
        competitor: "GoTrue (email, OAuth, magic links)",
      },
      {
        feature: "Storage",
        kolaybase: "S3-compatible (MinIO)",
        competitor: "S3-compatible",
      },
      {
        feature: "Query language",
        kolaybase: "Standard SQL, no lock-in",
        competitor: "Standard SQL, no lock-in",
      },
      {
        feature: "Realtime",
        kolaybase: "Roadmap",
        competitor: "Built-in",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase a Supabase alternative?",
        answer:
          "Yes. Kolaybase offers the same core building blocks — hosted PostgreSQL, an auto-generated REST API, authentication, and object storage — with a per-project dedicated database and a self-hosting-first design.",
      },
      {
        question: "Can I migrate from Supabase to Kolaybase?",
        answer:
          "Because both are standard PostgreSQL, you can export your schema and data with pg_dump and import it into a Kolaybase project. There is no proprietary query language to rewrite.",
      },
      {
        question: "Does Kolaybase have realtime subscriptions?",
        answer:
          "Realtime is on the roadmap. Today Kolaybase focuses on database, REST API, auth, and storage. If realtime is a hard requirement right now, factor that into your decision.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-firebase",
    competitor: "Firebase",
    title: "Kolaybase vs. Firebase: SQL Backend or NoSQL? A Practical Comparison",
    description:
      "Compare Kolaybase and Firebase across data model, queries, relational integrity, pricing predictability, and vendor lock-in. Choose the right backend for your app.",
    intro:
      "Firebase is a NoSQL document platform; Kolaybase is built on relational PostgreSQL. The choice shapes how you model data, query it, and avoid lock-in.",
    positioning:
      "If your data is relational — users, orders, posts with relationships — Kolaybase's SQL foundation lets you express joins, constraints, and transactions natively. Firebase shines for simple document/realtime workloads but makes complex queries and migrations harder, and its data model is proprietary.",
    rows: [
      {
        feature: "Data model",
        kolaybase: "Relational (PostgreSQL)",
        competitor: "NoSQL document store",
      },
      {
        feature: "Queries",
        kolaybase: "Full SQL: joins, aggregates, transactions",
        competitor: "Limited; no server-side joins",
      },
      {
        feature: "Schema & constraints",
        kolaybase: "Enforced by PostgreSQL",
        competitor: "Schemaless; enforced in app/rules",
      },
      {
        feature: "REST API",
        kolaybase: "Auto-generated, PostgREST-style",
        competitor: "SDK-first; REST is limited",
      },
      {
        feature: "Lock-in",
        kolaybase: "Standard SQL, portable",
        competitor: "Proprietary data model",
      },
      {
        feature: "Pricing model",
        kolaybase: "Predictable, self-hostable",
        competitor: "Usage-based, can spike",
      },
      {
        feature: "Realtime",
        kolaybase: "Roadmap",
        competitor: "Core strength",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase a good Firebase alternative?",
        answer:
          "For relational data and apps that benefit from SQL, yes. Kolaybase gives you PostgreSQL with auth, storage, and a REST API. If you need NoSQL documents and best-in-class realtime above all, Firebase may fit better.",
      },
      {
        question: "Can I do complex queries in Kolaybase that I can't in Firebase?",
        answer:
          "Yes. PostgreSQL supports joins, aggregations, window functions, and transactions on the server, which document databases like Firestore handle awkwardly or not at all.",
      },
      {
        question: "Will I get locked in with Kolaybase?",
        answer:
          "No. Kolaybase uses standard PostgreSQL, so your schema and data are fully portable with pg_dump. You can self-host or move providers at any time.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-neon",
    competitor: "Neon",
    title: "Kolaybase vs. Neon: Full Backend or Serverless Postgres?",
    description:
      "Compare Kolaybase and Neon: Neon is serverless PostgreSQL with branching; Kolaybase is a full backend with auth, storage, and an auto REST API on top of Postgres.",
    intro:
      "Both are built on PostgreSQL, but they solve different layers. Neon is a serverless Postgres database with branching and scale-to-zero. Kolaybase is a complete backend — database plus authentication, storage, and an auto-generated REST API.",
    positioning:
      "If you only need a managed, serverless Postgres to plug into your own backend, Neon is excellent. If you want the database and the backend around it — auth, storage, and an instant API — without wiring those yourself, that's what Kolaybase provides. They can even be complementary: Neon for the DB, your own services on top, vs. Kolaybase giving you the whole stack.",
    rows: [
      {
        feature: "What it is",
        kolaybase: "Full backend (DB + auth + storage + API)",
        competitor: "Serverless PostgreSQL database",
      },
      {
        feature: "Auto REST API",
        kolaybase: "Yes, PostgREST-style",
        competitor: "No — bring your own API layer",
      },
      {
        feature: "Authentication",
        kolaybase: "Built in (Keycloak realm per project)",
        competitor: "Not included",
      },
      {
        feature: "Storage",
        kolaybase: "Built in (S3-compatible)",
        competitor: "Not included",
      },
      {
        feature: "Database branching",
        kolaybase: "Not built in",
        competitor: "Yes, a core strength",
      },
      {
        feature: "Self-hosting",
        kolaybase: "First-class (Docker Compose)",
        competitor: "Managed cloud service",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase a Neon alternative?",
        answer:
          "They overlap on PostgreSQL but differ in scope. Neon is a serverless database; Kolaybase is a full backend. Choose Kolaybase if you want auth, storage, and an API included; choose Neon if you only need the database and branching.",
      },
      {
        question: "Does Kolaybase support database branching like Neon?",
        answer:
          "Branching is a Neon specialty and not a built-in Kolaybase feature today. Kolaybase focuses on giving you a complete, self-hostable backend around standard PostgreSQL.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-appwrite",
    competitor: "Appwrite",
    title: "Kolaybase vs. Appwrite: PostgreSQL-Native or Abstracted Backend?",
    description:
      "Compare Kolaybase and Appwrite: both are open, self-hostable backends with auth, storage, and databases. Kolaybase is PostgreSQL-native with direct SQL; Appwrite abstracts the database.",
    intro:
      "Kolaybase and Appwrite are both self-hostable backend platforms offering authentication, storage, and a database. The biggest difference is the database layer: Kolaybase gives you standard PostgreSQL with full SQL access, while Appwrite provides its own database abstraction.",
    positioning:
      "Kolaybase is PostgreSQL-native: you write real SQL, use row-level security, and keep full portability via pg_dump. Appwrite offers a polished cross-platform SDK suite and its own collections model. If direct SQL, relational power, and Postgres portability matter most, Kolaybase fits; if you want Appwrite's broad SDK ecosystem and document-style collections, that's its strength.",
    rows: [
      {
        feature: "Database",
        kolaybase: "Standard PostgreSQL, full SQL",
        competitor: "Abstracted collections (over MariaDB)",
      },
      {
        feature: "Direct SQL access",
        kolaybase: "Yes",
        competitor: "Limited; via the collections API",
      },
      {
        feature: "Auto REST API",
        kolaybase: "PostgREST-style from your schema",
        competitor: "REST/GraphQL via SDK",
      },
      {
        feature: "Authentication",
        kolaybase: "Keycloak realm per project",
        competitor: "Built-in auth + OAuth providers",
      },
      {
        feature: "Self-hosting",
        kolaybase: "Docker Compose",
        competitor: "Docker (open source)",
      },
      {
        feature: "Portability",
        kolaybase: "Standard SQL, pg_dump",
        competitor: "Appwrite-specific data model",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase an Appwrite alternative?",
        answer:
          "Yes. Both are open, self-hostable backends with auth, storage, and databases. The deciding factor is usually whether you want PostgreSQL-native SQL (Kolaybase) or Appwrite's collections model and SDK ecosystem.",
      },
      {
        question: "Can I use raw SQL with Kolaybase but not Appwrite?",
        answer:
          "Kolaybase exposes standard PostgreSQL, so you write SQL directly and use features like joins, transactions, and row-level security. Appwrite works through its own database API rather than raw SQL.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-pocketbase",
    competitor: "PocketBase",
    title: "Kolaybase vs. PocketBase: PostgreSQL Platform or Single-File SQLite?",
    description:
      "Compare Kolaybase and PocketBase: PocketBase is a single Go binary on SQLite; Kolaybase is a PostgreSQL backend with a dedicated database per project. Pick the right scale.",
    intro:
      "PocketBase is a delightfully simple single-file backend on SQLite — auth, realtime, file storage, and an admin UI in one Go binary. Kolaybase is a PostgreSQL-based platform with a dedicated database per project, aimed at multi-tenant, production-scale workloads.",
    positioning:
      "PocketBase is hard to beat for a quick prototype or a small app you want to run from one binary. Kolaybase trades that single-file simplicity for PostgreSQL's scale and concurrency, per-project database isolation, and Keycloak-grade auth — better suited as apps and teams grow.",
    rows: [
      {
        feature: "Database",
        kolaybase: "PostgreSQL (per-project DB)",
        competitor: "SQLite (single file)",
      },
      {
        feature: "Deployment",
        kolaybase: "Docker Compose stack",
        competitor: "Single Go binary",
      },
      {
        feature: "Concurrency / scale",
        kolaybase: "High (PostgreSQL)",
        competitor: "Best for smaller workloads",
      },
      {
        feature: "Auth",
        kolaybase: "Keycloak realm per project",
        competitor: "Built-in auth",
      },
      {
        feature: "Realtime",
        kolaybase: "Roadmap",
        competitor: "Built-in",
      },
      {
        feature: "Admin UI",
        kolaybase: "Admin dashboard + SQL editor",
        competitor: "Built-in admin UI",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase a PocketBase alternative?",
        answer:
          "Yes, for teams that outgrow SQLite. PocketBase is ideal for small apps and prototypes in a single binary; Kolaybase gives you PostgreSQL, per-project isolation, and platform features for production multi-tenant apps.",
      },
      {
        question: "When should I pick PocketBase over Kolaybase?",
        answer:
          "If you want the absolute simplest deployment (one file), a small dataset, and built-in realtime today, PocketBase is a great fit. Choose Kolaybase when you need PostgreSQL's scale, concurrency, and database-per-project isolation.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-nhost",
    competitor: "Nhost",
    title: "Kolaybase vs. Nhost: REST or GraphQL on PostgreSQL?",
    description:
      "Compare Kolaybase and Nhost: both are open backends on PostgreSQL with auth and storage. Nhost is GraphQL-first via Hasura; Kolaybase offers a PostgREST-style REST API.",
    intro:
      "Kolaybase and Nhost are both PostgreSQL-based, open backends with authentication and storage. The headline difference is the API style: Nhost is GraphQL-first (powered by Hasura), while Kolaybase exposes a PostgREST-style REST API.",
    positioning:
      "If your team prefers GraphQL and Hasura's permission model, Nhost is a strong choice. If you prefer REST — simple HTTP, easy caching, no GraphQL client required — Kolaybase's auto-generated REST API maps cleanly onto your schema and row-level security.",
    rows: [
      {
        feature: "API style",
        kolaybase: "REST (PostgREST-style)",
        competitor: "GraphQL (Hasura)",
      },
      {
        feature: "Database",
        kolaybase: "PostgreSQL, per-project DB",
        competitor: "PostgreSQL",
      },
      {
        feature: "Authentication",
        kolaybase: "Keycloak realm per project",
        competitor: "Built-in auth",
      },
      {
        feature: "Storage",
        kolaybase: "S3-compatible",
        competitor: "S3-compatible",
      },
      {
        feature: "Permissions",
        kolaybase: "PostgreSQL row-level security",
        competitor: "Hasura permission rules",
      },
      {
        feature: "Self-hosting",
        kolaybase: "Docker Compose",
        competitor: "Open source / cloud",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase an Nhost alternative?",
        answer:
          "Yes. Both are open, PostgreSQL-based backends with auth and storage. The main choice is REST (Kolaybase) versus GraphQL via Hasura (Nhost).",
      },
      {
        question: "Does Kolaybase support GraphQL?",
        answer:
          "Kolaybase focuses on a REST API today. If GraphQL is a hard requirement, Nhost's Hasura-based approach may suit you better; if you prefer REST, Kolaybase is a natural fit.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-render",
    competitor: "Render",
    title: "Kolaybase vs. Render: Backend Platform or App Hosting?",
    description:
      "Compare Kolaybase and Render: Render hosts apps and managed Postgres; Kolaybase gives you a ready backend — auth, storage, and an auto REST API — without writing the server.",
    intro:
      "Render is a cloud platform for deploying web services, workers, and managed PostgreSQL. Kolaybase is a backend itself: it provides the database plus auth, storage, and an auto-generated REST API, so you don't write that server code at all.",
    positioning:
      "With Render you deploy and operate your own backend code next to a managed database. With Kolaybase the backend already exists — define a table and it's instantly an API with auth and storage. Use Render when you need to run custom services; use Kolaybase when you want the backend handed to you.",
    rows: [
      {
        feature: "What it is",
        kolaybase: "Backend-as-a-service",
        competitor: "App hosting + managed Postgres",
      },
      {
        feature: "Auto REST API",
        kolaybase: "Yes, from your schema",
        competitor: "No — you build the API",
      },
      {
        feature: "Authentication",
        kolaybase: "Built in",
        competitor: "You implement it",
      },
      {
        feature: "Storage",
        kolaybase: "Built in (S3-compatible)",
        competitor: "Disks / external object storage",
      },
      {
        feature: "Custom services",
        kolaybase: "Use alongside your own apps",
        competitor: "Core strength",
      },
      {
        feature: "Self-hosting",
        kolaybase: "Docker Compose",
        competitor: "Managed cloud platform",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase an alternative to Render?",
        answer:
          "They sit at different layers. Render hosts the code you write; Kolaybase is the backend so you write less of it. Many teams could run custom workers on a platform like Render and use Kolaybase for the data/auth/storage backend.",
      },
      {
        question: "Can I still run custom backend logic with Kolaybase?",
        answer:
          "Yes. Kolaybase handles the database, auth, storage, and REST API; you can run any custom services you need alongside it and call the Kolaybase API from them.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-aws-amplify",
    competitor: "AWS Amplify",
    title: "Kolaybase vs. AWS Amplify: Standard PostgreSQL or the AWS Stack?",
    description:
      "Compare Kolaybase and AWS Amplify: Amplify ties your backend to AWS services like Cognito and DynamoDB; Kolaybase is standard PostgreSQL, self-hostable, with no vendor lock-in.",
    intro:
      "AWS Amplify bundles AWS building blocks — Cognito for auth, AppSync/DynamoDB or relational data, S3 for storage — behind a unified developer experience. Kolaybase delivers similar capabilities on standard PostgreSQL, self-hostable, without committing to one cloud.",
    positioning:
      "If you're all-in on AWS, Amplify's integration is convenient. If you want to avoid lock-in — standard PostgreSQL you can pg_dump and move, the option to self-host, and no proprietary services to learn — Kolaybase is the portable alternative.",
    rows: [
      {
        feature: "Database",
        kolaybase: "Standard PostgreSQL",
        competitor: "DynamoDB or Aurora/RDS",
      },
      {
        feature: "Authentication",
        kolaybase: "Keycloak realm per project",
        competitor: "Amazon Cognito",
      },
      {
        feature: "API",
        kolaybase: "Auto REST (PostgREST-style)",
        competitor: "AppSync (GraphQL) / REST",
      },
      {
        feature: "Storage",
        kolaybase: "S3-compatible (MinIO)",
        competitor: "Amazon S3",
      },
      {
        feature: "Lock-in",
        kolaybase: "Portable, no cloud lock-in",
        competitor: "Tied to AWS services",
      },
      {
        feature: "Self-hosting",
        kolaybase: "Docker Compose, any host",
        competitor: "AWS only",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase an AWS Amplify alternative?",
        answer:
          "Yes, especially if you want to avoid AWS lock-in. Kolaybase offers auth, storage, and an API on standard PostgreSQL that you can run anywhere, while Amplify is built around AWS-specific services.",
      },
      {
        question: "Can I move off Kolaybase more easily than off Amplify?",
        answer:
          "Because Kolaybase uses standard PostgreSQL, you can export everything with pg_dump and run it elsewhere. Amplify's reliance on services like Cognito and DynamoDB makes migration more involved.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-convex",
    competitor: "Convex",
    title: "Kolaybase vs. Convex: Standard PostgreSQL or a Reactive TS Backend?",
    description:
      "Compare Kolaybase and Convex: Convex is a reactive, TypeScript-first backend with its own database; Kolaybase is standard PostgreSQL with a REST API, auth, and storage.",
    intro:
      "Convex is a reactive backend where you write TypeScript functions against its own database and get realtime updates for free. Kolaybase is built on standard PostgreSQL with an auto-generated REST API, authentication, and storage.",
    positioning:
      "Convex is compelling if you want a tightly integrated, realtime, TypeScript-native model and are comfortable with its proprietary database. Kolaybase is for teams who want standard SQL, portability via pg_dump, and the option to self-host — with REST rather than a function-based model.",
    rows: [
      {
        feature: "Database",
        kolaybase: "Standard PostgreSQL",
        competitor: "Proprietary reactive database",
      },
      {
        feature: "Programming model",
        kolaybase: "SQL + REST API",
        competitor: "TypeScript functions",
      },
      {
        feature: "Realtime",
        kolaybase: "Roadmap",
        competitor: "Built-in, reactive by default",
      },
      {
        feature: "Authentication",
        kolaybase: "Keycloak realm per project",
        competitor: "Via integrations",
      },
      {
        feature: "Portability",
        kolaybase: "Standard SQL, pg_dump",
        competitor: "Convex-specific data model",
      },
      {
        feature: "Self-hosting",
        kolaybase: "Docker Compose",
        competitor: "Primarily managed",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase a Convex alternative?",
        answer:
          "Yes, for teams that prefer standard PostgreSQL and REST over a proprietary reactive database and a TypeScript-function model. Convex's strength is built-in realtime; Kolaybase's is SQL, portability, and self-hosting.",
      },
      {
        question: "Does Kolaybase have realtime like Convex?",
        answer:
          "Realtime reactivity is a core Convex feature. Kolaybase focuses today on database, REST API, auth, and storage, with realtime on the roadmap.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-hasura",
    competitor: "Hasura",
    title: "Kolaybase vs. Hasura: REST Backend or GraphQL Engine?",
    description:
      "Compare Kolaybase and Hasura: Hasura generates a GraphQL API over your PostgreSQL; Kolaybase is a full backend with a REST API plus built-in auth and storage.",
    intro:
      "Hasura is a GraphQL engine that instantly exposes your PostgreSQL (and other databases) as a GraphQL API with a powerful permission system. Kolaybase is a complete backend with a REST API plus built-in authentication and storage.",
    positioning:
      "If you want GraphQL and a rich permissions layer over an existing database, Hasura is purpose-built for that. If you prefer REST and want auth and storage included as part of one backend — not assembled separately — Kolaybase fits better.",
    rows: [
      {
        feature: "API style",
        kolaybase: "REST (PostgREST-style)",
        competitor: "GraphQL",
      },
      {
        feature: "Scope",
        kolaybase: "Full backend (DB + auth + storage + API)",
        competitor: "API layer over your database",
      },
      {
        feature: "Authentication",
        kolaybase: "Built in (Keycloak realm)",
        competitor: "Via external auth + JWT",
      },
      {
        feature: "Storage",
        kolaybase: "Built in (S3-compatible)",
        competitor: "Not included",
      },
      {
        feature: "Permissions",
        kolaybase: "PostgreSQL row-level security",
        competitor: "Hasura permission rules",
      },
      {
        feature: "Self-hosting",
        kolaybase: "Docker Compose",
        competitor: "Open source / cloud",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase a Hasura alternative?",
        answer:
          "They overlap on exposing PostgreSQL as an API but differ in style and scope. Hasura is GraphQL-focused and pairs with external auth; Kolaybase offers REST with auth and storage built in.",
      },
      {
        question: "Should I pick Hasura or Kolaybase?",
        answer:
          "Choose Hasura if GraphQL and its permission model are central to your stack. Choose Kolaybase if you want a REST API and a backend that already includes authentication and storage.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-directus",
    competitor: "Directus",
    title: "Kolaybase vs. Directus: App Backend or Headless Data Platform?",
    description:
      "Compare Kolaybase and Directus: Directus wraps a SQL database with an admin app and APIs as a headless CMS/data platform; Kolaybase is an app backend with per-project Postgres, auth, and REST.",
    intro:
      "Directus is an open-source data platform and headless CMS that layers an admin app and REST/GraphQL APIs over an existing SQL database. Kolaybase is an application backend that provisions a dedicated PostgreSQL database per project with authentication and a REST API.",
    positioning:
      "Directus shines when you want a polished admin/content studio over a database, often for content and internal data management. Kolaybase is aimed at app backends: per-project database isolation, Keycloak-grade auth, and a REST API for your application to build on.",
    rows: [
      {
        feature: "Primary focus",
        kolaybase: "Application backend",
        competitor: "Headless CMS / data platform",
      },
      {
        feature: "Database",
        kolaybase: "PostgreSQL, per-project DB",
        competitor: "Wraps existing SQL DBs",
      },
      {
        feature: "Admin app",
        kolaybase: "Dashboard + SQL editor",
        competitor: "Rich data studio / CMS",
      },
      {
        feature: "API",
        kolaybase: "REST (PostgREST-style)",
        competitor: "REST + GraphQL",
      },
      {
        feature: "Authentication",
        kolaybase: "Keycloak realm per project",
        competitor: "Built-in users & roles",
      },
      {
        feature: "Self-hosting",
        kolaybase: "Docker Compose",
        competitor: "Open source (self-host)",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase a Directus alternative?",
        answer:
          "They overlap because both put an API over SQL, but their focus differs. Directus is a strong headless CMS / data studio; Kolaybase is an app backend with per-project Postgres, auth, and REST.",
      },
      {
        question: "Which should I use for a content-heavy admin?",
        answer:
          "Directus's admin/content studio is purpose-built for managing content. For an application backend with isolated databases and built-in auth, Kolaybase is the better fit.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-strapi",
    competitor: "Strapi",
    title: "Kolaybase vs. Strapi: Database Backend or Headless CMS?",
    description:
      "Compare Kolaybase and Strapi: Strapi is a Node.js headless CMS for content types and editorial workflows; Kolaybase is a PostgreSQL backend with direct SQL, auth, and a REST API.",
    intro:
      "Strapi is a popular open-source headless CMS for modeling content types and powering editorial workflows, with REST and GraphQL APIs. Kolaybase is a database-first backend on PostgreSQL with direct SQL access, authentication, and a REST API.",
    positioning:
      "Strapi is the right tool when content management — editors, drafts, media libraries — is the job. Kolaybase is the right tool when you want a real PostgreSQL database with SQL, row-level security, and an API for your application, rather than a CMS abstraction.",
    rows: [
      {
        feature: "Primary focus",
        kolaybase: "Database/app backend",
        competitor: "Headless CMS",
      },
      {
        feature: "Database access",
        kolaybase: "Direct PostgreSQL SQL",
        competitor: "Through CMS content types",
      },
      {
        feature: "API",
        kolaybase: "REST (PostgREST-style)",
        competitor: "REST + GraphQL",
      },
      {
        feature: "Authentication",
        kolaybase: "Keycloak realm per project",
        competitor: "Users & permissions plugin",
      },
      {
        feature: "Storage",
        kolaybase: "S3-compatible",
        competitor: "Media library (providers)",
      },
      {
        feature: "Self-hosting",
        kolaybase: "Docker Compose",
        competitor: "Node.js (self-host)",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase a Strapi alternative?",
        answer:
          "If you actually need a database backend rather than a CMS, yes. Strapi excels at content modeling and editorial workflows; Kolaybase gives you PostgreSQL with direct SQL, auth, and a REST API.",
      },
      {
        question: "When is Strapi the better choice?",
        answer:
          "When your core need is content management — editors, drafts, and a media library — Strapi is purpose-built for that. For an application database with SQL and row-level security, choose Kolaybase.",
      },
    ],
  },
  {
    slug: "kolaybase-vs-xata",
    competitor: "Xata",
    title: "Kolaybase vs. Xata: Full Backend or Serverless Postgres Data Platform?",
    description:
      "Compare Kolaybase and Xata: Xata is a serverless data platform on PostgreSQL with branching and search; Kolaybase is a full backend with auth, storage, and a REST API.",
    intro:
      "Xata is a serverless data platform built on PostgreSQL, known for developer-friendly tooling, branching, and built-in search. Kolaybase is a complete backend on PostgreSQL that adds authentication, storage, and a REST API around the database.",
    positioning:
      "Xata is a strong choice if you want a serverless Postgres data layer with branching and search to plug into your own app code. Kolaybase is for teams who want the backend itself — auth, storage, and an API included — and the option to self-host the whole stack.",
    rows: [
      {
        feature: "What it is",
        kolaybase: "Full backend (DB + auth + storage + API)",
        competitor: "Serverless Postgres data platform",
      },
      {
        feature: "Built-in auth",
        kolaybase: "Yes (Keycloak realm)",
        competitor: "Not a core focus",
      },
      {
        feature: "Built-in storage",
        kolaybase: "Yes (S3-compatible)",
        competitor: "Not a core focus",
      },
      {
        feature: "Search",
        kolaybase: "PostgreSQL full-text",
        competitor: "Built-in search engine",
      },
      {
        feature: "Branching",
        kolaybase: "Not built in",
        competitor: "Yes",
      },
      {
        feature: "Self-hosting",
        kolaybase: "Docker Compose",
        competitor: "Managed cloud service",
      },
    ],
    faqs: [
      {
        question: "Is Kolaybase a Xata alternative?",
        answer:
          "They overlap on PostgreSQL but differ in scope. Xata is a serverless data platform with search and branching; Kolaybase is a full backend with auth, storage, and a REST API you can self-host.",
      },
      {
        question: "Does Kolaybase offer search like Xata?",
        answer:
          "Kolaybase uses PostgreSQL's built-in full-text search. Xata ships a dedicated search engine as a core feature, which may suit search-heavy products better.",
      },
    ],
  },
];

export function getComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

export function getComparisonSlugs(): string[] {
  return COMPARISONS.map((c) => c.slug);
}
