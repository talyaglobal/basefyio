'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { setTokens, startProactiveRefresh } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import { Database, Check, Info } from 'lucide-react';

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24">
      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
    </svg>
  );
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="currentColor" viewBox="0 0 24 24">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
    </svg>
  );
}

export default function SignupPage() {
  return (
    <Suspense>
      <SignupForm />
    </Suspense>
  );
}

type SignupPlan = {
  name: string;
  label: string;
  price: string;
  desc: string;
};

const FALLBACK_PLANS: SignupPlan[] = [
  { name: 'free', label: 'Free', price: '$0', desc: '2 projects, 1 GB storage' },
  { name: 'pro', label: 'Pro', price: '$25/mo', desc: '10 projects, dedicated DB' },
  { name: 'business', label: 'Business', price: '$99/mo', desc: '25 projects, dedicated DB & storage' },
];

function formatPlanPrice(priceMonthly: number): string {
  if (priceMonthly <= 0) return '$0';
  return `$${(priceMonthly / 100).toFixed(0)}/mo`;
}

function formatPlanDescription(plan: {
  maxProjects?: number | null;
  maxStorageBytes?: string | number | null;
}): string {
  const projects =
    plan.maxProjects === null || plan.maxProjects === undefined
      ? 'Unlimited projects'
      : `${plan.maxProjects} projects`;
  const storage =
    plan.maxStorageBytes === null || plan.maxStorageBytes === undefined
      ? 'Unlimited storage'
      : `${Math.max(1, Math.round(Number(plan.maxStorageBytes) / (1024 * 1024 * 1024)))} GB storage`;
  return `${projects}, ${storage}`;
}

function SignupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [selectedPlan, setSelectedPlan] = useState('free');
  const [plans, setPlans] = useState<SignupPlan[]>(FALLBACK_PLANS);
  const [form, setForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
  });
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState<string | null>(null);
  const [providers, setProviders] = useState<string[]>(['github']);

  useEffect(() => {
    const hash = window.location.hash.substring(1);
    if (hash) {
      const params = new URLSearchParams(hash);
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const idToken = params.get('id_token');
      const expiresIn = params.get('expires_in');

      if (accessToken && refreshToken) {
        setTokens({
          accessToken,
          refreshToken,
          idToken: idToken || undefined,
          expiresIn: parseInt(expiresIn || '300', 10),
          tokenType: params.get('token_type') || 'Bearer',
        });
        startProactiveRefresh();
        window.history.replaceState(null, '', '/signup');
        toast.success('Account created');
        router.push('/dashboard');
        return;
      }
    }

    const emailParam = searchParams.get('email');
    if (emailParam) {
      setForm((prev) => ({ ...prev, email: emailParam }));
    }

    const planParam = searchParams.get('plan');
    if (planParam) {
      setSelectedPlan(planParam);
    }

    api.auth.getOAuthProviders()
      .then((data) => { if (data.providers.length > 0) setProviders(data.providers); })
      .catch(() => {});

    api.billing
      .plans()
      .then((dbPlans) => {
        const mappedPlans: SignupPlan[] = dbPlans.map((plan: any) => ({
          name: plan.name,
          label: plan.displayName || plan.name,
          price: formatPlanPrice(plan.priceMonthly ?? 0),
          desc: formatPlanDescription(plan),
        }));
        if (mappedPlans.length > 0) {
          setPlans(mappedPlans);
          if (!mappedPlans.some((p) => p.name === selectedPlan)) {
            const fallbackSelected =
              mappedPlans.find((p) => p.name === planParam)?.name ||
              mappedPlans[0].name;
            setSelectedPlan(fallbackSelected);
          }
        }
      })
      .catch(() => {});
  }, [searchParams, router]);

  function update(field: string, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const result = await api.auth.signup({ ...form, planName: selectedPlan });
      setTokens(result);
      toast.success('Account created');

      if (result.hasPendingInvites) {
        toast.info('You have pending team invites!');
        router.push('/dashboard/team');
      } else if (selectedPlan !== 'free') {
        toast.info(`You're on the ${selectedPlan.charAt(0).toUpperCase() + selectedPlan.slice(1)} plan. Add a payment method to keep it active.`);
        router.push('/dashboard/billing');
      } else {
        router.push('/dashboard');
      }
    } catch (err: any) {
      toast.error(err.message || 'Signup failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleOAuthSignup(provider: string) {
    setOauthLoading(provider);
    try {
      const { url } = await api.auth.getOAuthRedirect(provider, window.location.origin + '/signup');
      window.location.href = url;
    } catch (err: any) {
      toast.error(err.message || `${provider} signup failed`);
      setOauthLoading(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/40 py-8">
      <div className="w-full max-w-lg space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        <div className="flex flex-col items-center gap-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Database className="h-6 w-6" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Kolaybase</h1>
          <p className="text-sm text-muted-foreground">
            Create your account
          </p>
        </div>

        {/* Plan Selection */}
        <div className="space-y-2">
          <label className="text-sm font-medium">Choose a plan</label>
          <div className="grid grid-cols-3 gap-2">
            {plans.map((plan) => (
              <button
                key={plan.name}
                type="button"
                onClick={() => setSelectedPlan(plan.name)}
                className={`relative rounded-lg border p-3 text-left transition-all ${
                  selectedPlan === plan.name
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-muted-foreground/40'
                }`}
              >
                {selectedPlan === plan.name && (
                  <Check className="absolute top-2 right-2 h-3.5 w-3.5 text-primary" />
                )}
                <div className="text-sm font-semibold">{plan.label}</div>
                <div className="text-xs font-medium text-primary">{plan.price}</div>
                <div className="mt-1 text-[11px] text-muted-foreground leading-tight">{plan.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {providers.length > 0 && (
          <div className="space-y-2">
            {providers.includes('google') && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={!!oauthLoading}
                onClick={() => handleOAuthSignup('google')}
              >
                {oauthLoading === 'google' ? (
                  <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <GoogleIcon className="mr-2 h-4 w-4" />
                )}
                Continue with Google
              </Button>
            )}
            {providers.includes('github') && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={!!oauthLoading}
                onClick={() => handleOAuthSignup('github')}
              >
                {oauthLoading === 'github' ? (
                  <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <GitHubIcon className="mr-2 h-4 w-4" />
                )}
                Continue with GitHub
              </Button>
            )}

            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-card px-2 text-muted-foreground">or</span>
              </div>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="firstName">First Name</Label>
              <Input
                id="firstName"
                value={form.firstName}
                onChange={(e) => update('firstName', e.target.value)}
                placeholder="John"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="lastName">Last Name</Label>
              <Input
                id="lastName"
                value={form.lastName}
                onChange={(e) => update('lastName', e.target.value)}
                placeholder="Doe"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={form.email}
              onChange={(e) => update('email', e.target.value)}
              placeholder="john@example.com"
              required
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="password">Password</Label>
              <div className="group relative">
                <button
                  type="button"
                  aria-label="Password requirements"
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                >
                  <Info className="h-4 w-4" />
                </button>
                <div className="pointer-events-none invisible absolute left-6 top-1/2 z-20 w-72 -translate-y-1/2 rounded-md border bg-popover p-3 text-xs text-popover-foreground opacity-0 shadow-md transition-all group-hover:visible group-hover:opacity-100">
                  <p className="mb-1 font-medium">Password requirements</p>
                  <ul className="list-disc space-y-0.5 pl-4">
                    <li>At least 8 characters</li>
                    <li>At least one uppercase letter</li>
                    <li>At least one lowercase letter</li>
                    <li>At least one number</li>
                    <li>At least one punctuation/special character</li>
                  </ul>
                </div>
              </div>
            </div>
            <PasswordInput
              id="password"
              value={form.password}
              onChange={(e) => update('password', e.target.value)}
              placeholder="At least 8 characters"
              required
              minLength={8}
            />
          </div>

          <Button type="submit" className="w-full" disabled={loading}>
            {loading ? 'Creating account...' : 'Sign up'}
          </Button>
        </form>

        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
