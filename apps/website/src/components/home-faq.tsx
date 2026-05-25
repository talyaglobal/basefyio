import { faqSchema } from "@kolaybase/geo";
import { JsonLd } from "@/components/seo/json-ld";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { createGeoProfile } from "@/lib/geo/profile";

/**
 * Answer-first FAQ section + FAQPage JSON-LD.
 *
 * This is the GEO workhorse on the page: every answer is self-contained, leads
 * with the answer, and is mirrored into FAQPage structured data — the format
 * answer engines cite most. Visible content and schema share one source (the
 * GEO profile), so they can never drift apart.
 */
export async function HomeFaq() {
  const siteUrl = await getSiteUrlFromRequest();
  const profile = createGeoProfile(siteUrl);
  const faqs = profile.faqs ?? [];
  if (faqs.length === 0) return null;

  return (
    <section id="faq" className="relative px-6 py-24">
      <div className="mx-auto max-w-3xl">
        <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
          Frequently asked questions
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
          What Kolaybase is, how it compares, and how to get started.
        </p>

        <dl className="mt-12 divide-y divide-border rounded-lg border border-border bg-card">
          {faqs.map((faq) => (
            <div key={faq.question} className="p-6">
              <dt className="text-lg font-semibold text-foreground">
                {faq.question}
              </dt>
              <dd className="mt-2 leading-relaxed text-muted-foreground">
                {faq.answer}
              </dd>
            </div>
          ))}
        </dl>
      </div>

      <JsonLd data={faqSchema(profile) as Record<string, unknown>} />
    </section>
  );
}
