import type { Metadata } from "next";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { SITE } from "@/lib/seo/site";

/** The blog feed, advertised on every page as `<link rel="alternate" type="application/rss+xml">`. */
export const RSS_ALTERNATE = {
  "application/rss+xml": [{ url: "/feed.xml", title: "basefyio Blog" }],
};

/**
 * Resolves `alternates.canonical` and `openGraph.url` to the real request origin
 * (e.g. https://basefyio.com vs http://localhost:3002).
 *
 * Next replaces a layout's `openGraph`, `twitter` and `alternates` wholesale
 * when a page sets its own, so whatever a page leaves out is filled in here:
 * the Open Graph type, site name and share image, and the RSS alternate link.
 * Without that the home page lost its og:type and the docs pages shipped no
 * og:image or feed link at all.
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
  const og = meta.openGraph ?? {};

  return {
    ...meta,
    alternates: {
      types: RSS_ALTERNATE,
      ...meta.alternates,
      canonical: absolute,
    },
    openGraph: {
      type: "website",
      siteName: SITE.name,
      locale: SITE.locale,
      ...og,
      images: og.images ?? [{ url: SITE.defaultOgImage }],
      url: absolute,
    },
    twitter: meta.twitter ?? {
      card: "summary_large_image",
      title: typeof og.title === "string" ? og.title : undefined,
      description: og.description ?? meta.description ?? undefined,
      images: [SITE.defaultOgImage],
    },
  };
}
