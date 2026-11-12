import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { BasefyioLogo } from "@/components/basefyio-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { AuthNav, isSignedIn } from "@/components/auth-nav";
import { CodeCopyButtons } from "@/components/code-copy-buttons";
import { DocsNav } from "./docs-nav";
import { DocsSearch } from "./docs-search";
import { DocsMobileNav } from "./docs-mobile-nav";
import { getAppPortalUrl, getAppSignupUrl } from "@/lib/site-url";
import { DOCS_OG_IMAGE } from "./docs-metadata";

const docsDescription =
  "basefyio documentation: create a project in the cloud, then use its database, auth, storage, REST API, SDK and CLI. Self-hosting guide included.";

export const metadata: Metadata = {
  title: {
    template: "%s | basefyio Docs",
    default: "Documentation | basefyio Docs",
  },
  description: docsDescription,
  openGraph: {
    type: "article",
    siteName: "basefyio",
    title: "Documentation | basefyio Docs",
    description: docsDescription,
    images: [{ url: DOCS_OG_IMAGE, width: 1200, height: 630, alt: "basefyio Docs" }],
  },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const appRoot = getAppPortalUrl();
  const appSignup = getAppSignupUrl();

  return (
    <div className="min-h-screen pt-16">
      <header className="fixed left-0 right-0 top-0 z-50 border-b border-border bg-card/80 shadow-sm backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-2 sm:gap-6">
            <DocsMobileNav>
              <Suspense fallback={null}>
                <AuthNav appUrl={appRoot} />
              </Suspense>
            </DocsMobileNav>
            <BasefyioLogo href="/" />
            <span className="hidden text-sm text-muted-foreground sm:inline">/</span>
            <Link
              href="/docs"
              className="hidden text-sm font-medium text-foreground transition-colors hover:text-primary sm:inline"
            >
              Docs
            </Link>
          </div>
          <nav className="flex shrink-0 items-center gap-2 sm:gap-4" aria-label="Account">
            <span className="hidden sm:inline-flex">
              <Suspense fallback={null}>
                <AuthNav appUrl={appRoot} />
              </Suspense>
            </span>
            <ThemeToggle />
            <Suspense fallback={null}>
              <DocsHeaderCta signupUrl={appSignup} />
            </Suspense>
          </nav>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl px-4 sm:px-6">
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-56 shrink-0 overflow-y-auto border-r border-border py-8 pr-6 md:block">
          <DocsSearch />
          <DocsNav />
        </aside>

        <main className="min-w-0 flex-1 py-8 pl-0 md:pl-8">
          <article
            data-docs-article
            className="prose prose-neutral max-w-none dark:prose-invert
            [&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight
            [&_h2]:mt-12 [&_h2]:mb-4 [&_h2]:border-b [&_h2]:pb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:border-border
            [&_h3]:mt-8 [&_h3]:mb-3 [&_h3]:text-lg [&_h3]:font-semibold
            [&_p]:mb-4 [&_p]:leading-7 [&_p]:text-muted-foreground
            [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-sm [&_code]:text-primary [&_code]:break-words
            [&_pre]:mb-6 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-secondary [&_pre]:p-4
            [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:break-normal
            [&_.docs-table]:mb-6 [&_.docs-table]:max-w-full [&_.docs-table]:overflow-x-auto
            [&_table]:my-0 [&_table]:w-full [&_table]:text-sm
            [&_th]:border-b [&_th]:border-border [&_th]:p-3 [&_th]:text-left [&_th]:font-medium [&_th]:text-muted-foreground
            [&_td]:border-b [&_td]:border-border [&_td]:p-3 [&_td]:text-muted-foreground
            [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:text-muted-foreground
            [&_li]:mb-1
            [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
            [&_hr]:my-8 [&_hr]:border-border
          "
          >
            {children}
          </article>
          <CodeCopyButtons selector="[data-docs-article] pre" />
        </main>
      </div>
    </div>
  );
}

/**
 * The header's call to action. A signed-in visitor already has the Dashboard
 * button from AuthNav, so the CTA steps aside instead of crowding a phone
 * header with two buttons (which pushed it over the logo).
 */
async function DocsHeaderCta({ signupUrl }: { signupUrl: string }) {
  if (await isSignedIn()) return null;

  return (
    <Link
      href={signupUrl}
      className="whitespace-nowrap rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground shadow-subtle transition-opacity hover:opacity-90 sm:px-4"
    >
      Get Started
    </Link>
  );
}
