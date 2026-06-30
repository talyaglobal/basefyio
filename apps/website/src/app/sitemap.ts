import type { MetadataRoute } from "next";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { getAllPosts } from "@/lib/content/blog";
import { COMPARISONS } from "@/lib/content/comparisons";
import { USE_CASES } from "@/lib/content/use-cases";
import { GLOSSARY } from "@/lib/content/glossary";
import { INTEGRATIONS } from "@/lib/content/integrations";

/**
 * Auto-discovering sitemap. Static routes are listed explicitly; blog,
 * comparison, use-case, glossary, and integration URLs are pulled from their
 * content registries, so adding content never requires touching this file.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const now = new Date();

  const staticRoutes: MetadataRoute.Sitemap = [
    { url: `${base}`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${base}/blog`, lastModified: now, changeFrequency: "daily", priority: 0.9 },
    { url: `${base}/compare`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/use-cases`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/learn`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/integrations`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${base}/docs`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${base}/docs/api`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/docs/sdk`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${base}/docs/cli`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
  ];

  const posts: MetadataRoute.Sitemap = getAllPosts().map((post) => ({
    url: `${base}/blog/${post.slug}`,
    lastModified: new Date(post.updated ?? post.date),
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const comparisons: MetadataRoute.Sitemap = COMPARISONS.map((c) => ({
    url: `${base}/compare/${c.slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const useCases: MetadataRoute.Sitemap = USE_CASES.map((u) => ({
    url: `${base}/use-cases/${u.slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  const glossary: MetadataRoute.Sitemap = GLOSSARY.map((t) => ({
    url: `${base}/learn/${t.slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.6,
  }));

  const integrations: MetadataRoute.Sitemap = INTEGRATIONS.map((i) => ({
    url: `${base}/integrations/${i.slug}`,
    lastModified: now,
    changeFrequency: "monthly",
    priority: 0.7,
  }));

  return [
    ...staticRoutes,
    ...posts,
    ...comparisons,
    ...useCases,
    ...glossary,
    ...integrations,
  ];
}
