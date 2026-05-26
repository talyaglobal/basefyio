import type { Metadata } from "next";
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
import { KolaybaseLogo } from "@/components/kolaybase-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { HomeHero } from "@/components/home-hero";
import { HomeMarketing } from "@/components/home-marketing";
import { HomeFaq } from "@/components/home-faq";
import { AuthNav } from "@/components/auth-nav";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import {
  getAppPortalUrl,
  getAppSignupUrl,
  getBillingPlansFetchEndpoints,
} from "@/lib/site-url";

const ogTitle =
  "Kolaybase — PostgreSQL BaaS & REST API for Developers";
const ogDescription =
  "Kolaybase: hosted PostgreSQL, auth, storage, and auto REST API for developers. SDK, CLI, PostgREST-style queries. Ship backends in minutes.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/", {
    openGraph: {
      title: ogTitle,
      description: ogDescription,
    },
  });
}

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
  if (v >= 1_000_000)
    return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
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
  const endpoints = getBillingPlansFetchEndpoints();
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
  const appRoot = getAppPortalUrl();
  const appSignup = getAppSignupUrl();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="fixed left-0 right-0 top-0 z-50 border-b border-border bg-card/80 shadow-sm backdrop-blur-lg transition-all duration-200">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <KolaybaseLogo />
          <nav className="flex items-center gap-6">
            <Link
              href="#pricing"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Pricing
            </Link>
            <Link
              href="#why-kolaybase"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Why us
            </Link>
            <Link
              href="#ai-assistant"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              AI
            </Link>
            <Link
              href="/docs"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Docs
            </Link>
            <Link
              href="#faq"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              FAQ
            </Link>
            <AuthNav appUrl={appRoot} />
            <ThemeToggle />
            <Link
              href={appSignup}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-subtle transition-opacity hover:opacity-90"
            >
              Get Started Free
            </Link>
          </nav>
        </div>
      </header>

      <HomeHero>
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="animate-fade-in text-balance text-4xl font-bold tracking-tight sm:text-5xl md:text-6xl">
            Backend in <span className="gradient-text">minutes</span>, not days
          </h1>
          <p className="animate-fade-in mx-auto mt-6 max-w-2xl text-balance text-center text-lg leading-relaxed text-muted-foreground [animation-delay:120ms] motion-reduce:animate-none">
            Database, authentication, and REST API. Launch your project with
            no-code backend.
          </p>
          <div className="animate-fade-in mt-10 flex flex-col justify-center gap-4 [animation-delay:200ms] motion-reduce:animate-none sm:flex-row">
            <Link
              href={appSignup}
              className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-6 text-base font-semibold text-primary-foreground shadow-subtle transition-all duration-150 hover:opacity-90 active:scale-[0.98]"
            >
              Get Started Free
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              href={appRoot}
              className="inline-flex h-12 items-center justify-center rounded-md border border-border bg-background/80 px-6 text-base font-medium text-foreground backdrop-blur-sm transition-colors duration-150 hover:bg-accent"
            >
              View Demo
            </Link>
          </div>
        </div>
      </HomeHero>

      <section className="relative px-6 pb-20 pt-10 md:pb-24 md:pt-12">
        <div className="absolute inset-0 bg-gradient-radial from-primary/[0.06] via-transparent to-transparent" />
        <div className="relative mx-auto max-w-6xl">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            Everything in one platform
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-center text-muted-foreground">
            Visual table editor, SQL Editor, OAuth, email, and ready-to-use REST
            API. Simplify backend development and database management.
          </p>
          <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
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
                className="group relative rounded-lg border border-border bg-card p-6 shadow-subtle transition-all duration-200 hover:border-primary/35 hover:shadow-soft"
              >
                <div className="flex h-12 w-12 items-center justify-center rounded-md bg-secondary text-primary">
                  <Icon className="h-6 w-6" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm text-muted-foreground">{desc}</p>
                <div className="absolute inset-x-0 bottom-0 h-0.5 rounded-b-lg bg-gradient-to-r from-transparent via-primary to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />
              </div>
            ))}
          </div>
        </div>
      </section>

      <HomeMarketing />

      <section
        id="pricing"
        className="relative overflow-hidden px-6 py-24"
      >
        <div className="absolute inset-0 bg-brand-gradient-subtle" />
        <div className="noise-overlay z-[1] opacity-50" aria-hidden />
        <div className="relative z-10 mx-auto max-w-6xl">
          <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
            Simple, transparent pricing
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-muted-foreground">
            Start free, scale as you grow. No hidden fees.
          </p>

          <div className="mt-16 grid gap-6 lg:grid-cols-3">
            {plans.map((plan) => {
              const featured = plan.name.toLowerCase() === "pro";
              const features = planFeatures(plan);
              return (
                <div
                  key={plan.id}
                  className={`relative flex flex-col rounded-2xl bg-card p-8 shadow-subtle ${
                    featured
                      ? "border-2 border-primary shadow-soft"
                      : "border border-border"
                  }`}
                >
                  {featured && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-primary px-3 py-0.5 text-xs font-medium text-primary-foreground">
                      Most Popular
                    </div>
                  )}
                  <h3 className="text-lg font-semibold">{plan.displayName}</h3>
                  <div className="mt-4">
                    <span className="text-4xl font-bold">
                      ${(plan.priceMonthly / 100).toFixed(0)}
                    </span>
                    <span className="text-muted-foreground">/mo</span>
                  </div>
                  <p className="mt-3 text-sm text-muted-foreground">
                    {plan.priceMonthly === 0
                      ? "Perfect for hobby projects and learning."
                      : "Scale your project with higher limits and resources."}
                  </p>
                  <ul className="mt-6 flex-1 space-y-3 text-sm">
                    {features.map((f) => (
                      <li key={f} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                        <span className="text-muted-foreground">{f}</span>
                      </li>
                    ))}
                  </ul>
                  <Link
                    href={`${appSignup}?plan=${encodeURIComponent(plan.name)}`}
                    className={`mt-8 inline-flex items-center justify-center rounded-xl px-6 py-3 text-sm transition-colors ${
                      featured
                        ? "bg-primary font-semibold text-primary-foreground shadow-subtle hover:opacity-90"
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

      <HomeFaq />

      <footer className="border-t border-border px-6 py-16">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 sm:grid-cols-4">
          <div>
            <span className="text-sm font-semibold text-foreground">
              Product
            </span>
            <ul className="mt-3 space-y-2">
              <li>
                <Link
                  href={appRoot}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Dashboard
                </Link>
              </li>
              <li>
                <Link
                  href="#pricing"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Pricing
                </Link>
              </li>
              <li>
                <Link
                  href="#why-kolaybase"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Why Kolaybase
                </Link>
              </li>
              <li>
                <Link
                  href="#ai-assistant"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  AI assistant
                </Link>
              </li>
              <li>
                <Link
                  href={appSignup}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Sign Up
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <span className="text-sm font-semibold text-foreground">Docs</span>
            <ul className="mt-3 space-y-2">
              <li>
                <Link
                  href="/docs/api"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  API Reference
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/sdk"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  SDK
                </Link>
              </li>
              <li>
                <Link
                  href="/docs/cli"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  CLI
                </Link>
              </li>
            </ul>
          </div>
          <div>
            <span className="text-sm font-semibold text-foreground">
              Resources
            </span>
            <ul className="mt-3 space-y-2">
              <li>
                <Link
                  href="/docs"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Documentation
                </Link>
              </li>
              <li>
                <Link
                  href="/blog"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Blog
                </Link>
              </li>
              <li>
                <Link
                  href="/compare"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Compare
                </Link>
              </li>
              <li>
                <Link
                  href="/use-cases"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Use cases
                </Link>
              </li>
              <li>
                <Link
                  href="/integrations"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Integrations
                </Link>
              </li>
              <li>
                <Link
                  href="/learn"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  Learn
                </Link>
              </li>
              <li>
                <Link
                  href="#faq"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  FAQ
                </Link>
              </li>
              <li>
                <a
                  href="/llms.txt"
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  llms.txt
                </a>
              </li>
            </ul>
          </div>
          <div>
            <span className="text-sm font-semibold text-foreground">
              Kolaybase
            </span>
            <p className="mt-3 text-sm text-muted-foreground">
              © {new Date().getFullYear()} Kolaybase
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
