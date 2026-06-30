import type { Metadata } from "next";
import { getSiteUrlFromRequest } from "@/lib/site-url";

/**
 * Resolves `alternates.canonical` and `openGraph.url` to the real request origin
 * (e.g. https://basefyio.com vs http://localhost:3002).
 *
 * Kept for the existing static pages (home, docs). New content pages should
 * prefer {@link import("./seo/metadata").buildMetadata} which produces the full
 * SEO surface from a single input.
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
