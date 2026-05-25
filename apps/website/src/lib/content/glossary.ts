/**
 * Data registry powering the programmatic `/learn/[slug]` glossary. Each term is
 * a long-tail SEO landing page: a real definition plus related terms for
 * internal linking. Add an entry and the page, index, sitemap, and JSON-LD all
 * update automatically.
 *
 * Keep definitions accurate and genuinely useful — thin, templated glossary
 * pages get demoted by search engines.
 */
export type GlossaryTerm = {
  slug: string;
  term: string;
  /** Acronym or alternative name, shown as "(also: …)". */
  aka?: string;
  /** One-sentence definition used for meta description and the snippet. */
  definition: string;
  /** Body paragraphs (plain text), rendered as prose. */
  body: string[];
  /** Slugs of related terms for cross-linking. */
  related: string[];
};

export const GLOSSARY: GlossaryTerm[] = [
  {
    slug: "backend-as-a-service",
    term: "Backend-as-a-Service",
    aka: "BaaS",
    definition:
      "A backend-as-a-service (BaaS) is a platform that provides ready-made backend building blocks — database, authentication, storage, and an API — so developers don't have to build and operate them from scratch.",
    body: [
      "A backend-as-a-service removes the undifferentiated work of standing up a backend. Instead of wiring a database, an auth system, file storage, and an API layer yourself, a BaaS exposes them as managed services you configure and call.",
      "Typical BaaS features include a hosted database, user authentication (email and OAuth), object storage for files, and an automatically generated API. Many also offer serverless functions, realtime updates, and an admin dashboard.",
      "BaaS is most valuable when the backend is undifferentiated work — most apps need the same accounts, data, and storage plumbing. Teams building on standard technologies like PostgreSQL also keep portability, avoiding lock-in.",
    ],
    related: ["rest-api", "row-level-security", "object-storage", "multi-tenancy"],
  },
  {
    slug: "rest-api",
    term: "REST API",
    definition:
      "A REST API is a web interface that exposes resources over HTTP using standard methods (GET, POST, PUT, DELETE) and JSON, making data easy to read, cache, and integrate.",
    body: [
      "REST (Representational State Transfer) is an architectural style for APIs. Resources — like users or orders — are addressed by URLs and manipulated with HTTP verbs. Because it's plain HTTP and JSON, every language and tool already understands it.",
      "A key advantage of REST is caching: GET responses cache at the browser, CDN, and proxy layers with no extra work. This makes REST APIs fast and scalable for read-heavy workloads.",
      "Modern REST APIs can be generated directly from a database schema, adding filtering, ordering, pagination, and related-resource embedding without hand-written controllers.",
    ],
    related: ["postgrest", "crud", "api-key", "webhook"],
  },
  {
    slug: "postgrest",
    term: "PostgREST",
    definition:
      "PostgREST is an approach (and tool) that turns a PostgreSQL database directly into a RESTful API, generating endpoints from your schema and enforcing access with database permissions.",
    body: [
      "PostgREST and PostgREST-style APIs expose your PostgreSQL tables and views as REST endpoints automatically. Querying, filtering, ordering, and pagination are driven by the URL, so you don't write CRUD controllers.",
      "Security stays in the database: PostgreSQL roles and row-level security policies determine what each request can read or write, rather than scattering permission checks across application code.",
      "This pattern dramatically reduces backend boilerplate while keeping standard SQL as the single source of truth for both data and access control.",
    ],
    related: ["rest-api", "row-level-security", "database-schema", "crud"],
  },
  {
    slug: "row-level-security",
    term: "Row-Level Security",
    aka: "RLS",
    definition:
      "Row-level security (RLS) is a PostgreSQL feature that restricts which rows a user can read or modify using policies enforced by the database on every query.",
    body: [
      "With RLS, you attach policies to a table. Each policy is a SQL expression that decides which rows are visible or writable for the current user. Once enabled, PostgreSQL applies it automatically to every query.",
      "RLS is the foundation of secure multi-tenancy and per-user access. A single policy keyed on a tenant or owner column guarantees isolation no matter which client — API, SQL console, or background job — runs the query.",
      "Because the rule lives in the database, you define access control once instead of re-checking it in every endpoint, eliminating a whole class of data-leak bugs.",
    ],
    related: ["multi-tenancy", "postgrest", "acid-transactions", "database-schema"],
  },
  {
    slug: "object-storage",
    term: "Object Storage",
    definition:
      "Object storage is a system for storing files (images, documents, backups) as objects with metadata, typically accessed over an S3-compatible API and served via signed URLs.",
    body: [
      "Unlike a traditional file system, object storage manages data as discrete objects in a flat namespace, each with a unique key and metadata. It scales to huge numbers of files and is the standard way apps store user uploads and media.",
      "The S3 API has become the de facto interface, and S3-compatible servers like MinIO let you run object storage on your own infrastructure with the same client libraries.",
      "Access is usually controlled with signed URLs — time-limited links that grant temporary access to a private object without exposing credentials.",
    ],
    related: ["backend-as-a-service", "api-key", "webhook"],
  },
  {
    slug: "multi-tenancy",
    term: "Multi-Tenancy",
    definition:
      "Multi-tenancy is an architecture where a single application serves multiple isolated customers (tenants), keeping each tenant's data separate and secure.",
    body: [
      "Multi-tenant SaaS must guarantee that one customer can never see another's data. The main patterns are a shared schema with row-level security, a schema per tenant, and a database per tenant — trading operational simplicity for stronger isolation.",
      "Shared schema with RLS is cheapest and simplest for many small tenants. A database per tenant offers the strongest isolation and per-tenant backups or residency, at higher operational cost.",
      "The right choice depends on tenant count, isolation requirements, and compliance needs — and ideally one you can evolve without a rewrite.",
    ],
    related: ["row-level-security", "backend-as-a-service", "database-schema"],
  },
  {
    slug: "jwt",
    term: "JSON Web Token",
    aka: "JWT",
    definition:
      "A JSON Web Token (JWT) is a compact, signed token that securely carries claims (like a user's identity) between a client and server, commonly used for stateless authentication.",
    body: [
      "A JWT has three parts — header, payload, and signature — encoded and joined with dots. The payload holds claims such as the user ID and expiry; the signature lets the server verify the token wasn't tampered with.",
      "Because the token is self-contained and signed, the server can authenticate a request without a database lookup, enabling stateless, scalable auth. Tokens should be short-lived and paired with refresh tokens.",
      "JWTs are widely used in API authentication and are issued by identity systems after a user signs in via email or OAuth.",
    ],
    related: ["oauth", "api-key", "rest-api"],
  },
  {
    slug: "oauth",
    term: "OAuth",
    definition:
      "OAuth is an open standard for delegated authorization that lets users grant an application limited access to their accounts (e.g. 'Sign in with Google') without sharing passwords.",
    body: [
      "OAuth 2.0 lets a user authorize an app to act on their behalf via an identity provider. The app receives a token rather than the user's credentials, limiting exposure.",
      "It powers familiar 'Sign in with Google/GitHub' flows and is the backbone of social login. Combined with OpenID Connect, it also conveys identity, not just authorization.",
      "Backends typically integrate OAuth through an auth service or identity provider, then issue their own session or JWT for subsequent API calls.",
    ],
    related: ["jwt", "backend-as-a-service", "api-key"],
  },
  {
    slug: "crud",
    term: "CRUD",
    definition:
      "CRUD stands for Create, Read, Update, and Delete — the four basic operations for persistent data that most application APIs and database interactions are built around.",
    body: [
      "Nearly every data-driven feature maps to CRUD: creating records, reading them back (often with filtering and pagination), updating fields, and deleting. These map naturally to HTTP methods in a REST API.",
      "Hand-writing CRUD endpoints for every table is repetitive and error-prone, which is why auto-generated APIs that derive CRUD from the database schema have become popular.",
      "Good CRUD design also considers validation, access control, and consistency — concerns best enforced close to the data, in the database.",
    ],
    related: ["rest-api", "postgrest", "database-schema"],
  },
  {
    slug: "connection-pooling",
    term: "Connection Pooling",
    definition:
      "Connection pooling reuses a set of open database connections across many requests, avoiding the cost of opening a new connection each time and protecting the database from overload.",
    body: [
      "Opening a PostgreSQL connection is relatively expensive, and the database has a finite connection limit. A pool keeps a fixed number of connections open and hands them out to requests as needed.",
      "Pooling is essential for serverless and high-concurrency apps, where thousands of short-lived requests would otherwise exhaust the database's connections.",
      "Poolers like PgBouncer sit between the app and PostgreSQL, multiplexing many client connections onto fewer database connections.",
    ],
    related: ["serverless-database", "database-index", "acid-transactions"],
  },
  {
    slug: "serverless-database",
    term: "Serverless Database",
    definition:
      "A serverless database scales compute automatically and can scale to zero when idle, billing for actual usage instead of a fixed always-on server.",
    body: [
      "Serverless databases separate storage from compute and spin resources up or down based on load. When traffic stops, they can scale to zero, so you pay little or nothing while idle.",
      "This model suits spiky or unpredictable workloads and development environments. Features like instant branching let teams create isolated copies of a database for testing.",
      "Connection management matters more in serverless contexts, where many ephemeral functions connect at once — making connection pooling important.",
    ],
    related: ["connection-pooling", "backend-as-a-service", "database-migration"],
  },
  {
    slug: "database-migration",
    term: "Database Migration",
    definition:
      "A database migration is a versioned, repeatable change to a database schema (such as adding a table or column) that lets teams evolve the schema safely over time.",
    body: [
      "Migrations capture schema changes as ordered scripts checked into version control, so every environment — local, staging, production — can be brought to the same state reproducibly.",
      "Good migration practice includes making changes backward-compatible where possible, testing rollbacks, and running migrations as part of deployment.",
      "Because migrations are SQL against standard PostgreSQL, they remain portable and transparent rather than hidden behind a proprietary abstraction.",
    ],
    related: ["database-schema", "acid-transactions", "serverless-database"],
  },
  {
    slug: "database-schema",
    term: "Database Schema",
    definition:
      "A database schema is the structure of a database — its tables, columns, types, relationships, and constraints — that defines how data is organized and validated.",
    body: [
      "The schema is the blueprint of your data. In PostgreSQL it includes tables and columns, data types, primary and foreign keys, indexes, and constraints that enforce integrity.",
      "A well-designed relational schema models real relationships with foreign keys, preventing inconsistent data at the source instead of relying on application code.",
      "With PostgREST-style tooling, the schema also becomes the API surface — adding a table instantly exposes a corresponding endpoint.",
    ],
    related: ["database-index", "crud", "postgrest", "database-migration"],
  },
  {
    slug: "database-index",
    term: "Database Index",
    definition:
      "A database index is a data structure that speeds up reads by letting the database find rows without scanning the whole table, at the cost of extra storage and slower writes.",
    body: [
      "Indexes work like a book's index: instead of reading every page, the database jumps straight to matching rows. They're essential for fast filtering, sorting, and joins on large tables.",
      "Common index types in PostgreSQL include B-tree (the default, great for equality and ranges), GIN (for full-text and JSON), and partial indexes for subsets of rows.",
      "Indexes also matter for security and performance together — for example, indexing the columns referenced by row-level security policies keeps policy checks fast.",
    ],
    related: ["database-schema", "connection-pooling", "row-level-security"],
  },
  {
    slug: "acid-transactions",
    term: "ACID Transactions",
    definition:
      "ACID transactions guarantee that a group of database operations is Atomic, Consistent, Isolated, and Durable — so related changes either all succeed or all fail together.",
    body: [
      "ACID is what makes relational databases reliable. Atomicity ensures all-or-nothing changes; Consistency keeps data valid; Isolation prevents concurrent transactions from interfering; Durability survives crashes.",
      "Transactions are critical for operations like checkout, where an order and its line items must commit together — a guarantee document databases often can't provide.",
      "PostgreSQL provides full ACID compliance, which is why it's trusted for financial, e-commerce, and other correctness-critical workloads.",
    ],
    related: ["database-schema", "row-level-security", "database-migration"],
  },
  {
    slug: "api-key",
    term: "API Key",
    definition:
      "An API key is a secret token that identifies and authorizes a client when calling an API, controlling access and often rate limits and permissions.",
    body: [
      "API keys are a simple way to authenticate programmatic access. A client includes the key with each request, and the server validates it before serving data.",
      "Keys are often scoped — a public 'anon' key for client-side access constrained by row-level security, and a secret service key for trusted server-side use that bypasses those restrictions.",
      "Keys should be kept out of source control, rotated periodically, and paired with database-level access control so a leaked key has limited blast radius.",
    ],
    related: ["jwt", "oauth", "rest-api", "webhook"],
  },
  {
    slug: "webhook",
    term: "Webhook",
    definition:
      "A webhook is an HTTP callback that a service sends to a URL you provide when an event happens, letting systems react to changes in real time without polling.",
    body: [
      "Instead of repeatedly asking 'has anything changed?', webhooks push a request to your endpoint when an event occurs — a payment succeeds, a row changes, a file uploads.",
      "Receivers should verify webhook signatures, respond quickly with a 2xx, and process work asynchronously to stay reliable under load.",
      "Webhooks are a common way to connect a backend to external services and to trigger downstream automation.",
    ],
    related: ["rest-api", "api-key", "object-storage"],
  },
  {
    slug: "graphql",
    term: "GraphQL",
    definition:
      "GraphQL is a query language and runtime for APIs that lets clients request exactly the fields they need from a single endpoint, returning predictable, typed responses.",
    body: [
      "GraphQL exposes a typed schema and a single endpoint. Clients send queries describing precisely the data and shape they want, avoiding the over-fetching and under-fetching that can occur with rigid endpoints.",
      "It excels when many different clients consume the same data graph or when UIs are deeply nested. The trade-offs are harder HTTP caching (it's typically one POST endpoint) and the operational cost of running and securing a GraphQL server.",
      "REST and GraphQL both work well; the choice depends on your clients, caching needs, and how much infrastructure you want to run. Auto-generated REST often wins on simplicity and caching.",
    ],
    related: ["rest-api", "postgrest", "crud"],
  },
  {
    slug: "cors",
    term: "CORS",
    aka: "Cross-Origin Resource Sharing",
    definition:
      "CORS is a browser security mechanism that controls whether a web page on one origin may call an API on a different origin, using HTTP headers to grant access.",
    body: [
      "By default, browsers block cross-origin requests for security. CORS lets a server opt in by returning headers like Access-Control-Allow-Origin that tell the browser which origins, methods, and headers are permitted.",
      "When your frontend and API live on different domains, the API must send the right CORS headers or browser requests will fail. Note that CORS is a browser protection — it does not secure the API itself.",
      "Actual access control still belongs to authentication and database policies like row-level security; CORS only governs which web origins the browser will let make the call.",
    ],
    related: ["rest-api", "api-key", "row-level-security"],
  },
  {
    slug: "rate-limiting",
    term: "Rate Limiting",
    definition:
      "Rate limiting restricts how many requests a client can make to an API in a given time window, protecting the backend from abuse, overload, and runaway costs.",
    body: [
      "A rate limiter counts requests per client (by API key, IP, or user) and rejects or delays those over a threshold, often returning a 429 Too Many Requests response.",
      "Common algorithms include fixed windows, sliding windows, and token buckets. Limits protect shared resources, ensure fairness between clients, and contain the impact of misbehaving or malicious callers.",
      "Rate limiting complements authentication and access control: keys identify callers, policies decide what they can touch, and limits cap how often they can ask.",
    ],
    related: ["api-key", "rest-api", "webhook"],
  },
  {
    slug: "full-text-search",
    term: "Full-Text Search",
    definition:
      "Full-text search finds documents matching natural-language queries by indexing words and their variants, ranking results by relevance rather than exact matching.",
    body: [
      "Unlike a simple LIKE query, full-text search understands word boundaries, stemming (matching 'run' and 'running'), and relevance ranking. It's how search boxes return useful results quickly over large text columns.",
      "PostgreSQL has built-in full-text search using tsvector and tsquery types and GIN indexes, so you can add search to your data without a separate search service for many workloads.",
      "For very search-heavy products, a dedicated search engine may be warranted, but Postgres full-text search covers a wide range of needs with no extra infrastructure.",
    ],
    related: ["database-index", "database-schema", "rest-api"],
  },
  {
    slug: "foreign-key",
    term: "Foreign Key",
    definition:
      "A foreign key is a column (or set of columns) that references the primary key of another table, enforcing referential integrity between related rows.",
    body: [
      "Foreign keys express relationships — an order belongs to a customer, a message to a conversation — and let the database guarantee those references stay valid. You can't insert an order for a customer that doesn't exist.",
      "They also enable cascading behavior, such as deleting child rows when a parent is removed, and they document the data model directly in the schema.",
      "Relational integrity through foreign keys is a major advantage of PostgreSQL over schemaless stores, where relationships must be maintained in application code.",
    ],
    related: ["database-schema", "acid-transactions", "database-index"],
  },
];

export function getTerm(slug: string): GlossaryTerm | undefined {
  return GLOSSARY.find((t) => t.slug === slug);
}

export function getTermSlugs(): string[] {
  return GLOSSARY.map((t) => t.slug);
}

/** Alphabetical for the index page. */
export function getTermsSorted(): GlossaryTerm[] {
  return [...GLOSSARY].sort((a, b) => a.term.localeCompare(b.term));
}
