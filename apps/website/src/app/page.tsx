import Link from "next/link";
import {
  Database,
  Shield,
  Zap,
  Table2,
  Mail,
  Key,
  ArrowRight,
} from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" className="text-xl font-bold text-primary">
            Kolaybase
          </Link>
          <nav className="flex items-center gap-6">
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
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,hsl(var(--muted)),transparent)]" />
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
      <section className="py-24 px-6">
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
                className="rounded-2xl border border-border bg-card p-6 hover:border-muted-foreground/30 transition-colors"
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

      {/* CTA */}
      <section className="py-24 px-6">
        <div className="mx-auto max-w-4xl rounded-3xl border border-border bg-card p-12 text-center">
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
      <footer className="border-t border-border py-12 px-6">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-6 sm:flex-row">
          <span className="text-sm text-muted-foreground">
            © {new Date().getFullYear()} Kolaybase
          </span>
          <div className="flex gap-8">
            <Link
              href="https://app.kolaybase.com"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              App
            </Link>
            <Link
              href="https://app.kolaybase.com/signup"
              className="text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Sign Up
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
