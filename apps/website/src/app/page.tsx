import type { Metadata } from "next";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  Zap,
} from "lucide-react";
import { BasefyioLogo } from "@/components/basefyio-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { HomeHero } from "@/components/home-hero";
import { HomeMarketing } from "@/components/home-marketing";
import { HomeFaq } from "@/components/home-faq";
import { AuthNav } from "@/components/auth-nav";
import { MarketingFeedback } from "@/components/marketing-feedback";
import { TerminalCard } from "@/components/terminal-card";
import { ScrollReveal } from "@/components/scroll-reveal";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import {
  getAppPortalUrl,
  getAppSignupUrl,
  getBillingPlansFetchEndpoints,
} from "@/lib/site-url";

const ogTitle =
  "basefyio — The Open Source Database Platform";
const ogDescription =
  "basefyio: Managed database with built-in auth, storage, and instant REST API. Create a project, get a database — ready to query in seconds.";

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
      {/* ============ NAV ============ */}
      <header className="fixed left-0 right-0 top-0 z-50 border-b border-transparent bg-transparent backdrop-blur-none transition-all duration-300 [&.scrolled]:border-border [&.scrolled]:bg-card/80 [&.scrolled]:backdrop-blur-lg [&.scrolled]:shadow-sm">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <BasefyioLogo />
          <div className="flex items-center gap-6">
            <Link
              href="#features"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              Features
            </Link>
            <Link
              href="#how"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground md:inline"
            >
              How it works
            </Link>
            <Link
              href="#pricing"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              Pricing
            </Link>
            <Link
              href="/compare"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground lg:inline"
            >
              Compare
            </Link>
            <Link
              href="/use-cases"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground lg:inline"
            >
              Use cases
            </Link>
            <Link
              href="/docs"
              className="hidden text-sm text-muted-foreground transition-colors hover:text-foreground sm:inline"
            >
              Docs
            </Link>
            <AuthNav appUrl={appRoot} />
            <ThemeToggle />
            <HomeNavCta appRoot={appRoot} signupUrl={appSignup} />
          </div>
        </nav>
      </header>

      {/* ============ HERO ============ */}
      <HomeHero>
        <div className="grid items-center gap-10 lg:grid-cols-12 lg:gap-12">
          <div className="text-left lg:col-span-6">
            <div className="landing-pill mb-7 animate-fade-in motion-reduce:animate-none">
              <span className="pulse-dot" />
              30 days free trial
            </div>
            <h1 className="animate-fade-in text-4xl font-bold leading-[1.06] tracking-tight [animation-delay:80ms] motion-reduce:animate-none sm:text-5xl md:text-[56px]">
              Your database,{" "}
              <span className="gradient-text relative">
                instantly.
                <span className="absolute bottom-[-2px] left-0 right-0 h-0.5 rounded bg-primary" />
              </span>
            </h1>
            <div className="animate-fade-in mt-7 max-w-md [animation-delay:160ms] motion-reduce:animate-none">
              <p className="font-mono text-sm text-muted-foreground">
                database &middot; REST API &middot; auth &middot; storage
                &middot; ai assistant
              </p>
              <p className="mt-2 text-base text-muted-foreground">
                &mdash; create a project and get a dedicated PostgreSQL database
                &mdash; relational tables with full SQL, plus an optional document
                store &mdash; with an instant REST API, auth, and storage. Fully
                under your control.
              </p>
            </div>
            <p className="animate-fade-in mt-5 text-[15px] font-semibold text-amber-400 [animation-delay:200ms] motion-reduce:animate-none">
              Built for developers &mdash; and friendly enough for your whole team.
            </p>
            <div className="animate-fade-in mt-8 flex flex-wrap items-center gap-3 [animation-delay:240ms] motion-reduce:animate-none">
              <Link
                href={appSignup}
                className="inline-flex h-12 items-center gap-2 rounded-lg bg-primary px-6 text-base font-bold text-primary-foreground shadow-medium transition-all hover:opacity-90 active:scale-[0.98]"
              >
                <Zap className="h-4 w-4" />
                Start building
                <span className="ml-1 rounded-full bg-primary-foreground/20 px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-primary-foreground">
                  FREE
                </span>
              </Link>
              <Link
                href="/docs"
                className="inline-flex h-12 items-center rounded-lg border border-border px-6 text-base font-medium text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
              >
                Read the docs ↗
              </Link>
            </div>
            <div className="animate-fade-in mt-5 flex flex-wrap gap-5 text-sm text-muted-foreground [animation-delay:300ms] motion-reduce:animate-none">
              {["30-day free trial", "No credit card", "Cancel anytime"].map(
                (t) => (
                  <span key={t} className="flex items-center gap-2">
                    <Check className="h-3 w-3 text-primary" />
                    {t}
                  </span>
                ),
              )}
            </div>
          </div>

          <div className="animate-fade-in lg:col-span-6 [animation-delay:200ms] motion-reduce:animate-none">
            <TerminalCard />
          </div>
        </div>
      </HomeHero>

      {/* ============ PROOF BAR ============ */}
      <div className="proof-bar">
        <div className="mx-auto max-w-6xl px-6">
          <div className="proof-items">
            <span>Dedicated database per project</span>
            <span className="proof-sep">&middot;</span>
            <span>Self-hostable</span>
            <span className="proof-sep">&middot;</span>
            <span>Open Source</span>
            <span className="proof-sep">&middot;</span>
            <span>GDPR-ready</span>
            <span className="proof-sep">&middot;</span>
            <span>Connect from pgAdmin, DBeaver &amp; more</span>
          </div>
        </div>
      </div>

      {/* ============ MARKETING SECTIONS ============ */}
      <HomeMarketing />

      {/* ============ PRICING ============ */}
      <section
        id="pricing"
        className="relative overflow-hidden px-6 py-24"
      >
        <div className="absolute inset-0 bg-brand-gradient-subtle" />
        <div className="noise-overlay z-[1] opacity-50" aria-hidden />
        <div className="relative z-10 mx-auto max-w-6xl">
          <ScrollReveal>
            <span className="section-label text-center block">Pricing</span>
            <h2 className="text-center text-3xl font-bold tracking-tight sm:text-4xl">
              Start free. Scale when you ship.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-center text-muted-foreground">
              Simple, transparent pricing. No hidden fees.
            </p>
          </ScrollReveal>

          <div className="mt-14 grid gap-5 lg:grid-cols-3">
            {plans.map((plan, i) => {
              const featured = plan.name.toLowerCase() === "pro";
              const features = planFeatures(plan);
              return (
                <ScrollReveal key={plan.id} delay={i as 0 | 1 | 2}>
                  <div
                    className={`relative flex h-full flex-col rounded-xl bg-card p-7 shadow-subtle ${
                      featured
                        ? "border-2 border-primary shadow-medium"
                        : "border border-border"
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
                      <span className="text-sm text-muted-foreground">
                        {" "}
                        /mo
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {plan.priceMonthly === 0
                        ? "Free to try"
                        : "14-day trial"}
                    </p>
                    <ul className="mt-6 flex-1 space-y-3 text-sm">
                      {features.map((f) => (
                        <li key={f} className="flex items-start gap-2">
                          <span className="font-mono text-xs text-muted-foreground">
                            +
                          </span>
                          <span className="text-muted-foreground">{f}</span>
                        </li>
                      ))}
                    </ul>
                    <Link
                      href={`${appSignup}?plan=${encodeURIComponent(plan.name)}`}
                      className={`mt-8 inline-flex w-full items-center justify-center rounded-lg px-6 py-3 text-sm font-medium transition-all ${
                        featured
                          ? "bg-primary font-bold text-primary-foreground shadow-subtle hover:opacity-90"
                          : "border border-border text-foreground hover:bg-accent"
                      }`}
                    >
                      {plan.priceMonthly === 0
                        ? "Get started"
                        : `Start trial`}
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
        </div>
      </section>

      {/* ============ FAQ ============ */}
      <HomeFaq />

      {/* ============ FOOTER ============ */}
      <footer className="border-t border-border px-6 py-16">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-8 sm:grid-cols-4">
          <div>
            <BasefyioLogo />
            <p className="mt-4 max-w-[200px] text-xs text-muted-foreground leading-relaxed">
              The database platform for modern teams.
            </p>
          </div>
          <div>
            <span className="section-label mb-4">Product</span>
            <ul className="space-y-2">
              {[
                { href: "#features", label: "Features" },
                { href: "#how", label: "How it works" },
                { href: "#layers", label: "Layers" },
                { href: "#pricing", label: "Pricing" },
                { href: appSignup, label: "Sign Up" },
              ].map((l) => (
                <li key={l.label}>
                  <Link
                    href={l.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <span className="section-label mb-4">Resources</span>
            <ul className="space-y-2">
              {[
                { href: "/docs", label: "Documentation" },
                { href: "/docs/api", label: "API Reference" },
                { href: "/docs/sdk", label: "SDK" },
                { href: "/blog", label: "Blog" },
                { href: "/compare", label: "Compare" },
                { href: "/use-cases", label: "Use cases" },
                { href: "/integrations", label: "Integrations" },
                { href: "/learn", label: "Learn" },
                { href: "#faq", label: "FAQ" },
              ].map((l) => (
                <li key={l.label}>
                  <Link
                    href={l.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <span className="section-label mb-4">Legal</span>
            <ul className="space-y-2">
              {[
                { href: "/privacy", label: "Privacy" },
                { href: "/terms", label: "Terms" },
                { href: "/kvkk", label: "KVKK" },
              ].map((l) => (
                <li key={l.label}>
                  <Link
                    href={l.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div className="mx-auto mt-12 flex max-w-6xl items-center justify-between border-t border-border pt-6">
          <span className="text-xs text-muted-foreground">
            &copy; {new Date().getFullYear()} basefyio
          </span>
          <a
            href="/llms.txt"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            llms.txt
          </a>
        </div>
      </footer>

      {/* Nav scroll behavior */}
      <NavScrollScript />

      <MarketingFeedback appUrl={appRoot} variant="floating" />
    </div>
  );
}

async function HomeNavCta({ appRoot, signupUrl }: { appRoot: string; signupUrl: string }) {
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  const loggedIn = cookieStore.get("bf_logged_in")?.value === "1";

  if (loggedIn) {
    return (
      <Link
        href={`${appRoot}/dashboard`}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-subtle transition-all hover:opacity-90 active:scale-[0.98]"
      >
        Dashboard
      </Link>
    );
  }

  return (
    <Link
      href={signupUrl}
      className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-subtle transition-all hover:opacity-90 active:scale-[0.98]"
    >
      Start free &rarr;
    </Link>
  );
}

function NavScrollScript() {
  return (
    <script
      dangerouslySetInnerHTML={{
        __html: `(function(){
  var nav = document.querySelector('header');
  if (!nav) return;
  function onScroll() {
    if (window.scrollY > 8) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();`,
      }}
    />
  );
}
