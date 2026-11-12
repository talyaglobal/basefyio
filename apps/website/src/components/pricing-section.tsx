import Link from "next/link";
import { ScrollReveal } from "@/components/scroll-reveal";
import { planFeatures, type PublicPlan } from "@/lib/pricing";

/**
 * The plan cards, shared by the home page (#pricing) and /pricing so the two
 * can never disagree. Plans and limits come from the billing API — the same
 * rows the dashboard's Billing page shows.
 *
 * There is no trial period in billing: the Free plan costs nothing and needs no
 * card, and a paid plan is billed monthly from the moment you choose it. The
 * cards say exactly that and no more.
 */
export function PricingSection({
  plans,
  signupUrl,
  asPageHeading = false,
}: {
  plans: PublicPlan[];
  signupUrl: string;
  /** On /pricing the title is the page's h1; on the home page it is a section h2. */
  asPageHeading?: boolean;
}) {
  const Heading = asPageHeading ? "h1" : "h2";

  return (
    <section id="pricing" className="relative overflow-hidden px-6 py-24">
      <div className="absolute inset-0 bg-brand-gradient-subtle" />
      <div className="noise-overlay z-[1] opacity-50" aria-hidden />
      <div className="relative z-10 mx-auto max-w-6xl">
        <ScrollReveal>
          <span className="section-label block text-center">Pricing</span>
          <Heading className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            Start free. Scale when you ship.
          </Heading>
          <p className="mx-auto mt-4 max-w-xl text-center text-muted-foreground">
            One flat monthly price per team. No usage charges on top, no hidden fees.
          </p>
        </ScrollReveal>

        <div className="mt-14 grid gap-5 lg:grid-cols-3">
          {plans.map((plan, i) => {
            const featured = plan.name.toLowerCase() === "pro";
            const free = plan.priceMonthly === 0;
            return (
              <ScrollReveal key={plan.id} delay={(i % 3) as 0 | 1 | 2}>
                <div
                  className={`relative flex h-full flex-col rounded-xl bg-card p-7 shadow-subtle ${
                    featured ? "border-2 border-primary shadow-medium" : "border border-border"
                  }`}
                >
                  {featured && (
                    <div className="absolute -top-3 left-6 rounded-full bg-primary px-3 py-0.5 text-xs font-bold text-primary-foreground">
                      &#9733; Most Popular
                    </div>
                  )}
                  <h3 className="text-sm font-semibold">{plan.displayName}</h3>
                  <div className="mt-4">
                    <span className="text-4xl font-bold tracking-tight">
                      ${(plan.priceMonthly / 100).toFixed(0)}
                    </span>
                    <span className="text-sm text-muted-foreground"> /mo</span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {free ? "Free forever · no credit card" : "Billed monthly · cancel anytime"}
                  </p>
                  <ul className="mt-6 flex-1 space-y-3 text-sm">
                    {planFeatures(plan).map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <span className="font-mono text-xs text-muted-foreground">+</span>
                        <span className="text-muted-foreground">{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={`${signupUrl}?plan=${encodeURIComponent(plan.name)}`}
                    className={`mt-8 inline-flex w-full items-center justify-center rounded-lg px-6 py-3 text-sm font-medium transition-all ${
                      featured
                        ? "bg-primary font-bold text-primary-foreground shadow-subtle hover:opacity-90"
                        : "border border-border text-foreground hover:bg-accent"
                    }`}
                  >
                    {free ? "Get started" : `Choose ${plan.displayName}`}
                  </Link>
                </div>
              </ScrollReveal>
            );
          })}
          {plans.length === 0 && (
            <div className="rounded-xl border border-border bg-card p-8 text-sm text-muted-foreground lg:col-span-3">
              Pricing plans are temporarily unavailable.
            </div>
          )}
        </div>

        <p className="mx-auto mt-10 max-w-3xl text-center text-xs leading-relaxed text-muted-foreground">
          Monthly active users are the distinct end users who sign in to your projects in a
          month. In the dashboard, <strong>Billing → Project costs</strong> breaks each project&apos;s
          usage down — compute hours, database and file storage, egress and API requests — at
          standard usage rates, so you can see where your plan&apos;s resources go. That breakdown
          is informational: you pay the plan&apos;s monthly price.
        </p>
      </div>
    </section>
  );
}
