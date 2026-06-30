import type { Metadata } from "next";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { SITE } from "./site";

export type BuildMetadataInput = {
  /** Absolute path on this site, e.g. "/blog/my-post". Used for canonical + OG url. */
  path: string;
  /** Page title without the brand suffix; the layout template adds " | basefyio". */
  title?: string;
  description?: string;
  /** Extra keywords merged on top of the site defaults. */
  keywords?: string[];
  /** Path or absolute URL of the share image. Defaults to the site OG image. */
  image?: string;
  /** "website" (default) or "article". */
  type?: "website" | "article";
  /** Hide from search engines (e.g. utility pages). */
  noindex?: boolean;
  /** ISO date — only for type "article". */
  publishedTime?: string;
  modifiedTime?: string;
  authors?: string[];
};

function toAbsolute(base: string, value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  return `${base}${value.startsWith("/") ? "" : "/"}${value}`;
}

/**
 * Central factory that produces a complete Next `Metadata` object for any page:
 * canonical, Open Graph, Twitter, keywords, and robots — all resolved against
 * the real request origin so URLs are correct on localhost, Docker, and prod.
 *
 * Every content page (blog, comparisons, use-cases) goes through here so the SEO
 * surface stays consistent. Page-level `<JsonLd />` is added separately.
 */
export async function buildMetadata(
  input: BuildMetadataInput,
): Promise<Metadata> {
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const path = input.path.startsWith("/") ? input.path : `/${input.path}`;
  const url = `${base}${path}`;
  const image = toAbsolute(base, input.image ?? SITE.defaultOgImage);

  const title = input.title ?? SITE.defaultTitle;
  const description = input.description ?? SITE.defaultDescription;

  return {
    title: input.title, // undefined → layout default title is used
    description,
    keywords: input.keywords
      ? [...SITE.keywords, ...input.keywords]
      : undefined,
    alternates: { canonical: url },
    openGraph: {
      type: input.type ?? "website",
      url,
      title,
      description,
      siteName: SITE.name,
      locale: SITE.locale,
      images: [{ url: image }],
      ...(input.type === "article"
        ? {
            publishedTime: input.publishedTime,
            modifiedTime: input.modifiedTime ?? input.publishedTime,
            authors: input.authors,
          }
        : {}),
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
    ...(input.noindex
      ? { robots: { index: false, follow: false } }
      : {}),
  };
}
