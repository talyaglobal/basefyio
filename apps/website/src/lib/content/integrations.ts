import type { FaqItem } from "@/lib/seo/json-ld";

/**
 * Data registry powering the programmatic `/integrations/[slug]` pages. Each
 * entry targets "Basefyio + <framework>" / "<framework> backend" intent and
 * shows how to use the `basefyio-js` SDK in that environment.
 *
 * The SDK is JavaScript/TypeScript only, so every integration here is a JS
 * runtime or framework where `basefyio-js` actually runs — no fabricated SDKs.
 */
export type IntegrationBenefit = { title: string; body: string };

export type Integration = {
  slug: string;
  /** Display name, e.g. "Next.js". */
  name: string;
  /** "Framework" | "Runtime" | "Mobile". */
  category: string;
  title: string;
  description: string;
  intro: string;
  /** Install command. */
  install: string;
  setupTitle: string;
  setup: string;
  /** Framework-specific note under the setup snippet. */
  setupNote: string;
  usageTitle: string;
  usage: string;
  benefits: IntegrationBenefit[];
  faqs: FaqItem[];
};

const INSTALL = "npm install basefyio-js";

export const INTEGRATIONS: Integration[] = [
  {
    slug: "nextjs",
    name: "Next.js",
    category: "Framework",
    title: "Basefyio + Next.js: PostgreSQL Backend for Your App",
    description:
      "Use Basefyio with Next.js for a PostgreSQL backend, auth, storage, and a REST API. Works in Server Components, Route Handlers, and the client with the basefyio-js SDK.",
    intro:
      "Next.js handles the frontend and server rendering; Basefyio gives it a backend — PostgreSQL, authentication, storage, and a REST API — without standing up your own server.",
    install: INSTALL,
    setupTitle: "Create the client",
    setup: `// lib/basefyio.ts
import { createClient } from "basefyio-js";

export const kb = createClient({
  projectId: process.env.NEXT_PUBLIC_BASEFYIO_PROJECT_ID!,
  apiKey: process.env.NEXT_PUBLIC_BASEFYIO_ANON_KEY!,
});`,
    setupNote:
      "Use the public anon key (gated by row-level security) in the browser and Server Components. For trusted server-only code, use a service key from a non-public env variable instead.",
    usageTitle: "Fetch data in a Server Component",
    usage: `// app/posts/page.tsx
import { kb } from "@/lib/basefyio";

export default async function Posts() {
  const { data } = await kb
    .from("posts")
    .select("id, title")
    .order("created_at", { ascending: false });

  return <ul>{data?.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}`,
    benefits: [
      {
        title: "Server and client ready",
        body: "The SDK runs in Server Components, Route Handlers, and the browser, so you query the same backend everywhere.",
      },
      {
        title: "No API layer to build",
        body: "Define a table and read it directly — skip writing Next.js API routes for basic CRUD.",
      },
      {
        title: "Auth included",
        body: "Add sign-in with kb.auth and scope data with row-level security.",
      },
    ],
    faqs: [
      {
        question: "Does Basefyio work with the Next.js App Router?",
        answer:
          "Yes. The basefyio-js SDK works in Server Components, Route Handlers, and Client Components. Use the public anon key on the client and a service key only in server-only code.",
      },
      {
        question: "Where do I put my Basefyio keys in Next.js?",
        answer:
          "Public anon keys go in NEXT_PUBLIC_ environment variables for client use. Keep service keys in non-public env variables, accessed only on the server.",
      },
    ],
  },
  {
    slug: "react",
    name: "React",
    category: "Framework",
    title: "Basefyio + React: A Backend for Your React App",
    description:
      "Connect a React app to Basefyio for PostgreSQL data, authentication, and storage via the basefyio-js SDK — no custom backend required.",
    intro:
      "Give your React app a real backend. With basefyio-js you query PostgreSQL, authenticate users, and store files directly from your components.",
    install: INSTALL,
    setupTitle: "Create a shared client",
    setup: `// src/basefyio.ts
import { createClient } from "basefyio-js";

export const kb = createClient({
  projectId: import.meta.env.VITE_BASEFYIO_PROJECT_ID,
  apiKey: import.meta.env.VITE_BASEFYIO_ANON_KEY,
});`,
    setupNote:
      "Always use the client-safe anon key in the browser. Row-level security policies decide what each user can read or write.",
    usageTitle: "Load data in a component",
    usage: `import { useEffect, useState } from "react";
import { kb } from "./basefyio";

export function Posts() {
  const [posts, setPosts] = useState([]);
  useEffect(() => {
    kb.from("posts").select("id, title").then(({ data }) => setPosts(data ?? []));
  }, []);
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}`,
    benefits: [
      {
        title: "Talk to the backend directly",
        body: "Query PostgreSQL from components with filtering, ordering, and pagination built in.",
      },
      {
        title: "Built-in auth state",
        body: "Use kb.auth.onAuthStateChange to react to sign-in and sign-out in your UI.",
      },
      {
        title: "Secured by the database",
        body: "Row-level security keeps the anon key safe to ship to the browser.",
      },
    ],
    faqs: [
      {
        question: "Is it safe to use Basefyio in the browser?",
        answer:
          "Yes, with the anon key and row-level security enabled. Policies run in the database, so users only ever read or write rows they're allowed to.",
      },
      {
        question: "Can I build a custom auth hook?",
        answer:
          "Yes. Wrap kb.auth.getUser and kb.auth.onAuthStateChange in a React context to expose the current user across your app.",
      },
    ],
  },
  {
    slug: "vue",
    name: "Vue",
    category: "Framework",
    title: "Basefyio + Vue: PostgreSQL Backend for Vue Apps",
    description:
      "Use Basefyio with Vue 3 for a PostgreSQL backend, auth, and storage. The basefyio-js SDK works cleanly with the Composition API.",
    intro:
      "Pair Vue's reactivity with a Basefyio backend. The basefyio-js SDK fits naturally into composables for data, auth, and storage.",
    install: INSTALL,
    setupTitle: "Create the client",
    setup: `// src/basefyio.ts
import { createClient } from "basefyio-js";

export const kb = createClient({
  projectId: import.meta.env.VITE_BASEFYIO_PROJECT_ID,
  apiKey: import.meta.env.VITE_BASEFYIO_ANON_KEY,
});`,
    setupNote:
      "Use the anon key in the browser; row-level security enforces access at the database.",
    usageTitle: "A data composable",
    usage: `// composables/usePosts.ts
import { ref, onMounted } from "vue";
import { kb } from "../basefyio";

export function usePosts() {
  const posts = ref([]);
  onMounted(async () => {
    const { data } = await kb.from("posts").select("id, title");
    posts.value = data ?? [];
  });
  return { posts };
}`,
    benefits: [
      {
        title: "Composition-API friendly",
        body: "Wrap queries in composables and return reactive refs your components consume.",
      },
      {
        title: "Full backend included",
        body: "Database, auth, and storage in one SDK — no separate services to wire.",
      },
      {
        title: "Standard PostgreSQL",
        body: "Real SQL and row-level security, fully portable with pg_dump.",
      },
    ],
    faqs: [
      {
        question: "Does Basefyio work with Nuxt?",
        answer:
          "Yes. Nuxt is built on Vue, and basefyio-js runs in both server and client contexts. Use the anon key on the client and a service key only in server routes.",
      },
      {
        question: "How do I track the logged-in user in Vue?",
        answer:
          "Create a composable around kb.auth.getUser and kb.auth.onAuthStateChange and provide it app-wide.",
      },
    ],
  },
  {
    slug: "sveltekit",
    name: "SvelteKit",
    category: "Framework",
    title: "Basefyio + SvelteKit: Backend for Svelte Apps",
    description:
      "Use Basefyio with SvelteKit for PostgreSQL data, auth, and storage. The basefyio-js SDK works in load functions, endpoints, and components.",
    intro:
      "SvelteKit covers routing and rendering; Basefyio covers the backend. Use basefyio-js in load functions and server endpoints to fetch and mutate data.",
    install: INSTALL,
    setupTitle: "Create the client",
    setup: `// src/lib/basefyio.ts
import { createClient } from "basefyio-js";
import { PUBLIC_BASEFYIO_PROJECT_ID, PUBLIC_BASEFYIO_ANON_KEY } from "$env/static/public";

export const kb = createClient({
  projectId: PUBLIC_BASEFYIO_PROJECT_ID,
  apiKey: PUBLIC_BASEFYIO_ANON_KEY,
});`,
    setupNote:
      "Use PUBLIC_ env variables with the anon key for client/load code. Keep service keys in private env variables for server-only logic.",
    usageTitle: "Load data for a route",
    usage: `// src/routes/posts/+page.ts
import { kb } from "$lib/basefyio";

export async function load() {
  const { data } = await kb.from("posts").select("id, title");
  return { posts: data ?? [] };
}`,
    benefits: [
      {
        title: "Works in load functions",
        body: "Fetch data during SSR or on the client with the same SDK call.",
      },
      {
        title: "No backend boilerplate",
        body: "Skip writing endpoints for basic data access — query the database directly.",
      },
      {
        title: "Auth and storage included",
        body: "kb.auth and kb.storage cover sign-in and file uploads out of the box.",
      },
    ],
    faqs: [
      {
        question: "Can I use Basefyio in SvelteKit server endpoints?",
        answer:
          "Yes. Create a server-side client with a service key in +server.ts or +page.server.ts for trusted operations, and a public client for the browser.",
      },
      {
        question: "Does row-level security still apply?",
        answer:
          "Yes. With the anon key, every query is constrained by your PostgreSQL row-level security policies.",
      },
    ],
  },
  {
    slug: "react-native",
    name: "React Native",
    category: "Mobile",
    title: "Basefyio + React Native: Backend for Mobile Apps",
    description:
      "Build iOS and Android apps on Basefyio with React Native. The basefyio-js SDK provides PostgreSQL data, auth, and storage over a REST API.",
    intro:
      "React Native apps need a backend they can call directly. basefyio-js works in React Native to query PostgreSQL, authenticate users, and upload files.",
    install: INSTALL,
    setupTitle: "Create the client",
    setup: `// basefyio.ts
import { createClient } from "basefyio-js";

export const kb = createClient({
  projectId: process.env.EXPO_PUBLIC_BASEFYIO_PROJECT_ID!,
  apiKey: process.env.EXPO_PUBLIC_BASEFYIO_ANON_KEY!,
});`,
    setupNote:
      "With Expo, use EXPO_PUBLIC_ env variables for the anon key. Secure user data with row-level security so the mobile client only sees permitted rows.",
    usageTitle: "Sign in and load data",
    usage: `import { kb } from "./basefyio";

await kb.auth.signIn({ email, password });

const { data } = await kb
  .from("messages")
  .select("id, body, sent_at")
  .order("sent_at", { ascending: true });`,
    benefits: [
      {
        title: "Direct, serverless calls",
        body: "Your app talks to the backend over plain HTTP/JSON — no server to maintain per screen.",
      },
      {
        title: "Auth built in",
        body: "Email, OAuth, and magic-link sign-in via kb.auth, with sessions handled for you.",
      },
      {
        title: "Files with signed URLs",
        body: "Upload media to S3-compatible storage and serve it with access-controlled URLs.",
      },
    ],
    faqs: [
      {
        question: "Does basefyio-js work in React Native and Expo?",
        answer:
          "Yes. It's a standard JavaScript SDK using fetch, so it runs in React Native and Expo. Use public env variables for the anon key.",
      },
      {
        question: "How is mobile data kept secure?",
        answer:
          "Authentication plus PostgreSQL row-level security means even direct API calls only return rows the signed-in user is allowed to access.",
      },
    ],
  },
  {
    slug: "nodejs",
    name: "Node.js",
    category: "Runtime",
    title: "Basefyio + Node.js: Backend Data Access from the Server",
    description:
      "Use Basefyio from Node.js for PostgreSQL queries, auth, and storage. Ideal for server-side logic, background jobs, and scripts with the basefyio-js SDK.",
    intro:
      "From Node.js you can run trusted server-side logic against Basefyio — background jobs, webhooks, scripts, and APIs — using a service key for full access.",
    install: INSTALL,
    setupTitle: "Create a server client",
    setup: `// basefyio.js
import { createClient } from "basefyio-js";

export const kb = createClient({
  projectId: process.env.BASEFYIO_PROJECT_ID,
  apiKey: process.env.BASEFYIO_SERVICE_KEY, // server-only
});`,
    setupNote:
      "On the server you can use a service key for trusted operations that bypass row-level security. Never expose a service key to the browser.",
    usageTitle: "Run a query or raw SQL",
    usage: `import { kb } from "./basefyio.js";

// Query builder
const { data } = await kb.from("users").select("id, email").eq("active", true);

// Or raw SQL for reports (sanitize any dynamic input!)
const { data: stats } = await kb.sql(
  "select plan, count(*) from subscriptions group by plan",
);`,
    benefits: [
      {
        title: "Trusted server access",
        body: "Use a service key for jobs and admin tasks that need to bypass row-level security.",
      },
      {
        title: "Raw SQL when you need it",
        body: "Run reports and complex queries with kb.sql, in addition to the query builder.",
      },
      {
        title: "Same SDK everywhere",
        body: "Share data-access code between your server and client where appropriate.",
      },
    ],
    faqs: [
      {
        question: "Can I run background jobs against Basefyio?",
        answer:
          "Yes. Use a Node.js process with a service key to run scheduled jobs, process webhooks, or perform admin operations.",
      },
      {
        question: "When should I use a service key vs. the anon key?",
        answer:
          "Use the service key only on trusted servers for operations that must bypass row-level security. Use the anon key for anything reachable by the browser.",
      },
    ],
  },
  {
    slug: "astro",
    name: "Astro",
    category: "Framework",
    title: "Basefyio + Astro: A Backend for Content and Apps",
    description:
      "Use Basefyio with Astro to power dynamic data, auth, and storage. The basefyio-js SDK works in Astro components and server endpoints.",
    intro:
      "Astro is great for fast content sites with islands of interactivity. Basefyio adds the dynamic backend — PostgreSQL, auth, and storage — when you need it.",
    install: INSTALL,
    setupTitle: "Create the client",
    setup: `// src/lib/basefyio.ts
import { createClient } from "basefyio-js";

export const kb = createClient({
  projectId: import.meta.env.PUBLIC_BASEFYIO_PROJECT_ID,
  apiKey: import.meta.env.PUBLIC_BASEFYIO_ANON_KEY,
});`,
    setupNote:
      "Use PUBLIC_ env variables for the anon key. For server endpoints that need elevated access, use a service key from a non-public variable.",
    usageTitle: "Fetch data in a page",
    usage: `---
// src/pages/posts.astro
import { kb } from "../lib/basefyio";
const { data: posts } = await kb.from("posts").select("id, title");
---
<ul>{posts?.map((p) => <li>{p.title}</li>)}</ul>`,
    benefits: [
      {
        title: "Fetch at build or request time",
        body: "Use the SDK in frontmatter for SSG or SSR, depending on your Astro output mode.",
      },
      {
        title: "Add a backend incrementally",
        body: "Keep Astro's content speed and reach for Basefyio only where you need dynamic data.",
      },
      {
        title: "Auth and storage ready",
        body: "kb.auth and kb.storage are available in server endpoints.",
      },
    ],
    faqs: [
      {
        question: "Does Basefyio work with Astro SSR and SSG?",
        answer:
          "Yes. Call the SDK in component frontmatter or endpoints. For SSG, data is fetched at build time; for SSR, on each request.",
      },
      {
        question: "Can I add interactive, authenticated islands?",
        answer:
          "Yes. Use a framework island (React, Vue, Svelte) with the SDK and the anon key for authenticated, interactive components.",
      },
    ],
  },
  {
    slug: "remix",
    name: "Remix",
    category: "Framework",
    title: "Basefyio + Remix: PostgreSQL Backend with Loaders and Actions",
    description:
      "Use Basefyio with Remix for PostgreSQL data, auth, and storage. The basefyio-js SDK fits Remix loaders and actions for server-side data access.",
    intro:
      "Remix's loaders and actions are a natural home for backend calls. Use basefyio-js server-side to read and mutate Basefyio data on each request.",
    install: INSTALL,
    setupTitle: "Create a server client",
    setup: `// app/basefyio.server.ts
import { createClient } from "basefyio-js";

export const kb = createClient({
  projectId: process.env.BASEFYIO_PROJECT_ID!,
  apiKey: process.env.BASEFYIO_ANON_KEY!,
});`,
    setupNote:
      "Keep the client in a .server file so keys never reach the browser. Use a service key only for trusted operations.",
    usageTitle: "Load data in a route",
    usage: `// app/routes/posts.tsx
import { kb } from "~/basefyio.server";
import { useLoaderData } from "@remix-run/react";

export async function loader() {
  const { data } = await kb.from("posts").select("id, title");
  return { posts: data ?? [] };
}

export default function Posts() {
  const { posts } = useLoaderData<typeof loader>();
  return <ul>{posts.map((p) => <li key={p.id}>{p.title}</li>)}</ul>;
}`,
    benefits: [
      {
        title: "Server-side by design",
        body: "Loaders and actions run on the server, keeping keys and queries off the client.",
      },
      {
        title: "Mutations via actions",
        body: "Use actions to insert and update Basefyio data on form submissions.",
      },
      {
        title: "Full backend included",
        body: "Database, auth, and storage from one SDK.",
      },
    ],
    faqs: [
      {
        question: "Where should the Basefyio client live in Remix?",
        answer:
          "In a .server file so it's never bundled to the browser. Loaders and actions import it for data access.",
      },
      {
        question: "How do I handle auth in Remix?",
        answer:
          "Authenticate with kb.auth and persist the session in a Remix cookie session, validating it in loaders and actions.",
      },
    ],
  },
  {
    slug: "nuxt",
    name: "Nuxt",
    category: "Framework",
    title: "Basefyio + Nuxt: PostgreSQL Backend for Nuxt Apps",
    description:
      "Use Basefyio with Nuxt 3 for a PostgreSQL backend, auth, and storage. The basefyio-js SDK works in composables, server routes, and plugins.",
    intro:
      "Nuxt handles rendering and routing on top of Vue; Basefyio provides the backend — PostgreSQL, auth, and storage — through the basefyio-js SDK on both server and client.",
    install: INSTALL,
    setupTitle: "Create the client",
    setup: `// utils/basefyio.ts
import { createClient } from "basefyio-js";

const config = useRuntimeConfig();
export const kb = createClient({
  projectId: config.public.basefyioProjectId,
  apiKey: config.public.basefyioAnonKey,
});`,
    setupNote:
      "Expose the anon key via runtimeConfig.public for client use. For server routes that need elevated access, read a service key from the private runtimeConfig instead.",
    usageTitle: "Fetch data in a component",
    usage: `<script setup lang="ts">
import { kb } from "~/utils/basefyio";

const { data: posts } = await useAsyncData("posts", async () => {
  const { data } = await kb.from("posts").select("id, title");
  return data ?? [];
});
</script>`,
    benefits: [
      {
        title: "Server and client",
        body: "Use the SDK in composables, server routes (/server/api), and plugins with one setup.",
      },
      {
        title: "No backend boilerplate",
        body: "Query PostgreSQL directly instead of writing server routes for basic CRUD.",
      },
      {
        title: "Auth and storage included",
        body: "kb.auth and kb.storage cover sign-in and uploads out of the box.",
      },
    ],
    faqs: [
      {
        question: "Does Basefyio work with Nuxt 3 server routes?",
        answer:
          "Yes. Create a server-side client with a service key in /server/api routes for trusted operations, and a public client for the browser.",
      },
      {
        question: "Where do Basefyio keys go in Nuxt?",
        answer:
          "Public anon keys go in runtimeConfig.public; service keys go in the private runtimeConfig, accessed only in server routes.",
      },
    ],
  },
  {
    slug: "angular",
    name: "Angular",
    category: "Framework",
    title: "Basefyio + Angular: A Backend for Angular Apps",
    description:
      "Connect an Angular app to Basefyio for PostgreSQL data, auth, and storage via the basefyio-js SDK, wrapped in an injectable service.",
    intro:
      "Give your Angular app a backend without building one. Wrap the basefyio-js SDK in an injectable service and use it across components and resolvers.",
    install: INSTALL,
    setupTitle: "Create an injectable client",
    setup: `// src/app/basefyio.service.ts
import { Injectable } from "@angular/core";
import { createClient } from "basefyio-js";
import { environment } from "../environments/environment";

@Injectable({ providedIn: "root" })
export class Basefyio {
  client = createClient({
    projectId: environment.basefyioProjectId,
    apiKey: environment.basefyioAnonKey,
  });
}`,
    setupNote:
      "Put the anon key in environment.ts. Row-level security keeps it safe in the browser. Never ship a service key to an Angular bundle.",
    usageTitle: "Use the service in a component",
    usage: `import { Component, inject, signal } from "@angular/core";
import { Basefyio } from "./basefyio.service";

@Component({ selector: "app-posts", template: "..." })
export class PostsComponent {
  private kb = inject(Basefyio);
  posts = signal<any[]>([]);

  async ngOnInit() {
    const { data } = await this.kb.client.from("posts").select("id, title");
    this.posts.set(data ?? []);
  }
}`,
    benefits: [
      {
        title: "Dependency-injection friendly",
        body: "Expose the client through an injectable service and use it anywhere Angular DI reaches.",
      },
      {
        title: "Full backend included",
        body: "Database, auth, and storage from a single SDK — no separate services to wire.",
      },
      {
        title: "Secured by the database",
        body: "Row-level security makes the anon key safe to ship to the browser.",
      },
    ],
    faqs: [
      {
        question: "Is it safe to use Basefyio in an Angular app?",
        answer:
          "Yes, with the anon key and row-level security enabled. Policies run in the database, so users only access rows they're permitted to.",
      },
      {
        question: "How do I track the current user in Angular?",
        answer:
          "Expose kb.auth.getUser and kb.auth.onAuthStateChange from your service and store the user in a signal or RxJS subject.",
      },
    ],
  },
  {
    slug: "solidjs",
    name: "SolidJS",
    category: "Framework",
    title: "Basefyio + SolidJS: Backend for Solid Apps",
    description:
      "Use Basefyio with SolidJS for PostgreSQL data, auth, and storage. The basefyio-js SDK pairs cleanly with Solid resources and signals.",
    intro:
      "SolidJS gives you fine-grained reactivity; Basefyio gives it a backend. Load data with createResource and the basefyio-js SDK.",
    install: INSTALL,
    setupTitle: "Create the client",
    setup: `// src/basefyio.ts
import { createClient } from "basefyio-js";

export const kb = createClient({
  projectId: import.meta.env.VITE_BASEFYIO_PROJECT_ID,
  apiKey: import.meta.env.VITE_BASEFYIO_ANON_KEY,
});`,
    setupNote:
      "Use the anon key in the browser; row-level security enforces access at the database.",
    usageTitle: "Load data with a resource",
    usage: `import { createResource, For } from "solid-js";
import { kb } from "./basefyio";

export function Posts() {
  const [posts] = createResource(async () => {
    const { data } = await kb.from("posts").select("id, title");
    return data ?? [];
  });
  return <ul><For each={posts()}>{(p) => <li>{p.title}</li>}</For></ul>;
}`,
    benefits: [
      {
        title: "Works with resources",
        body: "createResource pairs naturally with async SDK calls for data fetching.",
      },
      {
        title: "Full backend included",
        body: "Database, auth, and storage in one SDK.",
      },
      {
        title: "Standard PostgreSQL",
        body: "Real SQL and row-level security, fully portable with pg_dump.",
      },
    ],
    faqs: [
      {
        question: "Does basefyio-js work with SolidStart?",
        answer:
          "Yes. SolidStart supports server and client code, and the SDK runs in both. Use the anon key on the client and a service key only in server functions.",
      },
      {
        question: "How do I handle auth in SolidJS?",
        answer:
          "Wrap kb.auth in a context or store, and use kb.auth.onAuthStateChange to keep the current user reactive.",
      },
    ],
  },
  {
    slug: "express",
    name: "Express",
    category: "Runtime",
    title: "Basefyio + Express: Backend Data Access in Node.js APIs",
    description:
      "Use Basefyio from an Express server for PostgreSQL queries, auth, and storage. Ideal for custom APIs, webhooks, and trusted server-side logic.",
    intro:
      "Running an Express API? Use basefyio-js server-side to read and write PostgreSQL data, with a service key for trusted operations that bypass row-level security.",
    install: INSTALL,
    setupTitle: "Create a server client",
    setup: `// basefyio.js
import { createClient } from "basefyio-js";

export const kb = createClient({
  projectId: process.env.BASEFYIO_PROJECT_ID,
  apiKey: process.env.BASEFYIO_SERVICE_KEY, // server-only
});`,
    setupNote:
      "Keep the service key on the server only. Use it for trusted operations; for anything reachable by the browser, use the anon key with row-level security.",
    usageTitle: "Use it in a route handler",
    usage: `import express from "express";
import { kb } from "./basefyio.js";

const app = express();

app.get("/api/posts", async (_req, res) => {
  const { data, error } = await kb.from("posts").select("id, title");
  if (error) return res.status(500).json({ error });
  res.json(data);
});

app.listen(3000);`,
    benefits: [
      {
        title: "Trusted server access",
        body: "Use a service key for operations that need to bypass row-level security.",
      },
      {
        title: "Add a custom API surface",
        body: "Expose your own endpoints with Express while Basefyio handles the data layer.",
      },
      {
        title: "Raw SQL available",
        body: "Use kb.sql for reports and complex queries beyond the query builder.",
      },
    ],
    faqs: [
      {
        question: "Can I build a custom REST API over Basefyio with Express?",
        answer:
          "Yes. Use Express for bespoke endpoints and business logic, and basefyio-js with a service key for data access.",
      },
      {
        question: "Should I use the anon or service key in Express?",
        answer:
          "Use the service key for trusted server operations. If you forward requests on behalf of end users, prefer the anon key so row-level security still applies.",
      },
    ],
  },
];

export function getIntegration(slug: string): Integration | undefined {
  return INTEGRATIONS.find((i) => i.slug === slug);
}

export function getIntegrationSlugs(): string[] {
  return INTEGRATIONS.map((i) => i.slug);
}
