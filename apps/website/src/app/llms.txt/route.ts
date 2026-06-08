import { generateLlmsTxt } from "@basefyio/geo";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { createGeoProfile } from "@/lib/geo/profile";

/**
 * /llms.txt — the curated, LLM-facing map of the site (see llmstxt.org).
 * Generative engines fetch this first to learn what Basefyio is and which
 * pages to read. Built from the shared GEO profile via @basefyio/geo.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const siteUrl = await getSiteUrlFromRequest();
  const body = generateLlmsTxt(createGeoProfile(siteUrl));

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
