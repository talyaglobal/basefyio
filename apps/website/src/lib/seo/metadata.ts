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

/** Search results show about 60 title and 160 description characters; the rest is cut off. */
const TITLE_MAX = 49; // the layout template adds " | basefyio"
const DESCRIPTION_MAX = 160;

/** Cut a long title at its first separator ("X vs. Y: subtitle" → "X vs. Y"). */
export function clampTitle(title: string): string {
  if (title.length <= TITLE_MAX) return title;
  const head = title.split(/:| — | – /)[0].trim();
  return head.length >= 15 && head.length <= TITLE_MAX ? head : title;
}

export function clampDescription(text: string): string {
  if (text.length <= DESCRIPTION_MAX) return text;
  const cut = text.slice(0, DESCRIPTION_MAX - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ")).replace(/[s,;:.-]+$/, "")}…`;
}

/** The blog feed, advertised on every page (a page-level `alternates` replaces the layout one). */
export const RSS_ALTERNATE = { "application/rss+xml": [{ url: "/feed.xml", title: "basefyio Blog" }] };

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
  const description = clampDescription(input.description ?? SITE.defaultDescription);

  return {
    title: input.title && clampTitle(input.title), // undefined → layout default title is used
    description,
    keywords: input.keywords
      ? [...SITE.keywords, ...input.keywords]
      : undefined,
    alternates: { canonical: url, types: RSS_ALTERNATE },
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
