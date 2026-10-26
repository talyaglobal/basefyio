'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Check } from 'lucide-react';
import { api } from '@/lib/api';
import type { OrganizationKind } from '@/lib/types';
import { useDashboard, orgPath } from '@/app/dashboard/layout';
import { SELECTABLE_ORGANIZATION_KINDS } from '@/components/organization-kind';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

interface PlanCard {
  name: string;
  displayName: string;
  priceMonthly: number;
  maxProjects?: number | null;
  maxStorageGb?: number | null;
  isPublic?: boolean;
}

const STEPS = ['Name', 'Type', 'Plan'] as const;

/**
 * /dashboard/org/new — name → type → plan. The organization is created on
 * the free plan; a paid choice opens Stripe checkout and the plan applies once
 * the payment succeeds, never before.
 */
export default function NewOrganizationPage() {
  const router = useRouter();
  const { features, featuresLoaded, setActiveTeamId, refreshTeams } = useDashboard();

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<OrganizationKind>('COMPANY');
  const [plans, setPlans] = useState<PlanCard[] | null>(null);
  const [planName, setPlanName] = useState('free');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (featuresLoaded && !features.organizations_ui) router.replace('/dashboard/projects');
  }, [featuresLoaded, features.organizations_ui, router]);

  useEffect(() => {
    api.billing
      .plans()
      .then((list: any[]) => {
        const visible = (list || [])
          .filter((p) => p && p.isPublic !== false)
          .map((p) => ({
            name: String(p.name),
            displayName: String(p.displayName ?? p.name),
            priceMonthly: Number(p.priceMonthly ?? 0),
            maxProjects: p.maxProjects ?? null,
            maxStorageGb: p.maxStorageGb ?? p.maxStorageGB ?? null,
          }))
          .sort((a, b) => a.priceMonthly - b.priceMonthly);
        setPlans(visible);
        if (!visible.some((p) => p.name === 'free') && visible[0]) setPlanName(visible[0].name);
      })
      .catch(() => setPlans([]));
  }, []);

  const nameOk = name.trim().length >= 2 && name.trim().length <= 60;
  const chosenPlan = useMemo(() => plans?.find((p) => p.name === planName) ?? null, [plans, planName]);
  const paid = !!chosenPlan && chosenPlan.priceMonthly > 0;

  async function create() {
    if (!nameOk || submitting) return;
    setSubmitting(true);
    try {
      const origin = window.location.origin;
      const result = await api.organizations.create({
        name: name.trim(),
        kind,
        planName: paid ? planName : undefined,
        successUrl: paid ? `${origin}/dashboard/billing?success=true` : undefined,
        cancelUrl: paid ? `${origin}/dashboard/billing?canceled=true` : undefined,
      });
      const org = result.organization;
      // The new organization becomes the active one before any redirect, so
      // the billing return page shows it.
      setActiveTeamId(org.id);
      await api.teams.setActive(org.id).catch(() => {});
      refreshTeams();
      if (result.checkoutUrl) {
        window.location.assign(result.checkoutUrl);
        return;
      }
      toast.success(`Organization "${org.name}" created`);
      router.push(orgPath({ id: org.id, publicId: org.publicId }));
    } catch (err: any) {
      toast.error(err?.message || 'Could not create the organization');
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New organization</h1>
        <p className="text-sm text-muted-foreground">A separate space with its own projects, members, roles and plan.</p>
      </div>

      <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                'flex h-6 w-6 items-center justify-center rounded-full border text-[11px] font-semibold',
                i < step && 'border-primary bg-primary text-primary-foreground',
                i === step && 'border-primary text-primary',
                i > step && 'text-muted-foreground',
              )}
            >
              {i < step ? <Check className="h-3 w-3" /> : i + 1}
            </span>
            <span className={cn(i === step ? 'font-medium' : 'text-muted-foreground')}>{label}</span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <section className="space-y-4 rounded-xl border p-5">
          <div className="space-y-1.5">
            <Label htmlFor="org-new-name">Name</Label>
            <Input
              id="org-new-name"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && nameOk) setStep(1);
              }}
              placeholder="Acme"
              maxLength={60}
            />
            <p className="text-xs text-muted-foreground">2–60 characters. You can rename it later; its address never changes.</p>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setStep(1)} disabled={!nameOk}>
              Next <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </section>
      )}

      {step === 1 && (
        <section className="space-y-4 rounded-xl border p-5">
          <div>
            <h2 className="font-semibold">What kind of organization is it?</h2>
            <p className="text-xs text-muted-foreground">This only labels it; nothing is locked by the choice.</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Organization type">
            {SELECTABLE_ORGANIZATION_KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={kind === k.value}
                onClick={() => setKind(k.value)}
                className={cn(
                  'flex items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent/50',
                  kind === k.value && 'border-primary bg-primary/5 ring-1 ring-primary',
                )}
              >
                <k.icon className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
                <span>
                  <span className="block text-sm font-medium">{k.label}</span>
                  <span className="block text-xs text-muted-foreground">{k.description}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(0)}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Button>
            <Button onClick={() => setStep(2)}>
              Next <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </section>
      )}

      {step === 2 && (
        <section className="space-y-4 rounded-xl border p-5">
          <div>
            <h2 className="font-semibold">Pick a plan</h2>
            <p className="text-xs text-muted-foreground">
              Free is selected. A paid plan takes you to checkout and applies as soon as the payment succeeds.
            </p>
          </div>
          {plans === null ? (
            <div className="h-28 animate-pulse rounded-lg bg-muted/30" />
          ) : plans.length === 0 ? (
            <p className="text-sm text-muted-foreground">Plans are not available right now; the organization starts on Free.</p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Plan">
              {plans.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  role="radio"
                  aria-checked={planName === p.name}
                  onClick={() => setPlanName(p.name)}
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors hover:bg-accent/50',
                    planName === p.name && 'border-primary bg-primary/5 ring-1 ring-primary',
                  )}
                >
                  <span className="block text-sm font-medium">{p.displayName}</span>
                  <span className="block text-lg font-semibold tabular-nums">
                    {p.priceMonthly > 0 ? `$${p.priceMonthly}` : 'Free'}
                    {p.priceMonthly > 0 && <span className="text-xs font-normal text-muted-foreground"> / month</span>}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {p.maxProjects != null ? `${p.maxProjects} projects` : 'Projects as you need'}
                    {p.maxStorageGb != null ? ` · ${p.maxStorageGb} GB storage` : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)} disabled={submitting}>
              <ArrowLeft className="mr-1 h-4 w-4" /> Back
            </Button>
            <Button onClick={create} disabled={submitting || !nameOk}>
              {submitting ? 'Creating…' : paid ? 'Create and continue to checkout' : 'Create organization'}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
