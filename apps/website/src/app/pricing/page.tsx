import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { PricingSection } from "@/components/pricing-section";
import { buildMetadata } from "@/lib/seo/metadata";
import { getPublicPlans } from "@/lib/pricing";
import { getAppSignupUrl } from "@/lib/site-url";

/**
 * A real /pricing page. Prices used to live only at /#pricing, so links from
 * ads, comparisons and search results to /pricing answered 404. It renders the
 * same cards as the home page (one component, one data source: the billing API).
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    path: "/pricing",
    title: "Pricing — Free plan and monthly plans",
    description:
      "basefyio pricing: start on the Free plan with no credit card, move to a monthly plan for more projects, storage, API requests and users.",
  });
}

export default async function PricingPage() {
  const plans = await getPublicPlans();
  const signupUrl = getAppSignupUrl();

  return (
    <SiteShell>
      <PricingSection plans={plans} signupUrl={signupUrl} asPageHeading />

      <section className="mx-auto max-w-3xl px-6 pb-24">
        <h2 className="text-2xl font-bold tracking-tight">Questions about plans</h2>
        <dl className="mt-6 space-y-6 text-sm leading-relaxed">
          <div>
            <dt className="font-semibold text-foreground">Do I need a credit card to start?</dt>
            <dd className="mt-1 text-muted-foreground">
              No. The Free plan has no card and no time limit. Add a payment method when you
              move to a paid plan.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">What counts against the limits?</dt>
            <dd className="mt-1 text-muted-foreground">
              Limits apply per team: the number of projects, file storage, database size, team
              members, API requests and bandwidth per month, and monthly active users. Current
              usage against each limit is under <strong>Billing</strong> in the dashboard.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">Are there usage charges on top of the plan?</dt>
            <dd className="mt-1 text-muted-foreground">
              No. You pay the plan&apos;s monthly price. The <strong>Project costs</strong> view in
              Billing prices each project&apos;s compute, storage, egress and requests at standard
              rates so you can see where usage goes; it is a breakdown, not an extra bill.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">Can I change or cancel my plan?</dt>
            <dd className="mt-1 text-muted-foreground">
              Upgrade at any time from Billing; the unused part of your current plan is credited.
              Cancelling keeps the plan until the end of the period you paid for.
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-foreground">Can I run basefyio myself?</dt>
            <dd className="mt-1 text-muted-foreground">
              Yes — basefyio is open source. See the{" "}
              <Link href="/docs/self-hosting" className="text-primary underline underline-offset-2">
                Self-Hosting guide
              </Link>
              .
            </dd>
          </div>
        </dl>
      </section>
    </SiteShell>
  );
}
