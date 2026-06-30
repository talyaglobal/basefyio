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
    "basefyio — Backend-as-a-Service & REST API for Developers",
  defaultDescription:
    "basefyio: hosted database, auth, storage, and auto REST API for developers. SDK, CLI, powerful query syntax. Ship backends in minutes.",
  /** Path (relative to site root) of the default social share image. */
  defaultOgImage: "/og-image.png",
  keywords: [
    "basefyio",
    "backend as a service",
    "BaaS",
    "developer backend",
    "Database API",
    "REST API",
    "JavaScript SDK",
    "TypeScript SDK",
    "authentication API",
    "hosted database",
    "REST API",
    "hosted database",
    "no-code backend",
    "CLI database",
  ],
} as const;

/** Default author shown on blog posts that omit an explicit author. */
export const DEFAULT_AUTHOR = "basefyio Team";
