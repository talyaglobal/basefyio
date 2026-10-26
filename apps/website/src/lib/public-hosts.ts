/**
 * Where the public surfaces live. The marketing site is the apex; the docs
 * and the status page each have a host of their own in production
 * (docs.<apex>, status.<apex>) and sit under /docs and /status in development,
 * where there is only localhost. Everything here is pure (no request, no
 * next/headers) so client components can import it too.
 */

/** Public production origin (no trailing slash). */
export const PRODUCTION_SITE_URL = "https://basefyio.com";

/**
 * Build-time / env-based URL for `metadataBase`, JSON-LD, and fallbacks.
 * Set `NEXT_PUBLIC_SITE_URL` for Docker/CI so OG URLs match your deploy.
 * In production builds, if unset, defaults to {@link PRODUCTION_SITE_URL} — never localhost.
 */
export function getSiteUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  if (process.env.VERCEL_URL) {
    const host = process.env.VERCEL_URL.replace(/^https?:\/\//, "");
    return `https://${host}`;
  }

  if (process.env.NODE_ENV !== "production") {
    return "http://localhost:3002";
  }

  return PRODUCTION_SITE_URL;
}

export function isLocalHostname(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
    );
  } catch {
    return /localhost|127\.0\.0\.1|\[::1\]/i.test(host);
  }
}

/** The apex host of a public host: `docs.basefyio.com` → `basefyio.com`, `www.` dropped too. */
export function apexOf(host: string): string {
  return host.replace(/^(docs|status|www)\./, "");
}

/** `https://<sub>.<apex>` for the configured site, or null when the site runs on localhost. */
function subdomainOrigin(sub: "docs" | "status"): string | null {
  let url: URL;
  try {
    url = new URL(getSiteUrl());
  } catch {
    return null;
  }
  if (isLocalHostname(url.host)) return null;
  return `${url.protocol}//${sub}.${apexOf(url.hostname)}`;
}

/** The docs origin (no trailing slash), or null when the docs are served under /docs on the apex. Override with NEXT_PUBLIC_DOCS_URL. */
export function getDocsOrigin(): string | null {
  const fromEnv = process.env.NEXT_PUBLIC_DOCS_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return subdomainOrigin("docs");
}

/** The status page origin (no trailing slash), or null when it is served under /status on the apex. Override with NEXT_PUBLIC_STATUS_URL. */
export function getStatusOrigin(): string | null {
  const fromEnv = process.env.NEXT_PUBLIC_STATUS_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return subdomainOrigin("status");
}

/** `/docs/api` → `/api`, `/docs` → `/`, `/docs#x` → `/#x`. Paths without the prefix are returned as they are. */
export function stripDocsPrefix(path: string): string {
  if (path === "/docs") return "/";
  if (path.startsWith("/docs/")) return path.slice("/docs".length);
  if (path.startsWith("/docs#") || path.startsWith("/docs?")) return "/" + path.slice("/docs".length);
  return path;
}

/** Absolute address of a docs page, given its apex path (`/docs/api`). For links from any other page or host. */
export function docsUrl(path = "/docs"): string {
  const origin = getDocsOrigin();
  return origin ? `${origin}${stripDocsPrefix(path)}` : `${getSiteUrl()}${path}`;
}

/** Relative address of a docs page for links rendered inside the docs themselves (client-side navigation stays on the docs host). */
export function docsPath(path = "/docs"): string {
  return getDocsOrigin() ? stripDocsPrefix(path) : path;
}

/** The pathname a docs page has in the app router (`/docs/api`), from what the browser shows (`/api` on the docs host, `/docs/api` on the apex). */
export function normalizeDocsPathname(pathname: string): string {
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return pathname;
  return pathname === "/" ? "/docs" : `/docs${pathname}`;
}

/** Absolute address of the status page. */
export function statusUrl(): string {
  const origin = getStatusOrigin();
  return origin ? `${origin}/` : `${getSiteUrl()}/status`;
}
