import type { Metadata } from "next";
import Link from "next/link";
import { Book, Code, Terminal, Server } from "lucide-react";
import { BasefyioLogo } from "@/components/basefyio-logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { getAppPortalUrl, getAppSignupUrl } from "@/lib/site-url";

const docsDescription =
  "basefyio documentation: PostgreSQL, auth, storage, REST API, SDK, and CLI.";

export const metadata: Metadata = {
  title: {
    template: "%s | basefyio Docs",
    default: "Documentation | basefyio Docs",
  },
  description: docsDescription,
  openGraph: {
    title: "Documentation | basefyio Docs",
    description: docsDescription,
  },
};

const nav = [
  { href: "/docs", label: "Overview", icon: Book },
  { href: "/docs/api", label: "API Reference", icon: Server },
  { href: "/docs/sdk", label: "SDK", icon: Code },
  { href: "/docs/cli", label: "CLI", icon: Terminal },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const appRoot = getAppPortalUrl();
  const appSignup = getAppSignupUrl();

  return (
    <div className="min-h-screen pt-16">
      <header className="fixed left-0 right-0 top-0 z-50 border-b border-border bg-card/80 shadow-sm backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex min-w-0 items-center gap-6">
            <BasefyioLogo href="/" />
            <span className="text-sm text-muted-foreground">/</span>
            <Link
              href="/docs"
              className="text-sm font-medium text-foreground transition-colors hover:text-primary"
            >
              Docs
            </Link>
          </div>
          <nav className="flex items-center gap-4">
            <Link
              href={appRoot}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Dashboard
            </Link>
            <ThemeToggle />
            <Link
              href={appSignup}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-subtle transition-opacity hover:opacity-90"
            >
              Get Started
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl px-6">
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] w-56 shrink-0 overflow-y-auto border-r border-border py-8 pr-6 md:block">
          <nav className="space-y-1">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 py-8 pl-0 md:pl-8">
          <article
            className="prose prose-neutral max-w-none dark:prose-invert
            [&_h1]:mb-4 [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight
            [&_h2]:mt-12 [&_h2]:mb-4 [&_h2]:border-b [&_h2]:pb-2 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:border-border
            [&_h3]:mt-8 [&_h3]:mb-3 [&_h3]:text-lg [&_h3]:font-semibold
            [&_p]:mb-4 [&_p]:leading-7 [&_p]:text-muted-foreground
            [&_code]:rounded [&_code]:bg-secondary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-sm [&_code]:text-primary
            [&_pre]:mb-6 [&_pre]:overflow-x-auto [&_pre]:rounded-xl [&_pre]:bg-secondary [&_pre]:p-4
            [&_pre_code]:bg-transparent [&_pre_code]:p-0
            [&_table]:mb-6 [&_table]:w-full [&_table]:text-sm
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
        </main>
      </div>
    </div>
  );
}
