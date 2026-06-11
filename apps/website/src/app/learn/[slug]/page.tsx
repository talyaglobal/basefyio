import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { Breadcrumbs } from "@/components/seo/breadcrumbs";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { definedTermSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest, getAppSignupUrl } from "@/lib/site-url";
import { getTerm, getTermSlugs } from "@/lib/content/glossary";

type Params = { params: { slug: string } };

export function generateStaticParams() {
  return getTermSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const t = getTerm(params.slug);
  if (!t) return { title: "Not found", robots: { index: false } };

  return buildMetadata({
    path: `/learn/${t.slug}`,
    title: `${t.term}${t.aka ? ` (${t.aka})` : ""}`,
    description: t.definition,
    keywords: [t.term, ...(t.aka ? [t.aka] : []), "definition", "meaning"],
  });
}

export default async function TermPage({ params }: Params) {
  const t = getTerm(params.slug);
  if (!t) notFound();

  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const url = `${base}/learn/${t.slug}`;
  const signupUrl = getAppSignupUrl();
  const related = t.related
    .map((slug) => getTerm(slug))
    .filter((x): x is NonNullable<typeof x> => Boolean(x));

  return (
    <SiteShell>
      <JsonLd
        data={definedTermSchema({
          name: t.term,
          description: t.definition,
          url,
          siteUrl: base,
        })}
      />

      <article className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <Breadcrumbs
          items={[
            { name: "Home", url: `${base}/` },
            { name: "Learn", url: `${base}/learn` },
            { name: t.term, url },
          ]}
        />

        <header className="mb-8">
          <h1 className="text-4xl font-bold tracking-tight">
            {t.term}
            {t.aka ? (
              <span className="text-muted-foreground"> ({t.aka})</span>
            ) : null}
          </h1>
          <p className="mt-4 text-lg text-muted-foreground">{t.definition}</p>
        </header>

        <div className="prose prose-neutral max-w-none dark:prose-invert">
          {t.body.map((para, i) => (
            <p key={i}>{para}</p>
          ))}
        </div>

        {related.length > 0 && (
          <section className="mt-12 border-t border-border pt-8">
            <h2 className="mb-4 text-xl font-semibold tracking-tight">
              Related terms
            </h2>
            <div className="flex flex-wrap gap-2">
              {related.map((r) => (
                <Link
                  key={r.slug}
                  href={`/learn/${r.slug}`}
                  className="rounded-full border border-border px-4 py-1.5 text-sm transition-colors hover:border-primary/50 hover:bg-accent"
                >
                  {r.term}
                </Link>
              ))}
            </div>
          </section>
        )}

        {t.seeAlso && t.seeAlso.length > 0 && (
          <section className="mt-12 rounded-xl border border-border bg-accent/30 p-6">
            <h2 className="mb-3 text-lg font-semibold">
              {t.term} in basefyio
            </h2>
            <ul className="space-y-2">
              {t.seeAlso.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="inline-flex items-center gap-1 text-sm font-medium text-primary transition-colors hover:underline"
                  >
                    {link.label}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mt-8 flex flex-col items-start gap-4 rounded-xl border border-border bg-accent/30 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold">See it in practice</h2>
            <p className="mt-1 text-muted-foreground">
              basefyio gives you database, auth, storage, and a REST API in
              minutes.
            </p>
          </div>
          <Link
            href={signupUrl}
            className="inline-flex h-10 shrink-0 items-center gap-1 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
            <ArrowRight className="h-4 w-4" />
          </Link>
        </section>
      </article>
    </SiteShell>
  );
}
