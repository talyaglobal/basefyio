import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, Plug } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { itemListSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { INTEGRATIONS } from "@/lib/content/integrations";

const TITLE = "Integrations";
const DESCRIPTION =
  "Use basefyio with your stack — Next.js, React, Vue, SvelteKit, React Native, Node.js, and more. database, auth, and storage via the basefyio-js SDK.";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    path: "/integrations",
    title: TITLE,
    description: DESCRIPTION,
    keywords: INTEGRATIONS.map((i) => `${i.name} backend`),
  });
}

export default async function IntegrationsIndex() {
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");

  return (
    <SiteShell>
      <JsonLd
        data={itemListSchema(
          "basefyio Integrations",
          INTEGRATIONS.map((i) => ({
            name: i.name,
            url: `${base}/integrations/${i.slug}`,
            description: i.description,
          })),
        )}
      />
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight">{TITLE}</h1>
          <p className="mt-3 text-lg text-muted-foreground">{DESCRIPTION}</p>
        </header>

        <div className="grid gap-6 sm:grid-cols-2">
          {INTEGRATIONS.map((i) => (
            <Link
              key={i.slug}
              href={`/integrations/${i.slug}`}
              className="group rounded-xl border border-border p-6 transition-colors hover:border-primary/50 hover:bg-accent/40"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                <Plug className="h-5 w-5" aria-hidden />
              </div>
              <div className="mt-4 flex items-center gap-2">
                <h2 className="text-xl font-semibold tracking-tight">
                  {i.name}
                </h2>
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {i.category}
                </span>
              </div>
              <p className="mt-2 text-sm text-muted-foreground">{i.intro}</p>
              <span className="mt-4 inline-flex items-center gap-1 text-sm font-medium text-primary">
                View guide
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </SiteShell>
  );
}
