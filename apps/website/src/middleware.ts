import { NextResponse, type NextRequest } from "next/server";
import { DOCS_NAV_ITEMS } from "@/app/docs/docs-nav-items";
import { apexOf, isLocalHostname } from "@/lib/public-hosts";

/**
 * One Next.js app, three public hosts. The apex is the marketing site; the
 * docs answer on docs.<apex> and the status page on status.<apex>, each
 * served from the same build by rewriting the path (the address bar keeps
 * the short form). The old apex addresses forward permanently, so links and
 * search results that still carry /docs or /status keep working. Localhost
 * and plain IPs are left alone: there the docs stay under /docs.
 *
 * Files, Next internals and the website's own API routes are excluded by the
 * matcher — /api/docs-nav is served on every host, /api (exact) is the API
 * reference page on the docs host.
 */
export const config = {
  matcher: ["/((?!_next/|api/|.*\..*).*)"],
};

/** Sections the docs host knows: "/data-engine", "/api", …; anything else forwards to the apex. */
const DOCS_SECTIONS = DOCS_NAV_ITEMS.map((i) => i.href.replace(/^\/docs/, "")).filter(Boolean);

function requestHost(req: NextRequest): string {
  const raw = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return raw.split(",")[0].trim().toLowerCase().replace(/:\d+$/, "");
}

export function middleware(req: NextRequest) {
  const host = requestHost(req);
  if (!host || isLocalHostname(host)) return NextResponse.next();
  const { pathname, search } = req.nextUrl;

  if (host.startsWith("docs.")) {
    const apex = apexOf(host);
    if (pathname === "/docs" || pathname.startsWith("/docs/")) {
      return NextResponse.redirect(new URL((pathname.slice("/docs".length) || "/") + search, `https://${host}`), 308);
    }
    const known = pathname === "/" || DOCS_SECTIONS.some((s) => pathname === s || pathname.startsWith(`${s}/`));
    if (!known) return NextResponse.redirect(new URL(pathname + search, `https://${apex}`), 308);
    const url = req.nextUrl.clone();
    url.pathname = pathname === "/" ? "/docs" : `/docs${pathname}`;
    const res = NextResponse.rewrite(url);
    res.headers.set("Link", `<https://${host}${pathname}>; rel="canonical"`);
    return res;
  }

  if (host.startsWith("status.")) {
    const apex = apexOf(host);
    if (pathname === "/") {
      const url = req.nextUrl.clone();
      url.pathname = "/status";
      return NextResponse.rewrite(url);
    }
    if (pathname === "/status") return NextResponse.redirect(new URL("/" + search, `https://${host}`), 308);
    return NextResponse.redirect(new URL(pathname + search, `https://${apex}`), 308);
  }

  // The apex: the docs and the status page moved to hosts of their own.
  const apex = apexOf(host);
  if (pathname === "/docs" || pathname.startsWith("/docs/")) {
    return NextResponse.redirect(new URL((pathname.slice("/docs".length) || "/") + search, `https://docs.${apex}`), 308);
  }
  if (pathname === "/status") {
    return NextResponse.redirect(new URL("/" + search, `https://status.${apex}`), 308);
  }
  return NextResponse.next();
}
