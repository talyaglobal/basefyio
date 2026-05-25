import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Check } from "lucide-react";
import { SiteShell } from "@/components/site-shell";
import { Breadcrumbs } from "@/components/seo/breadcrumbs";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { faqSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest, getAppSignupUrl } from "@/lib/site-url";
import { USE_CASES, getUseCase, getUseCaseSlugs } from "@/lib/content/use-cases";

type Params = { params: { slug: string } };

export function generateStaticParams() {
  return getUseCaseSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const u = getUseCase(params.slug);
  if (!u) return { title: "Not found", robots: { index: false } };

  return buildMetadata({
    path: `/use-cases/${u.slug}`,
    title: u.title,
    description: u.description,
    keywords: [`backend for ${u.label}`, `${u.label} backend`],
  });
}

export default async function UseCasePage({ params }: Params) {
  const u = getUseCase(params.slug);
  if (!u) notFound();

  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const url = `${base}/use-cases/${u.slug}`;
  const signupUrl = getAppSignupUrl();

  return (
    <SiteShell>
      <JsonLd data={faqSchema(u.faqs)} />

      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <Breadcrumbs
          items={[
            { name: "Home", url: `${base}/` },
            { name: "Use cases", url: `${base}/use-cases` },
            { name: u.label, url },
          ]}
        />

        <header className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight">{u.title}</h1>
          <p className="mt-4 text-lg text-muted-foreground">{u.intro}</p>
        </header>

        <section className="mb-14 grid gap-6 sm:grid-cols-2">
          {u.benefits.map((b) => (
            <div
              key={b.title}
              className="rounded-xl border border-border p-6"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Check className="h-4 w-4" aria-hidden />
              </div>
              <h2 className="mt-3 text-lg font-semibold">{b.title}</h2>
              <p className="mt-1.5 text-sm text-muted-foreground">{b.body}</p>
            </div>
          ))}
        </section>

        <section className="mb-14">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            {u.codeTitle}
          </h2>
          <pre className="overflow-x-auto rounded-xl border border-border bg-muted p-5 text-sm">
            <code>{u.code}</code>
          </pre>
        </section>

        <section className="mb-14">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            Frequently asked questions
          </h2>
          <dl className="space-y-6">
            {u.faqs.map((faq) => (
              <div key={faq.question}>
                <dt className="font-semibold">{faq.question}</dt>
                <dd className="mt-1.5 text-muted-foreground">{faq.answer}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mb-14">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            More use cases
          </h2>
          <div className="flex flex-wrap gap-2">
            {USE_CASES.filter((o) => o.slug !== u.slug).map((o) => (
              <Link
                key={o.slug}
                href={`/use-cases/${o.slug}`}
                className="rounded-full border border-border px-4 py-1.5 text-sm transition-colors hover:border-primary/50 hover:bg-accent"
              >
                {o.label}
              </Link>
            ))}
          </div>
        </section>

        <section className="flex flex-col items-start gap-4 rounded-xl border border-border bg-accent/30 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Start building today</h2>
            <p className="mt-1 text-muted-foreground">
              A complete backend for your {u.label.toLowerCase()} — running in
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
      </div>
    </SiteShell>
  );
}
