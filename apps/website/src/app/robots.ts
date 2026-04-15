import type { MetadataRoute } from "next";
import { getSiteUrlFromRequest } from "@/lib/site-url";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = await getSiteUrlFromRequest();

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/cli-connect"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
