import type { MetadataRoute } from "next";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { getAllPosts } from "@/lib/content/blog";
import { COMPARISONS } from "@/lib/content/comparisons";
import { USE_CASES } from "@/lib/content/use-cases";
import { GLOSSARY } from "@/lib/content/glossary";
import { GUIDES } from "@/lib/content/guides";
import { INTEGRATIONS } from "@/lib/content/integrations";
import { DOCS_NAV_ITEMS } from "@/app/docs/docs-nav-items";
import {
  ABOUT_UPDATED,
  GUIDE_STARTUP_BACKEND_UPDATED,
  HOME_UPDATED,
} from "@/lib/seo/dates";
import { docsUrl, statusUrl } from "@/lib/public-hosts";

/**
 * Auto-discovering sitemap. Only the standalone pages are listed explicitly;
 * docs, blog, comparison, use-case, glossary, and integration URLs are pulled
 * from their registries, so adding content never requires touching this file.
 * /cli-connect is deliberately absent — robots.txt disallows it.
 */
/** Newest "Last updated" among the hand-reviewed comparisons, if any. */
function latestComparisonDate(): Date | undefined {
  const dates = COMPARISONS.flatMap((c) => (c.lastUpdated ? [c.lastUpdated] : []));
  return dates.length ? new Date(dates.sort().at(-1) as string) : undefined;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}`, lastModified: new Date(HOME_UPDATED), changeFrequency: "weekly", priority: 1 },
    { url: `${base}/blog`, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/compare`, lastModified: latestComparisonDate(), changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/guides/best-backend-database-for-startups`, lastModified: new Date(GUIDE_STARTUP_BACKEND_UPDATED), changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/guides`, lastModified: new Date(GUIDES.map((g) => g.updated).sort().at(-1) as string), changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/about`, lastModified: new Date(ABOUT_UPDATED), changeFrequency: "monthly", priority: 0.6 },
    { url: `${base}/use-cases`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/learn`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/integrations`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/feed.xml`, changeFrequency: "daily", priority: 0.4 },
    { url: `${base}/llms.txt`, changeFrequency: "weekly", priority: 0.4 },
    { url: `${base}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/terms`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${base}/kvkk`, changeFrequency: "yearly", priority: 0.3 },
    { url: statusUrl(), changeFrequency: "hourly", priority: 0.5 },
  ];

  // Every docs page, straight from the nav registry the sidebar and docs
  // search already read — a new docs page appears here on its own.
  const docs: MetadataRoute.Sitemap = DOCS_NAV_ITEMS.map((item) => ({
    url: docsUrl(item.href),
    changeFrequency: "monthly",
    priority: item.href === "/docs" ? 0.8 : 0.7,
  }));

  const posts: MetadataRoute.Sitemap = getAllPosts().map((post) => ({
    url: `${base}/blog/${post.slug}`,
    lastModified: new Date(post.updated ?? post.date),
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const comparisons: MetadataRoute.Sitemap = COMPARISONS.map((c) => ({
    url: `${base}/compare/${c.slug}`,
    ...(c.lastUpdated ? { lastModified: new Date(c.lastUpdated) } : {}),
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const guides: MetadataRoute.Sitemap = GUIDES.map((g) => ({
    url: `${base}/guides/${g.slug}`,
    lastModified: new Date(g.updated),
    changeFrequency: "monthly",
    priority: 0.8,
  }));

  const useCases: MetadataRoute.Sitemap = USE_CASES.map((u) => ({
    url: `${base}/use-cases/${u.slug}`,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const glossary: MetadataRoute.Sitemap = GLOSSARY.map((t) => ({
    url: `${base}/learn/${t.slug}`,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  const integrations: MetadataRoute.Sitemap = INTEGRATIONS.map((i) => ({
    url: `${base}/integrations/${i.slug}`,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [
    ...staticRoutes,
    ...docs,
    ...posts,
    ...comparisons,
    ...guides,
    ...useCases,
    ...glossary,
    ...integrations,
  ];
}
