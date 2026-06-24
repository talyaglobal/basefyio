// Single source of truth for the docs navigation. The website sidebar
// (docs-nav.tsx) and the docs search both read this, and it is published at
// /api/docs-nav so the dashboard's Docs menu mirrors it automatically — add a
// page here and it appears in every docs surface.

export interface DocsNavItem {
  href: string;
  label: string;
  /** Stable icon key; each surface maps it to its own icon set. */
  icon: string;
  /** Extra terms the docs search should match for this page. */
  keywords?: string[];
}

export const DOCS_NAV_ITEMS: DocsNavItem[] = [
  { href: "/docs", label: "Overview", icon: "book", keywords: ["getting started", "intro", "quickstart"] },
  { href: "/docs/data-engine", label: "Data Engine", icon: "database", keywords: ["nosql", "documents", "collections", "json", "tables", "sql"] },
  { href: "/docs/connect", label: "Connect", icon: "link", keywords: ["database url", "postgres", "psql", "pgadmin", "dbeaver", "connection string", "direct"] },
  { href: "/docs/realtime", label: "Realtime", icon: "radio", keywords: ["subscribe", "live", "events", "insert", "update", "delete", "websocket", "sse"] },
  { href: "/docs/auth", label: "Authentication", icon: "key", keywords: ["signup", "signin", "login", "password", "oauth", "google", "github", "magic link", "verify email", "reset password", "users", "session"] },
  { href: "/docs/api", label: "API Reference", icon: "server", keywords: ["rest", "endpoints", "http", "rpc", "query"] },
  { href: "/docs/sdk", label: "SDK", icon: "code", keywords: ["javascript", "typescript", "client", "bf.from", "auth", "storage"] },
  { href: "/docs/cli", label: "CLI", icon: "terminal", keywords: ["command line", "bf", "basefyio init", "link", "migrate", "login"] },
  { href: "/docs/security", label: "Security & RLS", icon: "shield", keywords: ["row level security", "policies", "auth", "permissions", "rls", "api keys"] },
  { href: "/docs/self-hosting", label: "Self-Hosting", icon: "cloud", keywords: ["docker", "compose", "deploy", "self host", "on premise"] },
];
