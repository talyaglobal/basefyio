import type { MetadataRoute } from "next";
import { getSiteUrlFromRequest } from "@/lib/site-url";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = await getSiteUrlFromRequest();
  const now = new Date();

  const routes = [
    "",
    "/docs",
    "/docs/api",
    "/docs/sdk",
    "/docs/cli",
  ] as const;

  return routes.map((path) => ({
    url: `${base}${path}`,
    lastModified: now,
    changeFrequency: path === "" ? "weekly" : "monthly",
    priority: path === "" ? 1 : 0.8,
  }));
}
