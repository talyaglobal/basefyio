import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { itemListSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { getTermsSorted } from "@/lib/content/glossary";

const TITLE = "Learn — Backend & database Glossary";
const DESCRIPTION =
  "Clear definitions of backend, database, and API concepts — REST, row-level security, multi-tenancy, OAuth, ACID, and more. The basefyio glossary.";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    path: "/learn",
    title: TITLE,
    description: DESCRIPTION,
    keywords: ["backend glossary", "databaseql terms", "api glossary"],
  });
}

export default async function LearnIndex() {
  const terms = getTermsSorted();
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");

  return (
    <SiteShell>
      <JsonLd
        data={itemListSchema(
          "basefyio Glossary",
          terms.map((t) => ({
            name: t.term,
            url: `${base}/learn/${t.slug}`,
            description: t.definition,
          })),
        )}
      />
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight">{TITLE}</h1>
          <p className="mt-3 text-lg text-muted-foreground">{DESCRIPTION}</p>
        </header>

        <ul className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2">
          {terms.map((t) => (
            <li key={t.slug} className="bg-background">
              <Link
                href={`/learn/${t.slug}`}
                className="block h-full p-5 transition-colors hover:bg-accent/40"
              >
                <span className="font-semibold">
                  {t.term}
                  {t.aka ? (
                    <span className="text-muted-foreground"> ({t.aka})</span>
                  ) : null}
                </span>
                <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">
                  {t.definition}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </SiteShell>
  );
}
