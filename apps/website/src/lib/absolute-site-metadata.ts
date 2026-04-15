import type { Metadata } from "next";
import { getSiteUrlFromRequest } from "@/lib/site-url";

/**
 * Resolves `alternates.canonical` and `openGraph.url` to the real request origin
 * (e.g. https://kolaybase.com vs http://localhost:3002).
 */
export async function withAbsoluteSiteUrls(
  pathname: string,
  meta: Metadata,
): Promise<Metadata> {
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const absolute = `${base}${path}`;

  return {
    ...meta,
    alternates: {
      ...meta.alternates,
      canonical: absolute,
    },
    openGraph: {
      ...meta.openGraph,
      url: absolute,
    },
  };
}
