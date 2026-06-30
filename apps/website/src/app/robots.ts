import type { MetadataRoute } from "next";
import { aiCrawlerRules } from "@basefyio/geo";
import { getSiteUrlFromRequest } from "@/lib/site-url";

/**
 * robots.txt with an explicit Generative Engine Optimization (GEO) policy.
 *
 * Beyond the wildcard rule, we name each AI crawler (GPTBot, OAI-SearchBot,
 * ClaudeBot, PerplexityBot, Google-Extended, …) and allow it — stating intent
 * so basefyio shows up in AI answers, and keeping the policy explicit if the
 * wildcard rule is ever tightened. Generated from @basefyio/geo.
 */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = await getSiteUrlFromRequest();

  const aiRules = aiCrawlerRules({ disallow: ["/cli-connect"] }).map((rule) => ({
    userAgent: rule.userAgent,
    ...(rule.allow ? { allow: rule.allow } : {}),
    ...(rule.disallow ? { disallow: rule.disallow } : {}),
  }));

  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/cli-connect"],
      },
      ...aiRules,
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
