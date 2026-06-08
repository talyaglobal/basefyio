import Link from "next/link";
import { Suspense } from "react";
import { BasefyioLogo } from "@/components/basefyio-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { AuthNav } from "@/components/auth-nav";
import { getAppPortalUrl, getAppSignupUrl } from "@/lib/site-url";

const NAV_LINKS = [
  { href: "/blog", label: "Blog" },
  { href: "/compare", label: "Compare" },
  { href: "/use-cases", label: "Use cases" },
  { href: "/integrations", label: "Integrations" },
  { href: "/learn", label: "Learn" },
  { href: "/docs", label: "Docs" },
];

/**
 * Shared header + footer for content pages (blog, comparisons, use-cases) so the
 * SEO-driven sections share one consistent chrome with the marketing site.
 */
export function SiteShell({ children }: { children: React.ReactNode }) {
  const appUrl = getAppPortalUrl();
  const signupUrl = getAppSignupUrl();

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-8">
            <BasefyioLogo />
            <nav className="hidden items-center gap-6 md:flex">
              {NAV_LINKS.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  {link.label}
                </Link>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <Suspense fallback={null}>
              <AuthNav appUrl={appUrl} />
            </Suspense>
            <Link
              href={signupUrl}
              className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Get started
            </Link>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="flex-1">{children}</main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <BasefyioLogo />
          <nav className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="transition-colors hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
            <Link
              href="/feed.xml"
              className="transition-colors hover:text-foreground"
            >
              RSS
            </Link>
          </nav>
          <p className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} basefyio
          </p>
        </div>
      </footer>
    </div>
  );
}
