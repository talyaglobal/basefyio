import type { Metadata } from "next";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { SITE } from "./site";
import { RSS_ALTERNATE } from "@/lib/absolute-site-metadata";

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

/** The layout's title template: "%s | basefyio". */
const BRAND_SUFFIX = ` | ${SITE.name}`;
/** Search engines cut titles around 60 characters and descriptions around 160. */
export const MAX_TITLE = 60;
export const MAX_DESCRIPTION = 160;

/**
 * The document title for a page title, kept within {@link MAX_TITLE}.
 *
 * Normally the layout appends " | basefyio". A title that already names the
 * brand does not need it, so a long one is served without the suffix; one that
 * is still too long is cut at its last " — " or ": " separator that fits.
 */
export function fitTitle(title: string): string | { absolute: string } {
  if (title.length + BRAND_SUFFIX.length <= MAX_TITLE) return title;
  const named = title.toLowerCase().includes(SITE.name);
  if (named && title.length <= MAX_TITLE) return { absolute: title };
  const budget = named ? MAX_TITLE : MAX_TITLE - BRAND_SUFFIX.length;
  let cut = -1;
  for (const sep of [" — ", ": ", " - ", "? "]) {
    // A question keeps its question mark: "What is X? Definition" → "What is X?".
    const keep = sep === "? " ? 1 : 0;
    for (let i = title.indexOf(sep); i > 0; i = title.indexOf(sep, i + 1)) {
      if (i + keep <= budget && i + keep > cut) cut = i + keep;
    }
  }
  if (cut <= 0) return title;
  const short = title.slice(0, cut);
  return named ? { absolute: short } : short;
}

/** A description within {@link MAX_DESCRIPTION}: whole sentences when they fit, else words and an ellipsis. */
export function fitDescription(description: string): string {
  if (description.length <= MAX_DESCRIPTION) return description;
  const head = description.slice(0, MAX_DESCRIPTION);
  const sentence = head.lastIndexOf(". ");
  if (sentence >= 100) return head.slice(0, sentence + 1);
  const word = head.slice(0, MAX_DESCRIPTION - 1).lastIndexOf(" ");
  return `${head.slice(0, word > 0 ? word : MAX_DESCRIPTION - 1).replace(/[\s,;:—-]+$/, "")}…`;
}

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
  const description = fitDescription(input.description ?? SITE.defaultDescription);

  return {
    // undefined → the layout default title is used
    title: input.title === undefined ? undefined : fitTitle(input.title),
    description,
    keywords: input.keywords
      ? [...SITE.keywords, ...input.keywords]
      : undefined,
    // A page-level `alternates` replaces the layout one, so the feed link is repeated here.
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
