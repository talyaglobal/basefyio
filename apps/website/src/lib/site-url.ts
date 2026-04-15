import { headers } from "next/headers";

/** Public production origin (no trailing slash). */
export const PRODUCTION_SITE_URL = "https://kolaybase.com";

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

function isLocalHostname(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    );
  } catch {
    return /localhost|127\.0\.0\.1|\[::1\]/i.test(host);
  }
}

/** Admin app / dashboard (no trailing slash). Override with `NEXT_PUBLIC_APP_URL`. */
export const PRODUCTION_APP_URL = "https://app.kolaybase.com";

/** Public REST API origin (no trailing slash). Override with `NEXT_PUBLIC_API_BASE_URL` or `NEXT_PUBLIC_API_URL`. */
export const PRODUCTION_API_URL = "https://api.kolaybase.com";

export function getAppPortalUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return PRODUCTION_APP_URL;
}

export function getAppSignupUrl(): string {
  return `${getAppPortalUrl()}/signup`;
}

export function getPublicApiUrl(): string {
  const fromEnv =
    process.env.NEXT_PUBLIC_API_BASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_API_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  return PRODUCTION_API_URL;
}

/** Server-side billing plans fetch (deduped). Uses env + Docker service + local API defaults. */
export function getBillingPlansFetchEndpoints(): string[] {
  const bases = new Set<string>();
  const add = (u?: string | null) => {
    const t = u?.trim();
    if (t) bases.add(t.replace(/\/$/, ""));
  };
  add(process.env.NEXT_PUBLIC_BILLING_API_URL);
  add(process.env.NEXT_PUBLIC_API_BASE_URL);
  add(process.env.NEXT_PUBLIC_APP_URL);
  add(PRODUCTION_APP_URL);
  add("http://platform-api:4000");
  add("http://localhost:4000");

  const urls = new Set<string>();
  for (const b of Array.from(bases)) {
    urls.add(`${b}/api/billing/plans`);
    urls.add(`${b}/billing/plans`);
  }
  urls.add(`${getAppPortalUrl()}/api/proxy/billing/plans`);
  return Array.from(urls);
}

/**
 * Same origin as the current HTTP request (Host / X-Forwarded-*).
 * Use for sitemap, robots, `metadataBase`, JSON-LD, and absolute canonical / Open Graph URLs.
 */
export async function getSiteUrlFromRequest(): Promise<string> {
  const h = await headers();
  const forwardedHost = h.get("x-forwarded-host")?.split(",")[0]?.trim();
  const hostHeader = forwardedHost || h.get("host")?.trim();

  if (hostHeader) {
    if (isLocalHostname(hostHeader)) {
      return `http://${hostHeader}`.replace(/\/$/, "");
    }

    const rawProto = h.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const proto =
      rawProto === "http" || rawProto === "https" ? rawProto : "https";
    return `${proto}://${hostHeader}`.replace(/\/$/, "");
  }

  return getSiteUrl();
}
