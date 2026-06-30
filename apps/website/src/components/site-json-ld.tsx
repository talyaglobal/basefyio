import { getSiteUrlFromRequest } from "@/lib/site-url";
import { siteGraph } from "@/lib/seo/json-ld";
import { JsonLd } from "@/components/seo/json-ld";

/**
 * Organization, WebSite, and SoftwareApplication structured data injected on
 * every page via the root layout (brand + product signals for search engines).
 */
export async function SiteJsonLd() {
  const url = await getSiteUrlFromRequest();
  return <JsonLd data={siteGraph(url)} />;
}
