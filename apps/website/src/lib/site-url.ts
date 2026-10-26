import { headers } from "next/headers";

import { apexOf, getSiteUrl, isLocalHostname, PRODUCTION_SITE_URL } from "./public-hosts";

export { getSiteUrl, PRODUCTION_SITE_URL };
export { docsUrl, docsPath, statusUrl, getDocsOrigin, getStatusOrigin } from "./public-hosts";

/** Admin app / dashboard (no trailing slash). Override with `NEXT_PUBLIC_APP_URL`. */
export const PRODUCTION_APP_URL = "https://app.basefyio.com";

/** Public REST API origin (no trailing slash). Override with `NEXT_PUBLIC_API_BASE_URL` or `NEXT_PUBLIC_API_URL`. */
export const PRODUCTION_API_URL = "https://api.basefyio.com";

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
    // docs.<apex> and status.<apex> are served from this app too; their
    // canonical base (sitemap, robots, metadataBase) is still the apex.
    return `${proto}://${apexOf(hostHeader.replace(/:\d+$/, ""))}`.replace(/\/$/, "");
  }

  return getSiteUrl();
}
