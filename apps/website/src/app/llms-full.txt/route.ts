import { generateLlmsFullTxt } from "@basefyio/geo";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { createGeoProfile } from "@/lib/geo/profile";

/**
 * /llms-full.txt — the llms.txt map plus the inlined, answer-bearing content
 * (FAQs and how-tos) so an engine can quote basefyio verbatim without a second
 * fetch. Built from the shared GEO profile via @basefyio/geo.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const siteUrl = await getSiteUrlFromRequest();
  const body = generateLlmsFullTxt(createGeoProfile(siteUrl));

  return new Response(body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
