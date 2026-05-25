import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { Breadcrumbs } from "@/components/seo/breadcrumbs";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { faqSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest, getAppSignupUrl } from "@/lib/site-url";
import {
  COMPARISONS,
  getComparison,
  getComparisonSlugs,
} from "@/lib/content/comparisons";

type Params = { params: { slug: string } };

export function generateStaticParams() {
  return getComparisonSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const c = getComparison(params.slug);
  if (!c) return { title: "Not found", robots: { index: false } };

  return buildMetadata({
    path: `/compare/${c.slug}`,
    title: c.title,
    description: c.description,
    keywords: [`Kolaybase vs ${c.competitor}`, `${c.competitor} alternative`],
  });
}

export default async function ComparisonPage({ params }: Params) {
  const c = getComparison(params.slug);
  if (!c) notFound();

  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const url = `${base}/compare/${c.slug}`;
  const signupUrl = getAppSignupUrl();

  return (
    <SiteShell>
      <JsonLd data={faqSchema(c.faqs)} />

      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <Breadcrumbs
          items={[
            { name: "Home", url: `${base}/` },
            { name: "Compare", url: `${base}/compare` },
            { name: `vs. ${c.competitor}`, url },
          ]}
        />

        <header className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight">{c.title}</h1>
          <p className="mt-4 text-lg text-muted-foreground">{c.intro}</p>
        </header>

        <section className="mb-12 rounded-xl border border-border bg-accent/30 p-6">
          <h2 className="text-lg font-semibold">How Kolaybase is different</h2>
          <p className="mt-2 text-muted-foreground">{c.positioning}</p>
        </section>

        <section className="mb-14">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            Feature comparison
          </h2>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left">
                  <th className="px-4 py-3 font-semibold">Feature</th>
                  <th className="px-4 py-3 font-semibold text-primary">
                    Kolaybase
                  </th>
                  <th className="px-4 py-3 font-semibold">{c.competitor}</th>
                </tr>
              </thead>
              <tbody>
                {c.rows.map((row) => (
                  <tr
                    key={row.feature}
                    className="border-b border-border last:border-0"
                  >
                    <td className="px-4 py-3 font-medium">{row.feature}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.kolaybase}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.competitor}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-14">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            Frequently asked questions
          </h2>
          <dl className="space-y-6">
            {c.faqs.map((faq) => (
              <div key={faq.question}>
                <dt className="font-semibold">{faq.question}</dt>
                <dd className="mt-1.5 text-muted-foreground">{faq.answer}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mb-14">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            More comparisons
          </h2>
          <div className="flex flex-wrap gap-2">
            {COMPARISONS.filter((o) => o.slug !== c.slug).map((o) => (
              <Link
                key={o.slug}
                href={`/compare/${o.slug}`}
                className="rounded-full border border-border px-4 py-1.5 text-sm transition-colors hover:border-primary/50 hover:bg-accent"
              >
                Kolaybase vs. {o.competitor}
              </Link>
            ))}
          </div>
        </section>

        <section className="flex flex-col items-start gap-4 rounded-xl border border-border bg-accent/30 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold">
              Try Kolaybase for your next project
            </h2>
            <p className="mt-1 text-muted-foreground">
              PostgreSQL, auth, storage, and a REST API — running in minutes.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={signupUrl}
              className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Get started
            </Link>
            <Link
              href="/docs"
              className="inline-flex h-10 items-center gap-1 rounded-md border border-border px-5 text-sm font-medium transition-colors hover:bg-accent"
            >
              Read the docs
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>
      </div>
    </SiteShell>
  );
}
