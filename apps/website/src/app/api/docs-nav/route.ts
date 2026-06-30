import { NextResponse } from "next/server";
import { DOCS_NAV_ITEMS } from "@/app/docs/docs-nav-items";

// Published so the dashboard's Docs menu mirrors the docs sidebar automatically.
// CORS-open: the dashboard (app.basefyio.com) fetches this from basefyio.com.
export const dynamic = "force-static";

export function GET() {
  return NextResponse.json(
    { items: DOCS_NAV_ITEMS.map(({ href, label, icon }) => ({ href, label, icon })) },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=300, s-maxage=300",
      },
    },
  );
}
