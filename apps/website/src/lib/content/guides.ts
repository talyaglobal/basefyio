import type { FaqItem } from "@/lib/seo/json-ld";

/**
 * Answer-first guides served at /guides/[slug]. Every statement about basefyio
 * is taken from the repo (README, docs pages, product code). Competitor claims
 * link to the competitor's own pages and carry a `VERIFY:` comment until
 * re-checked. Public copy does not name basefyio's internal components or its
 * database engine (owner decision): it says "SQL database".
 *
 * /guides/best-backend-database-for-startups is a hand-built page and is
 * listed on the index through STATIC_GUIDES.
 */
export type GuideSection = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
};

export type Guide = {
  slug: string;
  title: string;
  /** <= 160 characters. */
  description: string;
  /** ISO date, shown as "Last updated" and used as the sitemap lastmod. */
  updated: string;
  /** 2-3 sentence direct answer, shown first. */
  answer: string;
  sections: GuideSection[];
  faqs: FaqItem[];
  /** Official pages the guide's outside claims rest on. */
  sources?: { label: string; url: string }[];
  /** Links to docs or related pages: [label, href]. */
  related: [string, string][];
};

const UPDATED = "2026-11-26";

export const STATIC_GUIDES = [
  {
    slug: "best-backend-database-for-startups",
    title: "Best database and backend for startups",
    description:
      "How to pick a database and backend platform for a startup, and who each option suits.",
    updated: "2026-11-25",
  },
];

export const GUIDES: Guide[] = [
  {
    slug: "self-hosted-backend-as-a-service",
    title: "Self-hosted backend as a service: what to look for",
    description:
      "What a self-hosted backend platform should give you: database, auth, storage and API, a clear license, simple upgrades and an exit path. Options compared.",
    updated: UPDATED,
    answer:
      "A good self-hosted backend platform gives you a database, authentication, file storage and an API from one install, runs with a single command on your own server, and has a license and data format that let you leave. basefyio, Supabase, Appwrite and PocketBase all cover the self-hosting case, with different trade-offs in size, license and maturity.",
    sections: [
      {
        heading: "What to check before you pick one",
        bullets: [
          "What is included: database, authentication, object storage and an API generated from your data, or only some of them.",
          "How you run it: a Compose file you can read, pinned versions, and a documented upgrade path.",
          "The license: it decides what you can offer to your own customers. Server licenses and client SDK licenses are often different.",
          "How you leave: standard SQL data and exportable files keep the cost of switching low.",
          "Backups: a self-hosted platform makes recovery your job, so look for built-in backups and tested restores.",
        ],
      },
      {
        heading: "Where basefyio fits",
        paragraphs: [
          "basefyio is built to be self-hosted. The repository ships Compose files that start the platform API, the dashboard, a database per project, authentication and S3-compatible storage together. The server and dashboard are AGPL-3.0-or-later; the client SDK and CLI are MIT, so installing them in your own app does not make your app AGPL.",
          "Each project gets a dedicated SQL database and its own authentication realm. Nightly backups and point-in-time recovery are part of the platform. basefyio is currently in beta and does not have native mobile SDKs.",
        ],
      },
      {
        heading: "Other options",
        bullets: [
          // CHECKED 2026-11-26: Supabase's self-hosting guide calls Docker the recommended way.
          "Supabase documents a Docker-based self-hosting setup and is the most established of the group.",
          // CHECKED 2026-11-26: Appwrite runs on any OS that can run Docker and lists many client and server SDKs.
          "Appwrite is open source with Docker-based self-hosting and official SDKs for many client platforms.",
          // CHECKED 2026-11-26: PocketBase docs: open source backend with an embedded SQLite database, realtime, auth and a dashboard; the page says it is not yet recommended for production-critical applications.
          "PocketBase is an open source backend with an embedded SQLite database that suits small projects; its own documentation says it is not yet recommended for production-critical applications.",
        ],
      },
    ],
    faqs: [
      {
        question: "Can I self-host basefyio for free?",
        answer:
          "Yes. The repository is public and the server and dashboard are licensed AGPL-3.0-or-later, so you can run it on your own infrastructure with Docker Compose. A hosted service with free and paid plans is also available.",
      },
      {
        question: "Does the AGPL license apply to my application?",
        answer:
          "The AGPL covers the basefyio server and dashboard. The client SDK and CLI you install into your own app are MIT-licensed, so your application code is not affected. Read the license files if you plan to modify and host the server itself.",
      },
      {
        question: "What does a basefyio self-host need?",
        answer:
          "Docker with Compose v2, and a configured environment file. Project creation needs an encryption key for stored database credentials, and the API refuses to create a project without it.",
      },
    ],
    sources: [
      { label: "Supabase self-hosting guide", url: "https://supabase.com/docs/guides/self-hosting" },
      { label: "Appwrite self-hosting guide", url: "https://appwrite.io/docs/advanced/self-hosting" },
      { label: "PocketBase documentation", url: "https://pocketbase.io/docs/" },
    ],
    related: [
      ["Self-hosting docs", "/docs/self-hosting"],
      ["basefyio vs. Supabase", "/compare/basefyio-vs-supabase"],
      ["basefyio vs. Appwrite", "/compare/basefyio-vs-appwrite"],
    ],
  },

  {
    slug: "database-per-project",
    title: "Why give every project its own database",
    description:
      "A dedicated database per project isolates data, limits the blast radius of mistakes and simplifies backups. What it costs, and how basefyio does it.",
    updated: UPDATED,
    answer:
      "Giving each project its own database means one project's data, load and mistakes cannot reach another's, and each can be backed up, restored or moved on its own. The cost is more databases to run and a little more overhead per project. basefyio creates a dedicated SQL database and an isolated authentication realm for every project.",
    sections: [
      {
        heading: "What you gain",
        bullets: [
          "Isolation: there are no shared tables between projects, so a bad query or migration in one project cannot touch another.",
          "Independent recovery: a project can be restored to a new project or rewound to a point in time without affecting any other.",
          "Clear access: each project has its own credentials, and a read-only role for BI and reporting tools.",
          "Simpler compliance conversations: a customer's data lives in its own database.",
        ],
      },
      {
        heading: "What it costs",
        paragraphs: [
          "More databases means more to provision, monitor and size. A platform has to automate creation, connection pooling and backups for it to stay manageable, which is the part basefyio takes on. For tiny projects a single shared database can be simpler and cheaper.",
        ],
      },
      {
        heading: "How basefyio does it",
        paragraphs: [
          "When you create a project, basefyio provisions its database, its authentication realm and its storage, and issues an anon key and a service key. You query the database with a REST API generated from your tables, with the JavaScript SDK, or with SQL in the dashboard's SQL editor. New projects also get a SELECT-only database role for reporting tools.",
        ],
      },
    ],
    faqs: [
      {
        question: "Is a database per project the same as a schema per project?",
        answer:
          "No. A schema per project shares one database, so credentials, load and backups are shared. A database per project separates them completely.",
      },
      {
        question: "Can I still query across projects?",
        answer:
          "Projects are isolated on purpose, so there is no built-in cross-project query. Combine data in your own application or a reporting tool that connects to each project's read-only role.",
      },
      {
        question: "Does every basefyio project get a database?",
        answer:
          "Yes. Every project is provisioned with a dedicated SQL database and its own authentication realm. Plan limits set how many projects you can create.",
      },
    ],
    related: [
      ["Backups and point-in-time recovery", "/docs/backups"],
      ["Connecting to a project", "/docs/connect"],
      ["Pricing and limits", "/docs/pricing-and-limits"],
    ],
  },

  {
    slug: "migrate-from-supabase",
    title: "Moving a Supabase project to basefyio",
    description:
      "What moving a Supabase project to basefyio involves: schema, data and users, what to check before you start, and what to test after.",
    updated: UPDATED,
    answer:
      "basefyio can import an existing Supabase project, bringing over the schema, the data and the users. Plan the move as a rehearsal first: import into a new basefyio project, test your application against it, and only then switch traffic.",
    sections: [
      {
        heading: "What gets imported",
        paragraphs: [
          "basefyio's import covers a Supabase project's schema, data and users. Features that belong to the platform around the database, such as edge functions, are not part of the database and need to be re-created separately. Check the current import options in the dashboard before you start, because they can change.",
        ],
      },
      {
        heading: "A safe order of work",
        bullets: [
          "Create a new basefyio project; it gets its own database and authentication realm.",
          "Run the import against that new project, not an existing one.",
          "Point a copy of your application at the basefyio project and test sign-in, queries and file access.",
          "Compare row counts and spot-check data in the SQL editor.",
          "Switch your production traffic only after the checks pass, and keep the old project until you are sure.",
        ],
      },
      {
        heading: "What to check afterwards",
        bullets: [
          "Row-level security policies: review them in the dashboard's policy editor.",
          "Storage objects: confirm that files and their access rules came across.",
          "Client configuration: update the API URL and keys in your app.",
          "Auth providers: re-check OAuth redirect URLs for the new project.",
        ],
      },
    ],
    faqs: [
      {
        question: "Does basefyio import users from Supabase?",
        answer:
          "Yes. The import brings over the project's users together with the schema and data. Test sign-in on a copy of your app before switching.",
      },
      {
        question: "Will my Supabase client code work unchanged?",
        answer:
          "Do not assume so. basefyio has its own SDK, basefyio-js, and a REST API. Plan to update the client calls and test them. Some compatibility layers exist for specific APIs but are off until enabled for a project.",
      },
      {
        question: "Can I try it without risking production?",
        answer:
          "Yes. Import into a new, separate project and leave your Supabase project untouched until you have tested the result.",
      },
    ],
    related: [
      ["basefyio vs. Supabase", "/compare/basefyio-vs-supabase"],
      ["JavaScript SDK", "/docs/sdk"],
      ["Authentication docs", "/docs/auth"],
    ],
  },

  {
    slug: "multi-tenant-backend-for-agencies",
    title: "One backend platform for many client projects",
    description:
      "How agencies and teams can run many client apps from one backend platform: isolated projects, team roles, per-project keys and plan limits.",
    updated: UPDATED,
    answer:
      "Agencies and teams building many apps need each client isolated from the others while managing them in one place. basefyio is multi-tenant: one platform manages many projects, each with its own database, authentication realm and keys, and access is controlled by roles at team and project level.",
    sections: [
      {
        heading: "What a multi-project setup needs",
        bullets: [
          "Isolation: one client's data and users must not be reachable from another's.",
          "Delegation: team members need access to some projects and not others.",
          "Predictable limits: plans should cap what a project or team can use.",
          "One dashboard: creating, monitoring and backing up many projects should not mean many tools.",
        ],
      },
      {
        heading: "How basefyio handles it",
        paragraphs: [
          "Each project has its own dedicated SQL database, its own authentication realm and its own API keys. Teams and projects have roles and permissions, so you can give a contractor access to one client's project only. Plans set limits for projects, database size, storage, team members, API requests and monthly active users; see the pricing and limits page for the current values.",
          "Everything is available through the dashboard, the REST API and the CLI, so provisioning a project for a new client can be scripted.",
        ],
      },
      {
        heading: "Where it does not fit",
        paragraphs: [
          "If you only run one application, the multi-project features add nothing, and a simpler setup may be enough.",
        ],
      },
    ],
    faqs: [
      {
        question: "Can I create projects through an API?",
        answer:
          "Yes. Projects can be created and managed through the platform's REST API and the basefyio CLI as well as the dashboard.",
      },
      {
        question: "Is client data separated?",
        answer:
          "Each project has a dedicated database and its own authentication realm, so there are no shared tables between projects.",
      },
      {
        question: "How are usage limits set?",
        answer:
          "By plan. Limits cover projects, database size, file storage, team members, egress, API requests and monthly active users. The pricing and limits page lists what each plan includes.",
      },
    ],
    related: [
      ["Pricing and limits", "/docs/pricing-and-limits"],
      ["CLI reference", "/docs/cli"],
      ["Why a database per project", "/guides/database-per-project"],
    ],
  },

  {
    slug: "point-in-time-recovery-for-app-databases",
    title: "Point-in-time recovery for your app's database",
    description:
      "What point-in-time recovery is, why a nightly backup is not enough, and how basefyio lets you rewind a project database to an exact moment.",
    updated: UPDATED,
    answer:
      "Point-in-time recovery (PITR) rewinds a database to a chosen moment, so a bad migration or an accidental DELETE at 14:32 can be undone by recovering to 14:31. A nightly backup alone can only take you back to last night. basefyio provides both for every project database.",
    sections: [
      {
        heading: "Backups versus PITR",
        paragraphs: [
          "A nightly backup is a snapshot: restoring it loses everything since it was taken. PITR keeps a continuous archive of changes between snapshots, so you can choose the exact time to recover to, within the recovery window.",
        ],
      },
      {
        heading: "How it works in basefyio",
        bullets: [
          "Nightly base backups run automatically; nothing to configure. The project's backup page lists them and shows whether the newest one has been proven restorable.",
          "Changes are archived continuously between base backups.",
          "Restoring a backup defaults to a new project, so the original stays untouched. Overwriting the existing project asks you to type its name first.",
          "For PITR you pick a date and time, including seconds, and type RESTORE to confirm. A time outside the recovery window is flagged before anything runs.",
          "The final write into your database is all or nothing: if a restore fails or runs past its time limit, it is rolled back.",
        ],
      },
      {
        heading: "Limits to know",
        paragraphs: [
          "Restores run in the background, one at a time across the platform. One restore per project can be active at once, and a project can start up to three per hour. A restore usually takes several minutes.",
        ],
      },
    ],
    faqs: [
      {
        question: "What is point-in-time recovery?",
        answer:
          "It is restoring a database to its exact state at a chosen moment, using a base backup plus the archived changes after it.",
      },
      {
        question: "Does a restore overwrite my live data?",
        answer:
          "Not by default. Restoring defaults to a new project. Overwriting the existing project is possible but asks you to type its name first.",
      },
      {
        question: "Can I trigger a recovery from code?",
        answer:
          "Yes. The platform API exposes a restore endpoint that starts a job and a second endpoint to poll its progress. See the backups documentation for the request format.",
      },
    ],
    related: [
      ["Backups and PITR docs", "/docs/backups"],
      ["Why a database per project", "/guides/database-per-project"],
    ],
  },

  {
    slug: "realtime-in-a-sql-backend",
    title: "Realtime data in a SQL-first backend",
    description:
      "How to push live INSERT, UPDATE and DELETE events from a SQL backend to your app, and what to decide before you turn realtime on for a table.",
    updated: UPDATED,
    answer:
      "In a SQL-first backend, realtime means your app receives an event whenever a row is inserted, updated or deleted, instead of polling. In basefyio you switch realtime on per table or collection, then subscribe with the SDK or a plain EventSource connection.",
    sections: [
      {
        heading: "Decide what to broadcast",
        paragraphs: [
          "Nothing is broadcast by default in basefyio. You enable realtime for each table or collection from the project's Realtime page. This is an explicit opt-in on purpose: change events carry the full row data and are delivered to clients that hold a project API key, so enable only tables where that is acceptable.",
        ],
      },
      {
        heading: "Subscribe from the client",
        bullets: [
          "With the SDK: subscribe to a table or collection and filter by event type (INSERT, UPDATE, DELETE, or all). The SDK reconnects automatically with exponential backoff.",
          "Without the SDK: open an EventSource connection to the realtime stream. Use the anon key; a service key is rejected in the query string.",
          "Each event carries a type, the entity, the new row and, for updates and deletes, the old values, plus a commit timestamp.",
        ],
      },
      {
        heading: "Beyond change events",
        paragraphs: [
          "The same stream also carries presence, who is on a channel, and client-to-client broadcast, so one connection can serve live data, who-is-online and simple messaging.",
        ],
      },
    ],
    faqs: [
      {
        question: "Does realtime work on every table?",
        answer:
          "Only on tables and collections you enable. Nothing broadcasts by default.",
      },
      {
        question: "Do I need the SDK?",
        answer:
          "No. The stream can be consumed with a plain EventSource, using the anon key as a query parameter.",
      },
      {
        question: "Is it polling?",
        answer:
          "No. Events are pushed to connected clients as the change happens.",
      },
    ],
    related: [
      ["Realtime docs", "/docs/realtime"],
      ["JavaScript SDK", "/docs/sdk"],
    ],
  },

  {
    slug: "ai-search-in-your-backend",
    title: "Semantic search and RAG inside your backend",
    description:
      "How to add semantic search and retrieval over your own documents without a separate vector service, using the project database and storage in basefyio.",
    updated: UPDATED,
    answer:
      "You can add semantic search by storing text as vectors in your project's own database and searching by meaning rather than keywords, and add retrieval by indexing files already in your storage buckets. basefyio provides both, with a choice of embedding provider per project, so you do not need a separate vector service.",
    sections: [
      {
        heading: "What you get",
        bullets: [
          "Vector search in the project database: enable it from the dashboard's AI / Embeddings page, and the required tables are created for you.",
          "Embedding provider choice: pick the provider and model for the project, or use your own key for it.",
          "Retrieval over documents: files in your storage buckets can be indexed so your application can search and cite them.",
          "A REST API: store text, then search by meaning with the anon key and a signed-in user's token, or with the service key.",
          "Clarity on data flow: the dashboard shows where text is sent and the provider's retention statement, so you can show the same to your users.",
        ],
      },
      {
        heading: "The dashboard assistant",
        paragraphs: [
          "The dashboard also has an AI assistant with ask, plan and agent modes, included in the Pro plan and above. In agent mode, read-only queries run on their own inside a read-only transaction; every statement that changes data or schema is shown to you first and runs only when you approve it.",
        ],
      },
    ],
    faqs: [
      {
        question: "Do I need a separate vector database?",
        answer:
          "Not with basefyio. Vectors are stored in your project's own database, next to the rest of your data.",
      },
      {
        question: "Can I choose the embedding provider?",
        answer:
          "Yes. The provider and model are set for the platform and can be overridden per project, including with your own provider key.",
      },
      {
        question: "Is the AI assistant on the free plan?",
        answer:
          "No. The dashboard assistant is part of the Pro plan and above. Embeddings and retrieval over your own documents are not limited by that.",
      },
    ],
    related: [
      ["AI and embeddings docs", "/docs/ai"],
      ["Storage docs", "/docs/storage"],
    ],
  },

  {
    slug: "row-level-security-and-api-keys",
    title: "API keys, JWTs and row-level security explained",
    description:
      "How anon keys, service keys, JWTs and row-level security work together to protect data in a backend, and the mistakes to avoid in client code.",
    updated: UPDATED,
    answer:
      "Keep two kinds of key apart: an anon key is safe to ship in browsers and mobile apps because row-level security limits what it can read, while a service key bypasses those rules and must stay on your server. A signed-in user's JWT tells the database who is asking, so policies can filter rows per user.",
    sections: [
      {
        heading: "The layers",
        bullets: [
          "API keys identify the project and the access level. The anon key is for client-side code; the service key is server-side only.",
          "JWTs identify the user. They are issued at sign-in and verified against the project's authentication realm.",
          "Row-level security (RLS) policies decide which rows a role may read or write, using the user's ID and claims.",
        ],
      },
      {
        heading: "How it looks in basefyio",
        paragraphs: [
          "Anonymous requests use the anon key and run as the anon role. Signed-in requests add the user's JWT and run as the authenticated role, and RLS policies filter rows with helper functions such as auth.uid(). The service key runs as the service role and bypasses RLS.",
          "You can switch RLS on or off per table and create, edit or drop policies from the dashboard, with templates, a SQL preview and a rolled-back check against the database. Policies still accept hand-written SQL.",
        ],
      },
      {
        heading: "Mistakes to avoid",
        bullets: [
          "Shipping the service key in client code, a public repository or a mobile app.",
          "Turning on a table's API without writing any policy for it.",
          "Trusting a user ID sent in the request body instead of the one in the JWT.",
          "Enabling realtime on tables whose rows should not reach every client holding the key.",
        ],
      },
    ],
    faqs: [
      {
        question: "Is it safe to expose the anon key?",
        answer:
          "It is designed to be used in client code, but only because row-level security limits what it can access. A table with no suitable policy is a risk, so review policies before launch.",
      },
      {
        question: "What does the service key do?",
        answer:
          "It gives full access and bypasses row-level security. Use it only on a server you control and never in a browser or mobile app.",
      },
      {
        question: "Where do I edit policies?",
        answer:
          "In the dashboard under Database, Policies, or with SQL in the SQL editor.",
      },
    ],
    related: [
      ["Security docs", "/docs/security"],
      ["Authentication docs", "/docs/auth"],
    ],
  },
];

export function getGuide(slug: string): Guide | undefined {
  return GUIDES.find((g) => g.slug === slug);
}

export function getGuideSlugs(): string[] {
  return GUIDES.map((g) => g.slug);
}
