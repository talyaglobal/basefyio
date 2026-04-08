import Link from "next/link";
import {
  Database,
  Shield,
  Zap,
  Table2,
  Mail,
  Key,
  ArrowRight,
  Check,
} from "lucide-react";

type PublicPlan = {
  id: string;
  name: string;
  displayName: string;
  priceMonthly: number;
  maxProjects: number | null;
  maxStorageBytes: number | string | null;
  maxDbSizeBytes: number | string | null;
  maxTeamMembers: number | null;
  maxApiRequests: number | null;
  maxBandwidthBytes: number | string | null;
  dedicatedDb: boolean;
  dedicatedStorage: boolean;
  isPublic: boolean;
};

function numOrNull(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatBytes(v: number | string | null | undefined): string {
  const n = numOrNull(v);
  if (n === null || n <= 0) return "Unlimited";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = n;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i += 1;
  }
  const fixed = size >= 10 ? size.toFixed(0) : size.toFixed(1);
  return `${fixed} ${units[i]}`;
}

function formatReq(v: number | null | undefined): string {
  if (v === null || v === undefined || v <= 0) return "Unlimited";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}K`;
  return String(v);
}

function planFeatures(plan: PublicPlan): string[] {
  return [
    `${plan.maxProjects ?? "Unlimited"} projects`,
    `${formatBytes(plan.maxStorageBytes)} storage`,
    `${formatBytes(plan.maxDbSizeBytes)} database`,
    `${plan.maxTeamMembers ?? "Unlimited"} team members`,
    `${formatReq(plan.maxApiRequests)} API requests/mo`,
    `${formatBytes(plan.maxBandwidthBytes)} bandwidth/mo`,
    plan.dedicatedDb || plan.dedicatedStorage
      ? "Dedicated infrastructure"
      : "Shared infrastructure",
  ];
}

async function getPublicPlans(): Promise<PublicPlan[]> {
  const bases = [
    process.env.NEXT_PUBLIC_BILLING_API_URL,
    process.env.NEXT_PUBLIC_API_BASE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    "https://app.kolaybase.com",
    "http://platform-api:4000",
    "http://localhost:4000",
  ].filter(Boolean) as string[];
  const endpoints = [
    ...bases.flatMap((base) => [`${base}/api/billing/plans`, `${base}/billing/plans`]),
    "https://app.kolaybase.com/api/proxy/billing/plans",
  ];
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) continue;
      const data = (await res.json()) as PublicPlan[];
      if (Array.isArray(data) && data.length > 0) {
        return data
          .filter((p) => p.isPublic)
          .sort((a, b) => a.priceMonthly - b.priceMonthly);
      }
    } catch {
      // Try next endpoint
    }
  }

  return [];
}

export default async function Home() {
  const plans = await getPublicPlans();
  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-card/95 backdrop-blur-sm shadow-sm">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-brand-gradient text-white shadow-md">
              <Database className="h-4 w-4" />
            </div>
            <span className="text-lg font-bold gradient-text">Kolaybase</span>
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              href="#pricing"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Pricing
            </Link>
            <Link
              href="/docs"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Docs
            </Link>
            <Link
              href="https://app.kolaybase.com"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign In
            </Link>
            <Link
              href="https://app.kolaybase.com/signup"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Get Started Free
            </Link>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden pt-32 pb-24 px-6">
        <div className="absolute inset-0 bg-brand-gradient-subtle" />
        <div className="relative mx-auto max-w-4xl text-center">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
            Backend in{" "}
            <span className="text-primary">minutes</span>, not days
          </h1>
          <p className="mt-6 text-lg text-muted-foreground max-w-2xl mx-auto">
            Database, authentication, and REST API. Launch your project
            with no-code backend.
          </p>
          <div className="mt-10 flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              href="https://app.kolaybase.com/signup"
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3.5 text-base font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Get Started Free
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href="https://app.kolaybase.com"
              className="inline-flex items-center justify-center rounded-xl border border-border px-6 py-3.5 text-base font-medium text-foreground hover:bg-accent transition-colors"
            >
              View Demo
            </Link>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="py-24 px-6 bg-background">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-3xl font-bold sm:text-4xl">
            Everything in one platform
          </h2>
          <p className="mt-4 text-center text-muted-foreground max-w-xl mx-auto">
            Visual table editor, OAuth, email, and ready-to-use REST API.
            Simplify backend development.
          </p>
          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[
              {
                icon: Database,
                title: "Visual Database",
                desc: "Create tables and columns with drag-and-drop. Define foreign key relationships easily.",
              },
              {
                icon: Shield,
                title: "Authentication",
                desc: "Email/password, Google and GitHub OAuth. Project-level OAuth settings.",
              },
              {
                icon: Zap,
                title: "Auto REST API",
                desc: "CRUD endpoints generated for every table. Integrate with our SDK.",
              },
              {
                icon: Table2,
                title: "Table Editor",
                desc: "Relations, indexes, and validations managed from a single screen.",
              },
              {
                icon: Mail,
                title: "Email Integration",
                desc: "Resend, SendGrid, SES or custom SMTP for verification and notification emails.",
              },
              {
                icon: Key,
                title: "API Keys",
                desc: "Project-based API keys for secure access control.",
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div
                key={title}
                className="rounded-2xl border border-border bg-card p-6 hover:border-primary/40 transition-colors shadow-sm"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-secondary text-primary">
                  <Icon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-24 px-6 bg-brand-gradient-subtle">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center text-3xl font-bold sm:text-4xl">
            Simple, transparent pricing
          </h2>
          <p className="mt-4 text-center text-muted-foreground max-w-xl mx-auto">
            Start free, scale as you grow. No hidden fees.
          </p>

          <div className="mt-16 grid gap-6 lg:grid-cols-3">
            {plans.map((plan) => {
              const featured = plan.name.toLowerCase() === "pro";
              const features = planFeatures(plan);
              return (
                <div
                  key={plan.id}
                  className={`rounded-2xl bg-card p-8 flex flex-col relative shadow-sm ${
                    featured ? "border-2 border-primary" : "border border-border"
                  }`}
                >
                  {featured && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground">
                      Most Popular
                    </div>
                  )}
                  <h3 className="text-lg font-semibold">{plan.displayName}</h3>
                  <div className="mt-4">
                    <span className="text-4xl font-bold">${(plan.priceMonthly / 100).toFixed(0)}</span>
                    <span className="text-muted-foreground">/mo</span>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">
                    {plan.priceMonthly === 0
                      ? "Perfect for hobby projects and learning."
                      : "Scale your project with higher limits and resources."}
                  </p>
                  <ul className="mt-6 space-y-3 text-sm flex-1">
                    {features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Check className="h-4 w-4 text-primary mt-0.5 shrink-0" />
                        <span className="text-muted-foreground">{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={`https://app.kolaybase.com/signup?plan=${encodeURIComponent(plan.name)}`}
                    className={`mt-8 inline-flex items-center justify-center rounded-xl px-6 py-3 text-sm transition-colors ${
                      featured
                        ? "bg-primary font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
                        : "border border-border font-medium text-foreground hover:bg-accent"
                    }`}
                  >
                    {plan.priceMonthly === 0
                      ? "Get Started Free"
                      : `Get Started with ${plan.displayName}`}
                  </Link>
                </div>
              );
            })}
            {plans.length === 0 && (
              <div className="rounded-2xl border border-border bg-card p-8 text-sm text-muted-foreground lg:col-span-3">
                Pricing plans are temporarily unavailable.
              </div>
            )}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="mx-auto max-w-4xl rounded-3xl border border-primary/30 bg-brand-gradient-subtle p-12 text-center shadow-sm">
          <h2 className="text-2xl font-bold sm:text-3xl">
            Get started for free
          </h2>
          <p className="mt-4 text-muted-foreground">
            Create an account, set up your first project, and start using
            your API in minutes.
          </p>
          <Link
            href="https://app.kolaybase.com/signup"
            className="mt-8 inline-flex items-center gap-2 rounded-xl bg-primary px-8 py-4 text-base font-semibold text-primary-foreground hover:opacity-90 transition-opacity"
          >
            Get Started Free
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-16 px-6">
        <div className="mx-auto max-w-6xl grid grid-cols-2 sm:grid-cols-4 gap-8">
          <div>
            <span className="text-sm font-semibold text-foreground">Product</span>
            <ul className="mt-3 space-y-2">
              <li><Link href="https://app.kolaybase.com" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Dashboard</Link></li>
              <li><Link href="#pricing" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Pricing</Link></li>
              <li><Link href="https://app.kolaybase.com/signup" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Sign Up</Link></li>
            </ul>
          </div>
          <div>
            <span className="text-sm font-semibold text-foreground">Docs</span>
            <ul className="mt-3 space-y-2">
              <li><Link href="/docs/api" className="text-sm text-muted-foreground hover:text-foreground transition-colors">API Reference</Link></li>
              <li><Link href="/docs/sdk" className="text-sm text-muted-foreground hover:text-foreground transition-colors">SDK</Link></li>
              <li><Link href="/docs/cli" className="text-sm text-muted-foreground hover:text-foreground transition-colors">CLI</Link></li>
            </ul>
          </div>
          <div>
            <span className="text-sm font-semibold text-foreground">Resources</span>
            <ul className="mt-3 space-y-2">
              <li><Link href="/docs" className="text-sm text-muted-foreground hover:text-foreground transition-colors">Documentation</Link></li>
            </ul>
          </div>
          <div>
            <span className="text-sm font-semibold text-foreground">Kolaybase</span>
            <p className="mt-3 text-sm text-muted-foreground">
              © {new Date().getFullYear()} Kolaybase
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
