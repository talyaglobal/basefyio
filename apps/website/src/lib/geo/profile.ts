/**
 * Kolaybase's GEO (Generative Engine Optimization) profile — the single source
 * of truth that feeds `/llms.txt`, `/llms-full.txt`, the FAQ section + schema,
 * and the JSON-LD product graph. Built from `@kolaybase/geo`.
 *
 * Write every `summary`/`answer`/`fact` so it stands alone: an answer engine
 * may quote one line of this with no surrounding context.
 */
import type { GeoProfile } from "@kolaybase/geo";

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
