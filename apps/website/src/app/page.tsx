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
import { AdminFooterLink } from "@/components/admin-footer-link";
import { MarketingFeedback } from "@/components/marketing-feedback";
import { HeroIllustration } from "@/components/hero-illustration";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getAppPortalUrl, getAppSignupUrl } from "@/lib/site-url";
import { getPublicPlans } from "@/lib/pricing";
import { PricingSection } from "@/components/pricing-section";

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
              Free plan &middot; no credit card
            </div>
            <h1 className="animate-fade-in text-4xl font-bold uppercase leading-[1.06] tracking-tight [animation-delay:80ms] motion-reduce:animate-none sm:text-5xl md:text-[56px]">
              NEXT-GEN DATABASE.{" "}
              <span className="gradient-text relative">
                EMPOWERS YOUR NEXT IDEA
                <span className="absolute bottom-[-2px] left-0 right-0 h-0.5 rounded bg-primary" />
              </span>
            </h1>
            <div className="animate-fade-in mt-7 max-w-md [animation-delay:160ms] motion-reduce:animate-none">
              <p className="font-mono text-sm text-muted-foreground">
                database &middot; REST API &middot; auth &middot; storage
                &middot; PITR &middot; ai assistant
              </p>
              <p className="mt-2 text-base text-muted-foreground">
                &mdash; create a project and get a dedicated database
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
              {["Free plan", "No credit card", "Cancel anytime"].map(
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
            <HeroIllustration />
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
      <PricingSection plans={plans} signupUrl={appSignup} />

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
          <div className="flex items-center gap-4">
            <AdminFooterLink appUrl={appRoot} />
            <a
              href="/llms.txt"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              llms.txt
            </a>
          </div>
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
