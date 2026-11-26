import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { itemListSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { GUIDES, STATIC_GUIDES } from "@/lib/content/guides";

const TITLE = "basefyio guides";
const DESCRIPTION =
  "Guides to choosing and running a backend: self-hosting, a database per project, recovery, realtime, AI search, security and moving from Supabase.";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({ path: "/guides", title: TITLE, description: DESCRIPTION });
}

export default async function GuidesIndex() {
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const all = [...STATIC_GUIDES, ...GUIDES];

  return (
    <SiteShell>
      <JsonLd
        data={itemListSchema(
          "basefyio guides",
          all.map((g) => ({ name: g.title, url: `${base}/guides/${g.slug}`, description: g.description })),
        )}
      />
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight">{TITLE}</h1>
          <p className="mt-3 text-lg text-muted-foreground">{DESCRIPTION}</p>
        </header>
        <div className="grid gap-6 sm:grid-cols-2">
          {all.map((g) => (
            <Link
              key={g.slug}
              href={`/guides/${g.slug}`}
              className="rounded-xl border border-border p-6 transition-colors hover:border-primary/50 hover:bg-accent/40"
            >
              <h2 className="text-xl font-semibold tracking-tight">{g.title}</h2>
              <p className="mt-2 text-sm text-muted-foreground">{g.description}</p>
            </Link>
          ))}
        </div>
      </div>
    </SiteShell>
  );
}
