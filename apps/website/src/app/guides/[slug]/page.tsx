import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { Breadcrumbs } from "@/components/seo/breadcrumbs";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { faqSchema, pageArticleSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest, getAppSignupUrl } from "@/lib/site-url";
import { docsUrl } from "@/lib/public-hosts";
import { GUIDES, getGuide, getGuideSlugs } from "@/lib/content/guides";

type Params = { params: { slug: string } };

export function generateStaticParams() {
  return getGuideSlugs().map((slug) => ({ slug }));
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const g = getGuide(params.slug);
  if (!g) return { title: "Not found", robots: { index: false } };
  return buildMetadata({
    path: `/guides/${g.slug}`,
    title: g.title,
    description: g.description,
    type: "article",
    publishedTime: g.updated,
    modifiedTime: g.updated,
  });
}

export default async function GuidePage({ params }: Params) {
  const g = getGuide(params.slug);
  if (!g) notFound();

  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const url = `${base}/guides/${g.slug}`;
  const linkCls = "underline underline-offset-2 hover:text-foreground";

  return (
    <SiteShell>
      <JsonLd data={faqSchema(g.faqs)} />
      <JsonLd
        data={pageArticleSchema({
          url,
          headline: g.title,
          description: g.description,
          datePublished: g.updated,
          dateModified: g.updated,
          siteUrl: base,
        })}
      />
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <Breadcrumbs
          items={[
            { name: "Home", url: `${base}/` },
            { name: "Guides", url: `${base}/guides` },
            { name: g.title, url },
          ]}
        />

        <header className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight">{g.title}</h1>
          <p className="mt-4 text-lg text-foreground">{g.answer}</p>
          <p className="mt-3 text-sm text-muted-foreground">
            Last updated: <time dateTime={g.updated}>{formatDate(g.updated)}</time>.
            Written by the basefyio team.
          </p>
        </header>

        {g.sections.map((s) => (
          <section key={s.heading} className="mb-10">
            <h2 className="mb-3 text-2xl font-semibold tracking-tight">{s.heading}</h2>
            {s.paragraphs?.map((p) => (
              <p key={p} className="mb-3 text-muted-foreground">{p}</p>
            ))}
            {s.bullets && (
              <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
                {s.bullets.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <section className="mb-10">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">Frequently asked questions</h2>
          <dl className="space-y-6">
            {g.faqs.map((faq) => (
              <div key={faq.question}>
                <dt className="font-semibold">{faq.question}</dt>
                <dd className="mt-1.5 text-muted-foreground">{faq.answer}</dd>
              </div>
            ))}
          </dl>
        </section>

        {g.sources && (
          <section className="mb-10">
            <h2 className="mb-3 text-2xl font-semibold tracking-tight">Sources</h2>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              {g.sources.map((src) => (
                <li key={src.url}>
                  <a href={src.url} target="_blank" rel="noopener" className={linkCls}>
                    {src.label}
                  </a>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-muted-foreground">
              Details about other products come from their public documentation and can change.
            </p>
          </section>
        )}

        <section className="mb-10">
          <h2 className="mb-3 text-2xl font-semibold tracking-tight">Related</h2>
          <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
            {g.related.map(([label, href]) => (
              <li key={href}>
                <Link href={href.startsWith("/docs") ? docsUrl(href) : href} className={linkCls}>
                  {label}
                </Link>
              </li>
            ))}
            {GUIDES.filter((o) => o.slug !== g.slug)
              .slice(0, 2)
              .map((o) => (
                <li key={o.slug}>
                  <Link href={`/guides/${o.slug}`} className={linkCls}>
                    {o.title}
                  </Link>
                </li>
              ))}
            <li>
              <Link href="/guides" className={linkCls}>All guides</Link>
            </li>
          </ul>
        </section>

        <section className="flex flex-col items-start gap-4 rounded-xl border border-border bg-accent/30 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Try basefyio on the free plan</h2>
            <p className="mt-1 text-muted-foreground">
              Create a project and get a database, auth, storage and a REST API.
            </p>
          </div>
          <Link
            href={getAppSignupUrl()}
            className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
        </section>
      </div>
    </SiteShell>
  );
}
