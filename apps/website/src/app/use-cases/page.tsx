import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Layers } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { itemListSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { USE_CASES } from "@/lib/content/use-cases";

const TITLE = "Use Cases";
const DESCRIPTION =
  "See what teams build on Kolaybase — SaaS platforms, mobile app backends, internal tools, and more. PostgreSQL, auth, storage, and a REST API for every kind of product.";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    path: "/use-cases",
    title: TITLE,
    description: DESCRIPTION,
    keywords: USE_CASES.map((u) => `backend for ${u.label}`),
  });
}

export default async function UseCasesIndex() {
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");

  return (
    <SiteShell>
      <JsonLd
        data={itemListSchema(
          "Kolaybase Use Cases",
          USE_CASES.map((u) => ({
            name: u.title,
            url: `${base}/use-cases/${u.slug}`,
            description: u.description,
          })),
        )}
      />
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight">{TITLE}</h1>
          <p className="mt-3 text-lg text-muted-foreground">{DESCRIPTION}</p>
        </header>

        <div className="grid gap-6 sm:grid-cols-2">
          {USE_CASES.map((u) => (
            <Link
              key={u.slug}
              href={`/use-cases/${u.slug}`}
              className="group rounded-xl border border-border p-6 transition-colors hover:border-primary/50 hover:bg-accent/40"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                <Layers className="h-5 w-5" aria-hidden />
              </div>
              <h2 className="mt-4 text-xl font-semibold tracking-tight">
                {u.label}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">{u.intro}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary">
                Learn more
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </SiteShell>
  );
}
