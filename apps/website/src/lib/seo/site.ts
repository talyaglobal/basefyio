/**
 * Single source of truth for site-wide SEO defaults.
 *
 * Everything that needs the brand name, default copy, social handles, or the
 * canonical keyword set should import from here so metadata, JSON-LD, RSS, and
 * the sitemap never drift out of sync.
 */
export const SITE = {
  name: "basefyio",
  /** Used by RSS <copyright> and JSON-LD publisher. */
  legalName: "basefyio",
  locale: "en_US",
  /** BCP-47 language tag for HTML lang / JSON-LD inLanguage. */
  lang: "en",
  twitter: "@basefyio",
  defaultTitle:
    "basefyio — PostgreSQL BaaS & REST API for Developers",
  defaultDescription:
    "basefyio: hosted PostgreSQL, auth, storage, and auto REST API for developers. SDK, CLI, PostgREST-style queries. Ship backends in minutes.",
  /** Path (relative to site root) of the default social share image. */
  defaultOgImage: "/og-image.png",
  keywords: [
    "basefyio",
    "backend as a service",
    "BaaS",
    "developer backend",
    "PostgreSQL API",
    "REST API",
    "JavaScript SDK",
    "TypeScript SDK",
    "authentication API",
    "hosted postgres",
    "PostgREST compatible",
    "hosted PostgreSQL",
    "no-code backend",
    "CLI database",
  ],
} as const;

/** Default author shown on blog posts that omit an explicit author. */
export const DEFAULT_AUTHOR = "basefyio Team";
