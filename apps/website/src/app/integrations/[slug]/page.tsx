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
import {
  INTEGRATIONS,
  getIntegration,
  getIntegrationSlugs,
} from "@/lib/content/integrations";

type Params = { params: { slug: string } };

export function generateStaticParams() {
  return getIntegrationSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const i = getIntegration(params.slug);
  if (!i) return { title: "Not found", robots: { index: false } };

  return buildMetadata({
    path: `/integrations/${i.slug}`,
    title: i.title,
    description: i.description,
    keywords: [`${i.name} backend`, `Basefyio ${i.name}`, `${i.name} PostgreSQL`],
  });
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded-xl border border-border bg-muted p-5 text-sm">
      <code>{children}</code>
    </pre>
  );
}

export default async function IntegrationPage({ params }: Params) {
  const i = getIntegration(params.slug);
  if (!i) notFound();

  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const url = `${base}/integrations/${i.slug}`;
  const signupUrl = getAppSignupUrl();

  return (
    <SiteShell>
      <JsonLd data={faqSchema(i.faqs)} />

      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <Breadcrumbs
          items={[
            { name: "Home", url: `${base}/` },
            { name: "Integrations", url: `${base}/integrations` },
            { name: i.name, url },
          ]}
        />

        <header className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight">{i.title}</h1>
          <p className="mt-4 text-lg text-muted-foreground">{i.intro}</p>
        </header>

        <section className="mb-10">
          <h2 className="mb-3 text-2xl font-semibold tracking-tight">Install</h2>
          <CodeBlock>{i.install}</CodeBlock>
        </section>

        <section className="mb-10">
          <h2 className="mb-3 text-2xl font-semibold tracking-tight">
            {i.setupTitle}
          </h2>
          <CodeBlock>{i.setup}</CodeBlock>
          <p className="mt-3 text-sm text-muted-foreground">{i.setupNote}</p>
        </section>

        <section className="mb-12">
          <h2 className="mb-3 text-2xl font-semibold tracking-tight">
            {i.usageTitle}
          </h2>
          <CodeBlock>{i.usage}</CodeBlock>
        </section>

        <section className="mb-12 grid gap-6 sm:grid-cols-3">
          {i.benefits.map((b) => (
            <div key={b.title} className="rounded-xl border border-border p-5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Check className="h-4 w-4" aria-hidden />
              </div>
              <h3 className="mt-3 font-semibold">{b.title}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{b.body}</p>
            </div>
          ))}
        </section>

        <section className="mb-12">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            Frequently asked questions
          </h2>
          <dl className="space-y-6">
            {i.faqs.map((faq) => (
              <div key={faq.question}>
                <dt className="font-semibold">{faq.question}</dt>
                <dd className="mt-1.5 text-muted-foreground">{faq.answer}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="mb-12">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            Other integrations
          </h2>
          <div className="flex flex-wrap gap-2">
            {INTEGRATIONS.filter((o) => o.slug !== i.slug).map((o) => (
              <Link
                key={o.slug}
                href={`/integrations/${o.slug}`}
                className="rounded-full border border-border px-4 py-1.5 text-sm transition-colors hover:border-primary/50 hover:bg-accent"
              >
                {o.name}
              </Link>
            ))}
          </div>
        </section>

        <section className="flex flex-col items-start gap-4 rounded-xl border border-border bg-accent/30 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold">
              Build your {i.name} backend on Basefyio
            </h2>
            <p className="mt-1 text-muted-foreground">
              PostgreSQL, auth, storage, and a REST API — running in minutes.
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
