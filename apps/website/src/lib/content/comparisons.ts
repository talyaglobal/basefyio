import type { FaqItem } from "@/lib/seo/json-ld";

/**
 * Data registry powering the programmatic `/compare/[slug]` pages. Add an entry
 * here and the comparison page, index card, sitemap, and JSON-LD all update
 * automatically — no per-page React required.
 */
export type ComparisonRow = {
  feature: string;
  basefyio: string;
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
  /** Honest, specific positioning — what basefyio does differently. */
  positioning: string;
  rows: ComparisonRow[];
  faqs: FaqItem[];
};

export const COMPARISONS: Comparison[] = [
  {
    slug: "basefyio-vs-supabase",
    competitor: "Supabase",
    title: "basefyio vs. Supabase: Which PostgreSQL Backend Should You Use?",
    description:
      "A detailed, honest comparison of basefyio and Supabase: hosting model, database isolation, REST API, auth, pricing, and lock-in. Find the right PostgreSQL backend for your stack.",
    intro:
      "Both basefyio and Supabase give you a PostgreSQL database with an auto-generated REST API, authentication, and storage. The differences come down to isolation, self-hosting, and how the platform is operated.",
    positioning:
      "basefyio provisions a dedicated PostgreSQL database and an isolated auth realm per project, and is built to be self-hosted with Docker Compose from day one. If you want true single-tenant isolation and full control of where your data runs, that's the core distinction.",
    rows: [
      {
        feature: "Database model",
        basefyio: "Dedicated PostgreSQL database per project",
        competitor: "PostgreSQL project (schema-based isolation)",
      },
      {
        feature: "Self-hosting",
        basefyio: "First-class, Docker Compose included",
        competitor: "Supported, more involved setup",
      },
      {
        feature: "Auto REST API",
        basefyio: "Yes, PostgREST-style",
        competitor: "Yes, PostgREST",
      },
      {
        feature: "Authentication",
        basefyio: "Keycloak realm per project (OAuth + email)",
        competitor: "GoTrue (email, OAuth, magic links)",
      },
      {
        feature: "Storage",
        basefyio: "S3-compatible (MinIO)",
        competitor: "S3-compatible",
      },
      {
        feature: "Query language",
        basefyio: "Standard SQL, no lock-in",
        competitor: "Standard SQL, no lock-in",
      },
      {
        feature: "Realtime",
        basefyio: "Roadmap",
        competitor: "Built-in",
      },
    ],
    faqs: [
      {
        question: "Is basefyio a Supabase alternative?",
        answer:
          "Yes. basefyio offers the same core building blocks — hosted PostgreSQL, an auto-generated REST API, authentication, and object storage — with a per-project dedicated database and a self-hosting-first design.",
      },
      {
        question: "Can I migrate from Supabase to basefyio?",
        answer:
          "Because both are standard PostgreSQL, you can export your schema and data with pg_dump and import it into a basefyio project. There is no proprietary query language to rewrite.",
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
      "Firebase is a NoSQL document platform; basefyio is built on relational PostgreSQL. The choice shapes how you model data, query it, and avoid lock-in.",
    positioning:
      "If your data is relational — users, orders, posts with relationships — basefyio's SQL foundation lets you express joins, constraints, and transactions natively. Firebase shines for simple document/realtime workloads but makes complex queries and migrations harder, and its data model is proprietary.",
    rows: [
      {
        feature: "Data model",
        basefyio: "Relational (PostgreSQL)",
        competitor: "NoSQL document store",
      },
      {
        feature: "Queries",
        basefyio: "Full SQL: joins, aggregates, transactions",
        competitor: "Limited; no server-side joins",
      },
      {
        feature: "Schema & constraints",
        basefyio: "Enforced by PostgreSQL",
        competitor: "Schemaless; enforced in app/rules",
      },
      {
        feature: "REST API",
        basefyio: "Auto-generated, PostgREST-style",
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
        basefyio: "Roadmap",
        competitor: "Core strength",
      },
    ],
    faqs: [
      {
        question: "Is basefyio a good Firebase alternative?",
        answer:
          "For relational data and apps that benefit from SQL, yes. basefyio gives you PostgreSQL with auth, storage, and a REST API. If you need NoSQL documents and best-in-class realtime above all, Firebase may fit better.",
      },
      {
        question: "Can I do complex queries in basefyio that I can't in Firebase?",
        answer:
          "Yes. PostgreSQL supports joins, aggregations, window functions, and transactions on the server, which document databases like Firestore handle awkwardly or not at all.",
      },
      {
        question: "Will I get locked in with basefyio?",
        answer:
          "No. basefyio uses standard PostgreSQL, so your schema and data are fully portable with pg_dump. You can self-host or move providers at any time.",
      },
    ],
  },
  {
    slug: "basefyio-vs-neon",
    competitor: "Neon",
    title: "basefyio vs. Neon: Full Backend or Serverless Postgres?",
    description:
      "Compare basefyio and Neon: Neon is serverless PostgreSQL with branching; basefyio is a full backend with auth, storage, and an auto REST API on top of Postgres.",
    intro:
      "Both are built on PostgreSQL, but they solve different layers. Neon is a serverless Postgres database with branching and scale-to-zero. basefyio is a complete backend — database plus authentication, storage, and an auto-generated REST API.",
    positioning:
      "If you only need a managed, serverless Postgres to plug into your own backend, Neon is excellent. If you want the database and the backend around it — auth, storage, and an instant API — without wiring those yourself, that's what basefyio provides. They can even be complementary: Neon for the DB, your own services on top, vs. basefyio giving you the whole stack.",
    rows: [
      {
        feature: "What it is",
        basefyio: "Full backend (DB + auth + storage + API)",
        competitor: "Serverless PostgreSQL database",
      },
      {
        feature: "Auto REST API",
        basefyio: "Yes, PostgREST-style",
        competitor: "No — bring your own API layer",
      },
      {
        feature: "Authentication",
        basefyio: "Built in (Keycloak realm per project)",
        competitor: "Not included",
      },
      {
        feature: "Storage",
        basefyio: "Built in (S3-compatible)",
        competitor: "Not included",
      },
      {
        feature: "Database branching",
        basefyio: "Not built in",
        competitor: "Yes, a core strength",
      },
      {
        feature: "Self-hosting",
        basefyio: "First-class (Docker Compose)",
        competitor: "Managed cloud service",
      },
    ],
    faqs: [
      {
        question: "Is basefyio a Neon alternative?",
        answer:
          "They overlap on PostgreSQL but differ in scope. Neon is a serverless database; basefyio is a full backend. Choose basefyio if you want auth, storage, and an API included; choose Neon if you only need the database and branching.",
      },
      {
        question: "Does basefyio support database branching like Neon?",
        answer:
          "Branching is a Neon specialty and not a built-in basefyio feature today. basefyio focuses on giving you a complete, self-hostable backend around standard PostgreSQL.",
      },
    ],
  },
  {
    slug: "basefyio-vs-appwrite",
    competitor: "Appwrite",
    title: "basefyio vs. Appwrite: PostgreSQL-Native or Abstracted Backend?",
    description:
      "Compare basefyio and Appwrite: both are open, self-hostable backends with auth, storage, and databases. basefyio is PostgreSQL-native with direct SQL; Appwrite abstracts the database.",
    intro:
      "basefyio and Appwrite are both self-hostable backend platforms offering authentication, storage, and a database. The biggest difference is the database layer: basefyio gives you standard PostgreSQL with full SQL access, while Appwrite provides its own database abstraction.",
    positioning:
      "basefyio is PostgreSQL-native: you write real SQL, use row-level security, and keep full portability via pg_dump. Appwrite offers a polished cross-platform SDK suite and its own collections model. If direct SQL, relational power, and Postgres portability matter most, basefyio fits; if you want Appwrite's broad SDK ecosystem and document-style collections, that's its strength.",
    rows: [
      {
        feature: "Database",
        basefyio: "Standard PostgreSQL, full SQL",
        competitor: "Abstracted collections (over MariaDB)",
      },
      {
        feature: "Direct SQL access",
        basefyio: "Yes",
        competitor: "Limited; via the collections API",
      },
      {
        feature: "Auto REST API",
        basefyio: "PostgREST-style from your schema",
        competitor: "REST/GraphQL via SDK",
      },
      {
        feature: "Authentication",
        basefyio: "Keycloak realm per project",
        competitor: "Built-in auth + OAuth providers",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Docker (open source)",
      },
      {
        feature: "Portability",
        basefyio: "Standard SQL, pg_dump",
        competitor: "Appwrite-specific data model",
      },
    ],
    faqs: [
      {
        question: "Is basefyio an Appwrite alternative?",
        answer:
          "Yes. Both are open, self-hostable backends with auth, storage, and databases. The deciding factor is usually whether you want PostgreSQL-native SQL (basefyio) or Appwrite's collections model and SDK ecosystem.",
      },
      {
        question: "Can I use raw SQL with basefyio but not Appwrite?",
        answer:
          "basefyio exposes standard PostgreSQL, so you write SQL directly and use features like joins, transactions, and row-level security. Appwrite works through its own database API rather than raw SQL.",
      },
    ],
  },
  {
    slug: "basefyio-vs-pocketbase",
    competitor: "PocketBase",
    title: "basefyio vs. PocketBase: PostgreSQL Platform or Single-File SQLite?",
    description:
      "Compare basefyio and PocketBase: PocketBase is a single Go binary on SQLite; basefyio is a PostgreSQL backend with a dedicated database per project. Pick the right scale.",
    intro:
      "PocketBase is a delightfully simple single-file backend on SQLite — auth, realtime, file storage, and an admin UI in one Go binary. basefyio is a PostgreSQL-based platform with a dedicated database per project, aimed at multi-tenant, production-scale workloads.",
    positioning:
      "PocketBase is hard to beat for a quick prototype or a small app you want to run from one binary. basefyio trades that single-file simplicity for PostgreSQL's scale and concurrency, per-project database isolation, and Keycloak-grade auth — better suited as apps and teams grow.",
    rows: [
      {
        feature: "Database",
        basefyio: "PostgreSQL (per-project DB)",
        competitor: "SQLite (single file)",
      },
      {
        feature: "Deployment",
        basefyio: "Docker Compose stack",
        competitor: "Single Go binary",
      },
      {
        feature: "Concurrency / scale",
        basefyio: "High (PostgreSQL)",
        competitor: "Best for smaller workloads",
      },
      {
        feature: "Auth",
        basefyio: "Keycloak realm per project",
        competitor: "Built-in auth",
      },
      {
        feature: "Realtime",
        basefyio: "Roadmap",
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
        question: "Is basefyio a PocketBase alternative?",
        answer:
          "Yes, for teams that outgrow SQLite. PocketBase is ideal for small apps and prototypes in a single binary; basefyio gives you PostgreSQL, per-project isolation, and platform features for production multi-tenant apps.",
      },
      {
        question: "When should I pick PocketBase over basefyio?",
        answer:
          "If you want the absolute simplest deployment (one file), a small dataset, and built-in realtime today, PocketBase is a great fit. Choose basefyio when you need PostgreSQL's scale, concurrency, and database-per-project isolation.",
      },
    ],
  },
  {
    slug: "basefyio-vs-nhost",
    competitor: "Nhost",
    title: "basefyio vs. Nhost: REST or GraphQL on PostgreSQL?",
    description:
      "Compare basefyio and Nhost: both are open backends on PostgreSQL with auth and storage. Nhost is GraphQL-first via Hasura; basefyio offers a PostgREST-style REST API.",
    intro:
      "basefyio and Nhost are both PostgreSQL-based, open backends with authentication and storage. The headline difference is the API style: Nhost is GraphQL-first (powered by Hasura), while basefyio exposes a PostgREST-style REST API.",
    positioning:
      "If your team prefers GraphQL and Hasura's permission model, Nhost is a strong choice. If you prefer REST — simple HTTP, easy caching, no GraphQL client required — basefyio's auto-generated REST API maps cleanly onto your schema and row-level security.",
    rows: [
      {
        feature: "API style",
        basefyio: "REST (PostgREST-style)",
        competitor: "GraphQL (Hasura)",
      },
      {
        feature: "Database",
        basefyio: "PostgreSQL, per-project DB",
        competitor: "PostgreSQL",
      },
      {
        feature: "Authentication",
        basefyio: "Keycloak realm per project",
        competitor: "Built-in auth",
      },
      {
        feature: "Storage",
        basefyio: "S3-compatible",
        competitor: "S3-compatible",
      },
      {
        feature: "Permissions",
        basefyio: "PostgreSQL row-level security",
        competitor: "Hasura permission rules",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Open source / cloud",
      },
    ],
    faqs: [
      {
        question: "Is basefyio an Nhost alternative?",
        answer:
          "Yes. Both are open, PostgreSQL-based backends with auth and storage. The main choice is REST (basefyio) versus GraphQL via Hasura (Nhost).",
      },
      {
        question: "Does basefyio support GraphQL?",
        answer:
          "basefyio focuses on a REST API today. If GraphQL is a hard requirement, Nhost's Hasura-based approach may suit you better; if you prefer REST, basefyio is a natural fit.",
      },
    ],
  },
  {
    slug: "basefyio-vs-render",
    competitor: "Render",
    title: "basefyio vs. Render: Backend Platform or App Hosting?",
    description:
      "Compare basefyio and Render: Render hosts apps and managed Postgres; basefyio gives you a ready backend — auth, storage, and an auto REST API — without writing the server.",
    intro:
      "Render is a cloud platform for deploying web services, workers, and managed PostgreSQL. basefyio is a backend itself: it provides the database plus auth, storage, and an auto-generated REST API, so you don't write that server code at all.",
    positioning:
      "With Render you deploy and operate your own backend code next to a managed database. With basefyio the backend already exists — define a table and it's instantly an API with auth and storage. Use Render when you need to run custom services; use basefyio when you want the backend handed to you.",
    rows: [
      {
        feature: "What it is",
        basefyio: "Backend-as-a-service",
        competitor: "App hosting + managed Postgres",
      },
      {
        feature: "Auto REST API",
        basefyio: "Yes, from your schema",
        competitor: "No — you build the API",
      },
      {
        feature: "Authentication",
        basefyio: "Built in",
        competitor: "You implement it",
      },
      {
        feature: "Storage",
        basefyio: "Built in (S3-compatible)",
        competitor: "Disks / external object storage",
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
        question: "Is basefyio an alternative to Render?",
        answer:
          "They sit at different layers. Render hosts the code you write; basefyio is the backend so you write less of it. Many teams could run custom workers on a platform like Render and use basefyio for the data/auth/storage backend.",
      },
      {
        question: "Can I still run custom backend logic with basefyio?",
        answer:
          "Yes. basefyio handles the database, auth, storage, and REST API; you can run any custom services you need alongside it and call the basefyio API from them.",
      },
    ],
  },
  {
    slug: "basefyio-vs-aws-amplify",
    competitor: "AWS Amplify",
    title: "basefyio vs. AWS Amplify: Standard PostgreSQL or the AWS Stack?",
    description:
      "Compare basefyio and AWS Amplify: Amplify ties your backend to AWS services like Cognito and DynamoDB; basefyio is standard PostgreSQL, self-hostable, with no vendor lock-in.",
    intro:
      "AWS Amplify bundles AWS building blocks — Cognito for auth, AppSync/DynamoDB or relational data, S3 for storage — behind a unified developer experience. basefyio delivers similar capabilities on standard PostgreSQL, self-hostable, without committing to one cloud.",
    positioning:
      "If you're all-in on AWS, Amplify's integration is convenient. If you want to avoid lock-in — standard PostgreSQL you can pg_dump and move, the option to self-host, and no proprietary services to learn — basefyio is the portable alternative.",
    rows: [
      {
        feature: "Database",
        basefyio: "Standard PostgreSQL",
        competitor: "DynamoDB or Aurora/RDS",
      },
      {
        feature: "Authentication",
        basefyio: "Keycloak realm per project",
        competitor: "Amazon Cognito",
      },
      {
        feature: "API",
        basefyio: "Auto REST (PostgREST-style)",
        competitor: "AppSync (GraphQL) / REST",
      },
      {
        feature: "Storage",
        basefyio: "S3-compatible (MinIO)",
        competitor: "Amazon S3",
      },
      {
        feature: "Lock-in",
        basefyio: "Portable, no cloud lock-in",
        competitor: "Tied to AWS services",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose, any host",
        competitor: "AWS only",
      },
    ],
    faqs: [
      {
        question: "Is basefyio an AWS Amplify alternative?",
        answer:
          "Yes, especially if you want to avoid AWS lock-in. basefyio offers auth, storage, and an API on standard PostgreSQL that you can run anywhere, while Amplify is built around AWS-specific services.",
      },
      {
        question: "Can I move off basefyio more easily than off Amplify?",
        answer:
          "Because basefyio uses standard PostgreSQL, you can export everything with pg_dump and run it elsewhere. Amplify's reliance on services like Cognito and DynamoDB makes migration more involved.",
      },
    ],
  },
  {
    slug: "basefyio-vs-convex",
    competitor: "Convex",
    title: "basefyio vs. Convex: Standard PostgreSQL or a Reactive TS Backend?",
    description:
      "Compare basefyio and Convex: Convex is a reactive, TypeScript-first backend with its own database; basefyio is standard PostgreSQL with a REST API, auth, and storage.",
    intro:
      "Convex is a reactive backend where you write TypeScript functions against its own database and get realtime updates for free. basefyio is built on standard PostgreSQL with an auto-generated REST API, authentication, and storage.",
    positioning:
      "Convex is compelling if you want a tightly integrated, realtime, TypeScript-native model and are comfortable with its proprietary database. basefyio is for teams who want standard SQL, portability via pg_dump, and the option to self-host — with REST rather than a function-based model.",
    rows: [
      {
        feature: "Database",
        basefyio: "Standard PostgreSQL",
        competitor: "Proprietary reactive database",
      },
      {
        feature: "Programming model",
        basefyio: "SQL + REST API",
        competitor: "TypeScript functions",
      },
      {
        feature: "Realtime",
        basefyio: "Roadmap",
        competitor: "Built-in, reactive by default",
      },
      {
        feature: "Authentication",
        basefyio: "Keycloak realm per project",
        competitor: "Via integrations",
      },
      {
        feature: "Portability",
        basefyio: "Standard SQL, pg_dump",
        competitor: "Convex-specific data model",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Primarily managed",
      },
    ],
    faqs: [
      {
        question: "Is basefyio a Convex alternative?",
        answer:
          "Yes, for teams that prefer standard PostgreSQL and REST over a proprietary reactive database and a TypeScript-function model. Convex's strength is built-in realtime; basefyio's is SQL, portability, and self-hosting.",
      },
      {
        question: "Does basefyio have realtime like Convex?",
        answer:
          "Realtime reactivity is a core Convex feature. basefyio focuses today on database, REST API, auth, and storage, with realtime on the roadmap.",
      },
    ],
  },
  {
    slug: "basefyio-vs-hasura",
    competitor: "Hasura",
    title: "basefyio vs. Hasura: REST Backend or GraphQL Engine?",
    description:
      "Compare basefyio and Hasura: Hasura generates a GraphQL API over your PostgreSQL; basefyio is a full backend with a REST API plus built-in auth and storage.",
    intro:
      "Hasura is a GraphQL engine that instantly exposes your PostgreSQL (and other databases) as a GraphQL API with a powerful permission system. basefyio is a complete backend with a REST API plus built-in authentication and storage.",
    positioning:
      "If you want GraphQL and a rich permissions layer over an existing database, Hasura is purpose-built for that. If you prefer REST and want auth and storage included as part of one backend — not assembled separately — basefyio fits better.",
    rows: [
      {
        feature: "API style",
        basefyio: "REST (PostgREST-style)",
        competitor: "GraphQL",
      },
      {
        feature: "Scope",
        basefyio: "Full backend (DB + auth + storage + API)",
        competitor: "API layer over your database",
      },
      {
        feature: "Authentication",
        basefyio: "Built in (Keycloak realm)",
        competitor: "Via external auth + JWT",
      },
      {
        feature: "Storage",
        basefyio: "Built in (S3-compatible)",
        competitor: "Not included",
      },
      {
        feature: "Permissions",
        basefyio: "PostgreSQL row-level security",
        competitor: "Hasura permission rules",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Open source / cloud",
      },
    ],
    faqs: [
      {
        question: "Is basefyio a Hasura alternative?",
        answer:
          "They overlap on exposing PostgreSQL as an API but differ in style and scope. Hasura is GraphQL-focused and pairs with external auth; basefyio offers REST with auth and storage built in.",
      },
      {
        question: "Should I pick Hasura or basefyio?",
        answer:
          "Choose Hasura if GraphQL and its permission model are central to your stack. Choose basefyio if you want a REST API and a backend that already includes authentication and storage.",
      },
    ],
  },
  {
    slug: "basefyio-vs-directus",
    competitor: "Directus",
    title: "basefyio vs. Directus: App Backend or Headless Data Platform?",
    description:
      "Compare basefyio and Directus: Directus wraps a SQL database with an admin app and APIs as a headless CMS/data platform; basefyio is an app backend with per-project Postgres, auth, and REST.",
    intro:
      "Directus is an open-source data platform and headless CMS that layers an admin app and REST/GraphQL APIs over an existing SQL database. basefyio is an application backend that provisions a dedicated PostgreSQL database per project with authentication and a REST API.",
    positioning:
      "Directus shines when you want a polished admin/content studio over a database, often for content and internal data management. basefyio is aimed at app backends: per-project database isolation, Keycloak-grade auth, and a REST API for your application to build on.",
    rows: [
      {
        feature: "Primary focus",
        basefyio: "Application backend",
        competitor: "Headless CMS / data platform",
      },
      {
        feature: "Database",
        basefyio: "PostgreSQL, per-project DB",
        competitor: "Wraps existing SQL DBs",
      },
      {
        feature: "Admin app",
        basefyio: "Dashboard + SQL editor",
        competitor: "Rich data studio / CMS",
      },
      {
        feature: "API",
        basefyio: "REST (PostgREST-style)",
        competitor: "REST + GraphQL",
      },
      {
        feature: "Authentication",
        basefyio: "Keycloak realm per project",
        competitor: "Built-in users & roles",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Open source (self-host)",
      },
    ],
    faqs: [
      {
        question: "Is basefyio a Directus alternative?",
        answer:
          "They overlap because both put an API over SQL, but their focus differs. Directus is a strong headless CMS / data studio; basefyio is an app backend with per-project Postgres, auth, and REST.",
      },
      {
        question: "Which should I use for a content-heavy admin?",
        answer:
          "Directus's admin/content studio is purpose-built for managing content. For an application backend with isolated databases and built-in auth, basefyio is the better fit.",
      },
    ],
  },
  {
    slug: "basefyio-vs-strapi",
    competitor: "Strapi",
    title: "basefyio vs. Strapi: Database Backend or Headless CMS?",
    description:
      "Compare basefyio and Strapi: Strapi is a Node.js headless CMS for content types and editorial workflows; basefyio is a PostgreSQL backend with direct SQL, auth, and a REST API.",
    intro:
      "Strapi is a popular open-source headless CMS for modeling content types and powering editorial workflows, with REST and GraphQL APIs. basefyio is a database-first backend on PostgreSQL with direct SQL access, authentication, and a REST API.",
    positioning:
      "Strapi is the right tool when content management — editors, drafts, media libraries — is the job. basefyio is the right tool when you want a real PostgreSQL database with SQL, row-level security, and an API for your application, rather than a CMS abstraction.",
    rows: [
      {
        feature: "Primary focus",
        basefyio: "Database/app backend",
        competitor: "Headless CMS",
      },
      {
        feature: "Database access",
        basefyio: "Direct PostgreSQL SQL",
        competitor: "Through CMS content types",
      },
      {
        feature: "API",
        basefyio: "REST (PostgREST-style)",
        competitor: "REST + GraphQL",
      },
      {
        feature: "Authentication",
        basefyio: "Keycloak realm per project",
        competitor: "Users & permissions plugin",
      },
      {
        feature: "Storage",
        basefyio: "S3-compatible",
        competitor: "Media library (providers)",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Node.js (self-host)",
      },
    ],
    faqs: [
      {
        question: "Is basefyio a Strapi alternative?",
        answer:
          "If you actually need a database backend rather than a CMS, yes. Strapi excels at content modeling and editorial workflows; basefyio gives you PostgreSQL with direct SQL, auth, and a REST API.",
      },
      {
        question: "When is Strapi the better choice?",
        answer:
          "When your core need is content management — editors, drafts, and a media library — Strapi is purpose-built for that. For an application database with SQL and row-level security, choose basefyio.",
      },
    ],
  },
  {
    slug: "basefyio-vs-xata",
    competitor: "Xata",
    title: "basefyio vs. Xata: Full Backend or Serverless Postgres Data Platform?",
    description:
      "Compare basefyio and Xata: Xata is a serverless data platform on PostgreSQL with branching and search; basefyio is a full backend with auth, storage, and a REST API.",
    intro:
      "Xata is a serverless data platform built on PostgreSQL, known for developer-friendly tooling, branching, and built-in search. basefyio is a complete backend on PostgreSQL that adds authentication, storage, and a REST API around the database.",
    positioning:
      "Xata is a strong choice if you want a serverless Postgres data layer with branching and search to plug into your own app code. basefyio is for teams who want the backend itself — auth, storage, and an API included — and the option to self-host the whole stack.",
    rows: [
      {
        feature: "What it is",
        basefyio: "Full backend (DB + auth + storage + API)",
        competitor: "Serverless Postgres data platform",
      },
      {
        feature: "Built-in auth",
        basefyio: "Yes (Keycloak realm)",
        competitor: "Not a core focus",
      },
      {
        feature: "Built-in storage",
        basefyio: "Yes (S3-compatible)",
        competitor: "Not a core focus",
      },
      {
        feature: "Search",
        basefyio: "PostgreSQL full-text",
        competitor: "Built-in search engine",
      },
      {
        feature: "Branching",
        basefyio: "Not built in",
        competitor: "Yes",
      },
      {
        feature: "Self-hosting",
        basefyio: "Docker Compose",
        competitor: "Managed cloud service",
      },
    ],
    faqs: [
      {
        question: "Is basefyio a Xata alternative?",
        answer:
          "They overlap on PostgreSQL but differ in scope. Xata is a serverless data platform with search and branching; basefyio is a full backend with auth, storage, and a REST API you can self-host.",
      },
      {
        question: "Does basefyio offer search like Xata?",
        answer:
          "basefyio uses PostgreSQL's built-in full-text search. Xata ships a dedicated search engine as a core feature, which may suit search-heavy products better.",
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
