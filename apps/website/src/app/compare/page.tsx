import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, GitCompare } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { itemListSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { COMPARISONS } from "@/lib/content/comparisons";

const TITLE = "Compare Kolaybase";
const DESCRIPTION =
  "Honest comparisons of Kolaybase with other backend platforms — Supabase, Firebase, and more. See how the PostgreSQL backend stacks up on isolation, queries, and lock-in.";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    path: "/compare",
    title: TITLE,
    description: DESCRIPTION,
    keywords: COMPARISONS.map((c) => `Kolaybase vs ${c.competitor}`),
  });
}

export default async function CompareIndex() {
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");

  return (
    <SiteShell>
      <JsonLd
        data={itemListSchema(
          "Kolaybase Comparisons",
          COMPARISONS.map((c) => ({
            name: c.title,
            url: `${base}/compare/${c.slug}`,
            description: c.description,
          })),
        )}
      />
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight">{TITLE}</h1>
          <p className="mt-3 text-lg text-muted-foreground">{DESCRIPTION}</p>
        </header>

        <div className="grid gap-6 sm:grid-cols-2">
          {COMPARISONS.map((c) => (
            <Link
              key={c.slug}
              href={`/compare/${c.slug}`}
              className="group rounded-xl border border-border p-6 transition-colors hover:border-primary/50 hover:bg-accent/40"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                <GitCompare className="h-5 w-5" aria-hidden />
              </div>
              <h2 className="mt-4 text-xl font-semibold tracking-tight">
                Kolaybase vs. {c.competitor}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {c.intro}
              </p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary">
                See the comparison
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </SiteShell>
  );
}
