import type { FaqItem } from "@/lib/seo/json-ld";

/**
 * Data registry powering the programmatic `/use-cases/[slug]` pages. Each entry
 * targets a search intent ("backend for a SaaS app", "backend for a mobile
 * app") and renders a full landing page with benefits, a sample schema, and FAQ.
 */
export type UseCaseBenefit = { title: string; body: string };

export type UseCase = {
  slug: string;
  /** Short label for cards/nav, e.g. "SaaS apps". */
  label: string;
  title: string;
  description: string;
  intro: string;
  benefits: UseCaseBenefit[];
  /** Illustrative SQL/code snippet for this use case. */
  codeTitle: string;
  code: string;
  faqs: FaqItem[];
};

export const USE_CASES: UseCase[] = [
  {
    slug: "saas-applications",
    label: "SaaS apps",
    title: "The Backend for SaaS Applications — PostgreSQL, Auth & REST API",
    description:
      "Build multi-tenant SaaS faster with basefyio: per-project PostgreSQL, row-level security, authentication, and an auto-generated REST API. Ship features, not plumbing.",
    intro:
      "SaaS products live and die by their data model and access control. basefyio gives you a real PostgreSQL database with row-level security and auth built in, so multi-tenant isolation is enforced at the database — not bolted on in application code.",
    benefits: [
      {
        title: "Tenant isolation with RLS",
        body: "Use PostgreSQL row-level security to guarantee each tenant only ever reads its own rows, enforced by the database on every query.",
      },
      {
        title: "Auth that's ready on day one",
        body: "Email and OAuth sign-in via a dedicated auth realm — no need to build sessions, password resets, or token rotation yourself.",
      },
      {
        title: "An API that tracks your schema",
        body: "Add a table and it's instantly available over a filtered, paginated REST API. No CRUD controllers to write or keep in sync.",
      },
      {
        title: "Predictable, self-hostable",
        body: "Run it on your own infrastructure with Docker Compose for compliance, data residency, or cost control.",
      },
    ],
    codeTitle: "Multi-tenant row-level security",
    code: `alter table projects enable row level security;

create policy "members read their org's projects"
  on projects for select
  using (org_id = auth.org_id());`,
    faqs: [
      {
        question: "How does basefyio handle multi-tenancy?",
        answer:
          "You model tenants in your schema (e.g. an org_id column) and enforce isolation with PostgreSQL row-level security policies. The REST API and SDK respect these policies automatically.",
      },
      {
        question: "Can I bring my own auth provider?",
        answer:
          "basefyio auth is built on Keycloak, which supports email, OAuth, and standard identity providers. Each project gets its own realm.",
      },
    ],
  },
  {
    slug: "mobile-apps",
    label: "Mobile apps",
    title: "A Backend for Mobile Apps — Instant REST API, Auth & Storage",
    description:
      "Power your iOS, Android, or React Native app with basefyio: hosted PostgreSQL, authentication, file storage, and a REST API the SDK talks to directly. No server code to maintain.",
    intro:
      "Mobile apps need a backend, but you don't want to run servers for every endpoint. basefyio exposes your PostgreSQL data over a secure REST API your app calls directly, with auth and file storage included.",
    benefits: [
      {
        title: "Talk to your data directly",
        body: "The SDK queries your database over REST with filtering, ordering, and related-table embedding — no custom endpoints to deploy per screen.",
      },
      {
        title: "Built-in authentication",
        body: "Sign users in with email or OAuth and scope their data with row-level security, so the client only ever sees what it should.",
      },
      {
        title: "File storage with signed URLs",
        body: "Upload avatars and media to S3-compatible storage and serve them with access-controlled URLs.",
      },
      {
        title: "Offline-friendly REST",
        body: "Standard HTTP and JSON make it easy to cache, retry, and sync from any mobile framework.",
      },
    ],
    codeTitle: "Fetch a user's data from the app",
    code: `const { data } = await bf
  .from("messages")
  .select("id, body, sent_at")
  .eq("conversation_id", conversationId)
  .order("sent_at", { ascending: true });`,
    faqs: [
      {
        question: "Does basefyio work with React Native and Flutter?",
        answer:
          "Yes. The REST API is plain HTTP/JSON, so any mobile framework can call it. The basefyio-js SDK works in JavaScript and TypeScript environments including React Native.",
      },
      {
        question: "How do I secure data accessed from a mobile client?",
        answer:
          "Use authentication plus PostgreSQL row-level security. Policies run in the database, so even direct API calls only return rows the signed-in user is allowed to see.",
      },
    ],
  },
  {
    slug: "ecommerce",
    label: "E-commerce",
    title: "A Backend for E-commerce — Products, Orders, and Auth on PostgreSQL",
    description:
      "Build an online store backend with basefyio: relational products and orders in PostgreSQL, transactional integrity, customer auth, and a REST API for your storefront.",
    intro:
      "E-commerce is relational by nature — products, variants, carts, orders, and customers all reference each other. basefyio gives you PostgreSQL with transactions and constraints, so your catalog and checkout stay consistent, plus auth and an API for the storefront.",
    benefits: [
      {
        title: "Transactional checkout",
        body: "Use PostgreSQL transactions so an order and its line items either all commit or all roll back — no half-written carts.",
      },
      {
        title: "Relational catalog",
        body: "Model products, variants, categories, and inventory with real foreign keys and constraints instead of fragile denormalized documents.",
      },
      {
        title: "Customer accounts built in",
        body: "Email and OAuth sign-in for shoppers, with row-level security so customers only see their own orders.",
      },
      {
        title: "Fast storefront queries",
        body: "Filter, sort, and paginate the catalog over the REST API, and embed related data like variants in a single request.",
      },
    ],
    codeTitle: "Place an order atomically",
    code: `begin;
insert into orders (customer_id, total)
  values (auth.uid(), 49.90) returning id;
insert into order_items (order_id, product_id, qty)
  values (currval('orders_id_seq'), 'sku_123', 2);
commit;`,
    faqs: [
      {
        question: "Can basefyio handle inventory and orders consistently?",
        answer:
          "Yes. PostgreSQL transactions and constraints keep orders, line items, and inventory consistent, which is hard to guarantee on a document database.",
      },
      {
        question: "How do customers only see their own orders?",
        answer:
          "Enable row-level security and write a policy keyed on the authenticated customer, so the REST API only ever returns that customer's orders.",
      },
    ],
  },
  {
    slug: "internal-tools",
    label: "Internal tools",
    title: "A Backend for Internal Tools — Instant API Over Your Data",
    description:
      "Power dashboards, admin panels, and internal tools with basefyio: a real PostgreSQL database, an instant REST API, auth, and role-based access without building a backend.",
    intro:
      "Internal tools usually need the same thing: a database, an API over it, and access control — fast. basefyio turns a PostgreSQL schema into a secured REST API instantly, so you can focus on the tool's UI instead of plumbing.",
    benefits: [
      {
        title: "Instant CRUD API",
        body: "Define tables and get filtered, paginated endpoints immediately — perfect for admin panels and dashboards.",
      },
      {
        title: "Role-based access",
        body: "Use PostgreSQL roles and row-level security to give teams the right level of access to internal data.",
      },
      {
        title: "Real SQL for reporting",
        body: "Run ad-hoc queries, views, and aggregates directly in PostgreSQL for the metrics your team needs.",
      },
      {
        title: "Self-host for compliance",
        body: "Keep internal data on your own infrastructure with a Docker Compose deployment.",
      },
    ],
    codeTitle: "Query data for an admin dashboard",
    code: `const { data } = await bf
  .from("signups")
  .select("plan, count:id.count()")
  .gte("created_at", "2026-01-01")
  .group("plan");`,
    faqs: [
      {
        question: "Is basefyio good for admin panels and dashboards?",
        answer:
          "Yes. The instant REST API over PostgreSQL is ideal for internal CRUD tools, and full SQL access makes reporting and aggregation straightforward.",
      },
      {
        question: "Can I restrict which team members see which data?",
        answer:
          "Yes. Combine authentication with PostgreSQL roles and row-level security to control access per team, per row.",
      },
    ],
  },
  {
    slug: "ai-applications",
    label: "AI apps",
    title: "A Backend for AI Applications — Postgres, Auth, and Storage for LLM Apps",
    description:
      "Build AI and LLM applications on basefyio: store users, conversations, and documents in PostgreSQL, manage auth and file uploads, and serve it all through a REST API.",
    intro:
      "AI apps still need a normal backend: user accounts, conversation history, uploaded documents, and usage tracking. basefyio handles that foundation — PostgreSQL, auth, storage, and a REST API — so you can focus on the model and the product.",
    benefits: [
      {
        title: "Store chats and history",
        body: "Keep conversations, messages, and prompts in PostgreSQL with relational structure and fast queries.",
      },
      {
        title: "Document storage for RAG",
        body: "Upload source files to S3-compatible storage and track their metadata in the database for retrieval pipelines.",
      },
      {
        title: "User auth and quotas",
        body: "Authenticate users and model usage limits in your schema, enforced with row-level security.",
      },
      {
        title: "Standard SQL, pgvector-ready",
        body: "Because it's real PostgreSQL, you can adopt extensions and patterns the ecosystem already supports.",
      },
    ],
    codeTitle: "Save a conversation turn",
    code: `await bf.from("messages").insert({
  conversation_id: conversationId,
  role: "user",
  content: prompt,
});`,
    faqs: [
      {
        question: "Can I build a chatbot or LLM app backend on basefyio?",
        answer:
          "Yes. Store users, conversations, messages, and documents in PostgreSQL, handle auth and file uploads, and serve everything through the REST API while your app calls the model.",
      },
      {
        question: "Does basefyio work for retrieval-augmented generation (RAG)?",
        answer:
          "You can store documents in object storage and their metadata in PostgreSQL. Since it's standard Postgres, you can use the broader ecosystem of extensions and tooling around it.",
      },
    ],
  },
  {
    slug: "realtime-chat",
    label: "Chat & messaging",
    title: "A Backend for Chat & Messaging Apps on PostgreSQL",
    description:
      "Build messaging and chat apps with basefyio: store conversations and messages in PostgreSQL, authenticate users, and serve message history through a fast REST API.",
    intro:
      "Messaging apps need durable, queryable history and solid access control. basefyio stores conversations and messages in PostgreSQL, authenticates users, and exposes message history over a REST API your client reads directly.",
    benefits: [
      {
        title: "Durable message history",
        body: "Persist every message in PostgreSQL with indexes for fast retrieval and pagination.",
      },
      {
        title: "Per-conversation access",
        body: "Row-level security ensures users only read conversations they're a participant in.",
      },
      {
        title: "Simple REST integration",
        body: "Load and send messages with plain HTTP from web or mobile, with filtering and ordering built in.",
      },
      {
        title: "Scales with PostgreSQL",
        body: "Handle growing message volume with Postgres indexing, partitioning, and concurrency.",
      },
    ],
    codeTitle: "Load a conversation's messages",
    code: `const { data } = await bf
  .from("messages")
  .select("id, sender_id, body, sent_at")
  .eq("conversation_id", conversationId)
  .order("sent_at", { ascending: true });`,
    faqs: [
      {
        question: "Can basefyio power a chat app?",
        answer:
          "Yes for storage, auth, and history over REST. Live push (realtime subscriptions) is on the roadmap; today many apps poll or pair basefyio with a realtime transport for delivery.",
      },
      {
        question: "How do I keep conversations private?",
        answer:
          "Use row-level security policies tied to conversation membership so the API only returns messages a user is allowed to see.",
      },
    ],
  },
  {
    slug: "analytics-dashboards",
    label: "Analytics dashboards",
    title: "A Backend for Analytics Dashboards — SQL Power on PostgreSQL",
    description:
      "Build analytics dashboards on basefyio: aggregate data with full PostgreSQL SQL, expose metrics through a REST API, and control access with roles and row-level security.",
    intro:
      "Dashboards live on aggregation — sums, group-bys, time buckets, and joins. basefyio gives you full PostgreSQL for those queries plus a REST API and access control, so you can ship metrics without standing up a separate analytics backend.",
    benefits: [
      {
        title: "Real SQL aggregation",
        body: "Use group-by, window functions, and date bucketing in PostgreSQL to compute the metrics your dashboard needs.",
      },
      {
        title: "Views as endpoints",
        body: "Define SQL views for complex metrics and read them through the REST API like any table.",
      },
      {
        title: "Scoped access",
        body: "Row-level security and roles ensure each user or tenant only sees their own analytics.",
      },
      {
        title: "Own your data",
        body: "Self-host on your infrastructure and keep analytics data under your control.",
      },
    ],
    codeTitle: "Daily active users via a view",
    code: `create view daily_active as
select date_trunc('day', seen_at) as day,
       count(distinct user_id) as dau
from events
group by 1;`,
    faqs: [
      {
        question: "Can I build dashboards on basefyio?",
        answer:
          "Yes. Full PostgreSQL means you can write aggregation queries and views, then read them through the REST API to power charts and metrics.",
      },
      {
        question: "How do I expose a complex metric to the frontend?",
        answer:
          "Create a SQL view encapsulating the query, and it becomes available through the REST API just like a table, with access controlled by row-level security.",
      },
    ],
  },
];

export function getUseCase(slug: string): UseCase | undefined {
  return USE_CASES.find((u) => u.slug === slug);
}

export function getUseCaseSlugs(): string[] {
  return USE_CASES.map((u) => u.slug);
}
