import Link from "next/link";
import { Book, Code, Terminal, Server } from "lucide-react";

const nav = [
  { href: "/docs", label: "Overview", icon: Book },
  { href: "/docs/api", label: "API Reference", icon: Server },
  { href: "/docs/sdk", label: "SDK", icon: Code },
  { href: "/docs/cli", label: "CLI", icon: Terminal },
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen pt-16">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-xl font-bold text-primary">
              Kolaybase
            </Link>
            <span className="text-sm text-muted-foreground">/</span>
            <Link href="/docs" className="text-sm font-medium text-foreground hover:text-primary transition-colors">
              Docs
            </Link>
          </div>
          <nav className="flex items-center gap-4">
            <Link
              href="https://app.kolaybase.com"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Dashboard
            </Link>
            <Link
              href="https://app.kolaybase.com/signup"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 transition-opacity"
            >
              Get Started
            </Link>
          </nav>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl px-6">
        {/* Sidebar */}
        <aside className="hidden md:block w-56 shrink-0 border-r border-border pr-6 py-8 sticky top-16 h-[calc(100vh-4rem)] overflow-y-auto">
          <nav className="space-y-1">
            {nav.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
              >
                <Icon className="h-4 w-4" />
                {label}
              </Link>
            ))}
          </nav>
        </aside>

        {/* Content */}
        <main className="flex-1 min-w-0 py-8 pl-0 md:pl-8">
          <article className="prose prose-invert max-w-none
            [&_h1]:text-3xl [&_h1]:font-bold [&_h1]:tracking-tight [&_h1]:mb-4
            [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:mt-12 [&_h2]:mb-4 [&_h2]:border-b [&_h2]:border-border [&_h2]:pb-2
            [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:mt-8 [&_h3]:mb-3
            [&_p]:text-muted-foreground [&_p]:leading-7 [&_p]:mb-4
            [&_code]:bg-secondary [&_code]:text-primary [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-sm
            [&_pre]:bg-secondary [&_pre]:rounded-xl [&_pre]:p-4 [&_pre]:overflow-x-auto [&_pre]:mb-6
            [&_pre_code]:bg-transparent [&_pre_code]:p-0
            [&_table]:w-full [&_table]:text-sm [&_table]:mb-6
            [&_th]:text-left [&_th]:text-muted-foreground [&_th]:font-medium [&_th]:p-3 [&_th]:border-b [&_th]:border-border
            [&_td]:p-3 [&_td]:border-b [&_td]:border-border [&_td]:text-muted-foreground
            [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:mb-4 [&_ul]:text-muted-foreground
            [&_li]:mb-1
            [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2
            [&_hr]:border-border [&_hr]:my-8
          ">
            {children}
          </article>
        </main>
      </div>
    </div>
  );
}
