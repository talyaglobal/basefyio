import { PRODUCTION_APP_URL, getAppPortalUrl } from "@/lib/site-url";

/**
 * Where the server-rendered status page reads the public status JSON from,
 * in the order to try: the configured API origin, the Docker service name
 * (the website and the API share a network), a local API, and finally the
 * dashboard's proxy. The first answer wins.
 */
export function getStatusFetchEndpoints(path = "public"): string[] {
  const bases = new Set<string>();
  const add = (u?: string | null) => {
    const t = u?.trim();
    if (t) bases.add(t.replace(/\/$/, ""));
  };
  add(process.env.NEXT_PUBLIC_API_BASE_URL);
  add(process.env.NEXT_PUBLIC_API_URL);
  add("http://platform-api:4000");
  add("http://localhost:4000");

  const urls = new Set<string>();
  for (const b of Array.from(bases)) urls.add(`${b}/api/platform-status/${path}`);
  urls.add(`${getAppPortalUrl()}/api/proxy/platform-status/${path}`);
  urls.add(`${PRODUCTION_APP_URL}/api/proxy/platform-status/${path}`);
  return Array.from(urls);
}
