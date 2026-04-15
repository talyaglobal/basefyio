import { useEffect, useMemo, useState } from 'react';
import { billingPlansUrl, getAppBaseUrl } from '../../lib/publicEnv';
import { formatPlanBullets, formatPlanPrice, formatPlanSubtitle, type PublicPlan } from '../../lib/planFormat';

type Props = {
  /** Section id for FAQ anchor links */
  sectionId?: string;
};

export function PricingPlansIsland({ sectionId = 'pricing-section' }: Props) {
  const [plans, setPlans] = useState<PublicPlan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const appUrl = useMemo(() => getAppBaseUrl(), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(billingPlansUrl(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<PublicPlan[]>;
      })
      .then((data) => {
        if (!cancelled) {
          setPlans(Array.isArray(data) ? data : []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(
            'Plans could not be loaded. Check PUBLIC_PLATFORM_API_URL or your network, then try again.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const popularName = useMemo(() => {
    const paid = plans.filter((p) => p.priceMonthly > 0);
    if (paid.length >= 2) return paid[1]!.name;
    if (paid.length === 1) return paid[0]!.name;
    return plans[1]?.name ?? plans[0]?.name;
  }, [plans]);

  function ctaFor(plan: PublicPlan): { href: string; label: string } {
    const paid = plan.priceMonthly > 0;
    const isFree = plan.name === 'free';
    if (paid || isFree) {
      return {
        href: `${appUrl}/signup?plan=${encodeURIComponent(plan.name)}`,
        label: isFree ? 'Sign up free' : 'Sign up with this plan',
      };
    }
    return {
      href: `/contact?plan=${encodeURIComponent(plan.name)}`,
      label: 'Talk to sales',
    };
  }

  if (loading) {
    return (
      <div className="grid gap-6 md:grid-cols-3 max-w-5xl mx-auto">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex flex-col rounded-lg border border-border bg-bg p-6 animate-pulse min-h-[280px]"
          >
            <div className="h-6 bg-surface-2 rounded w-1/2 mb-4" />
            <div className="h-12 bg-surface-2 rounded w-1/3 mb-6" />
            <div className="space-y-2 flex-1">
              <div className="h-4 bg-surface-2 rounded w-full" />
              <div className="h-4 bg-surface-2 rounded w-5/6" />
              <div className="h-4 bg-surface-2 rounded w-4/6" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error || plans.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-surface px-6 py-8 text-center max-w-xl mx-auto">
        <p className="text-body text-text-secondary">{error || 'No plans found.'}</p>
        <a
          href="/contact"
          className="mt-4 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-body-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Contact
        </a>
      </div>
    );
  }

  return (
    <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto" id={sectionId}>
      {plans.map((plan) => {
        const popular = plan.name === popularName;
        const subtitle = formatPlanSubtitle(plan);
        const bullets = formatPlanBullets(plan);
        const cta = ctaFor(plan);

        return (
          <div
            key={plan.id}
            className={`relative flex flex-col p-6 rounded-lg border transition-all duration-200 ${
              popular
                ? 'border-primary bg-primary/5 shadow-soft'
                : 'border-border bg-bg hover:border-border-hover hover:shadow-soft'
            }`}
          >
            {popular && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                <span className="inline-flex items-center px-3 py-1 rounded-full bg-primary text-primary-foreground text-tiny font-medium">
                  Most popular
                </span>
              </div>
            )}

            <div className="mb-6">
              <h3 className="text-h5 text-text">{plan.displayName}</h3>
              <p className="mt-1 text-body-sm text-muted">{subtitle}</p>
            </div>

            <div className="mb-6">
              <div className="flex items-baseline gap-1">
                <span className="text-h1 text-text font-bold">{formatPlanPrice(plan.priceMonthly)}</span>
              </div>
              <p className="mt-1 text-small text-muted">Billed monthly in USD. Taxes excluded.</p>
            </div>

            <a
              href={cta.href}
              className={`inline-flex items-center justify-center h-10 px-4 rounded-md font-medium text-body-sm transition-all duration-150 ${
                popular
                  ? 'bg-primary text-primary-foreground hover:bg-primary-hover shadow-subtle hover:shadow-soft'
                  : 'border border-border text-text hover:bg-surface hover:border-border-hover'
              }`}
            >
              {cta.label}
            </a>

            <div className="mt-6 pt-6 border-t border-border flex-1">
              <p className="text-small font-medium text-text mb-4">Highlights</p>
              <ul className="space-y-3">
                {bullets.map((line, idx) => (
                  <li key={`${plan.id}-b-${idx}`} className="flex items-start gap-3 text-body-sm text-text-secondary">
                    <svg
                      className="w-5 h-5 text-success shrink-0 mt-0.5"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                      aria-hidden
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
                    </svg>
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        );
      })}
    </div>
  );
}
