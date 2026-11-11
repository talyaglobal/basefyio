import type { Metadata } from "next";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { clampDescription, RSS_ALTERNATE } from "./seo/metadata";
import { SITE } from "./seo/site";

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

  // A page-level openGraph replaces the layout's whole object, so type and image are set here too.
  const image = `${base}${SITE.defaultOgImage}`;
  return {
    ...meta,
    description: typeof meta.description === "string" ? clampDescription(meta.description) : meta.description,
    alternates: {
      types: RSS_ALTERNATE,
      ...meta.alternates,
      canonical: absolute,
    },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      images: [{ url: image }],
      ...meta.openGraph,
      url: absolute,
    },
    twitter: {
      card: "summary_large_image",
      images: [image],
      ...meta.twitter,
    },
  };
}
