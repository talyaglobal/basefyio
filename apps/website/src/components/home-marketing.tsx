import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Check,
  Code2,
  Globe2,
  Layers,
  LayoutDashboard,
  MessageSquare,
  PackageOpen,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { getAppSignupUrl } from "@/lib/site-url";

const frameworks = [
  "React",
  "Next.js",
  "Vue",
  "Nuxt",
  "Svelte",
  "Angular",
  "Flutter",
  "React Native",
  "Expo",
  "Node",
  "Python",
  "Go",
] as const;

const audienceBadges = ["SaaS", "Internal tools", "Mobile apps", "AI products"] as const;

export function HomeMarketing() {
  return (
    <>
      {/* Social proof strip */}
      <section
        className="relative border-y border-border px-6 py-12 md:py-14"
        aria-labelledby="trusted-heading"
      >
        <div className="absolute inset-0 bg-brand-gradient-subtle" aria-hidden />
        <div className="noise-overlay z-[1] opacity-40" aria-hidden />
        <div className="relative z-10 mx-auto max-w-6xl">
          <Card className="overflow-hidden border-primary/15 bg-card/80 shadow-medium backdrop-blur-sm">
            <CardHeader className="pb-4 text-center md:pb-6">
              <Badge variant="accent" className="mx-auto w-fit gap-1.5 px-3 py-1">
                <Sparkles className="h-3 w-3" />
                Teams that ship
              </Badge>
              <CardTitle
                id="trusted-heading"
                className="mx-auto max-w-2xl pt-2 text-xl font-bold tracking-tight sm:text-2xl"
              >
                Built for speed without the ceremony
              </CardTitle>
              <CardDescription className="mx-auto max-w-2xl text-base">
                Product teams, agencies, and indie builders use Kolaybase to ship
                backends without babysitting infrastructure—or drowning in
                config.
              </CardDescription>
            </CardHeader>
            <CardFooter className="flex flex-wrap justify-center gap-2 py-6 md:gap-3">
              {audienceBadges.map((label) => (
                <Badge key={label} variant="secondary" className="px-3 py-1">
                  {label}
                </Badge>
              ))}
            </CardFooter>
          </Card>
        </div>
      </section>

      {/* Competitive angle */}
      <section
        className="relative px-6 py-16 md:py-24"
        id="why-kolaybase"
      >
        <div className="absolute inset-0 bg-gradient-radial from-primary/[0.06] via-transparent to-transparent" />
        <div className="relative mx-auto max-w-6xl">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="outline" className="mb-4">
              Why Kolaybase
            </Badge>
            <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
              Ship today—not after you finish the &quot;getting started&quot;
              novel
            </h2>
            <p className="mt-5 text-lg text-muted-foreground">
              Plenty of backends hand you raw database power—then a homework
              list: wire auth, stitch APIs, learn policy syntax, and only then
              build your product. Kolaybase flips that:{" "}
              <span className="font-medium text-foreground">
                tables, auth, and REST are ready in the dashboard
              </span>
              , so your weekend goes to the product—not the plumbing.
            </p>
          </div>
          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {[
              {
                icon: Zap,
                title: "No config marathons",
                body: "Visual modeling and sane defaults beat copy-pasting boilerplate from a dozen starter repos.",
              },
              {
                icon: Layers,
                title: "One platform, actually integrated",
                body: "Database, auth, and APIs live together—not as three tabs and a prayer.",
              },
              {
                icon: Sparkles,
                title: "No-code where it helps",
                body: "Skip the ceremony when you want speed. Drop to SQL or code when you want control.",
              },
            ].map(({ icon: Icon, title, body }) => (
              <Card
                key={title}
                className="group border-border/80 transition-all duration-200 hover:border-primary/35 hover:shadow-soft"
              >
                <CardHeader>
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/20 transition-colors group-hover:bg-primary/15">
                    <Icon className="h-6 w-6" />
                  </div>
                  <CardTitle className="text-lg">{title}</CardTitle>
                  <CardDescription className="text-base leading-relaxed">
                    {body}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </div>
      </section>

      {/* AI assistant */}
      <section
        className="border-t border-border px-6 py-16 md:py-24"
        id="ai-assistant"
      >
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-stretch lg:gap-12">
            <div className="flex flex-col justify-center">
              <Badge variant="accent" className="w-fit gap-1.5 px-3 py-1">
                <Wand2 className="h-3.5 w-3.5" />
                Intelligent assistant
              </Badge>
              <h2 className="mt-4 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
                Chat with your project—not just your tables
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                Kolaybase includes a smart AI that understands your schema and
                project context. Ask in plain language: explore relationships,
                catch risky patterns, get migration ideas, or summarize how your
                API surface maps to the database—without exporting diagrams or
                pasting SQL into a generic chatbot.
              </p>
              <ul className="mt-8 space-y-3 text-sm">
                {[
                  "Natural-language Q&A over your data model and REST surface",
                  "Suggestions for indexes, relations, and consistency checks",
                  "Faster onboarding: new teammates ask the assistant instead of spelunking docs",
                ].map((item) => (
                  <li key={item} className="flex gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                      <Check className="h-3 w-3" />
                    </span>
                    <span className="text-muted-foreground">{item}</span>
                  </li>
                ))}
              </ul>
            </div>

            <Card className="flex flex-col overflow-hidden border-primary/20 bg-gradient-to-b from-card to-muted/20 shadow-medium">
              <CardHeader className="space-y-1 border-b border-border bg-muted/30 pb-4">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-subtle">
                    <Bot className="h-4 w-4" />
                  </div>
                  Project assistant
                  <Badge variant="secondary" className="ml-auto text-[10px] uppercase">
                    Live context
                  </Badge>
                </div>
                <CardDescription>
                  Example conversation—your real project stays private.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3 pt-6">
                <div className="flex gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="rounded-2xl rounded-tl-sm border border-border bg-background px-4 py-3 text-sm shadow-subtle">
                    Which tables reference{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">
                      users.id
                    </code>{" "}
                    and are missing an index on the FK?
                  </div>
                </div>
                <div className="flex gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15">
                    <Sparkles className="h-4 w-4 text-primary" />
                  </div>
                  <div className="rounded-2xl rounded-tl-sm border border-primary/20 bg-primary/5 px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">
                      Found 2 inbound FKs:
                    </span>{" "}
                    <code className="rounded bg-muted/80 px-1 font-mono text-xs">
                      orders.customer_id
                    </code>
                    ,{" "}
                    <code className="rounded bg-muted/80 px-1 font-mono text-xs">
                      sessions.user_id
                    </code>
                    . Neither has a covering index—want suggested{" "}
                    <code className="rounded bg-muted/80 px-1 font-mono text-xs">
                      CREATE INDEX
                    </code>{" "}
                    statements?
                  </div>
                </div>
                <div className="flex gap-2">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                    <MessageSquare className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="rounded-2xl rounded-tl-sm border border-border bg-background px-4 py-3 text-sm shadow-subtle">
                    Yes—optimize for our read-heavy dashboard queries.
                  </div>
                </div>
              </CardContent>
              <CardFooter className="border-t border-border bg-muted/20 py-4">
                <p className="text-xs text-muted-foreground">
                  The assistant reasons over your project context in the
                  dashboard—so answers stay relevant to{" "}
                  <span className="font-medium text-foreground">your</span>{" "}
                  schema, not generic Postgres trivia.
                </p>
              </CardFooter>
            </Card>
          </div>
        </div>
      </section>

      {/* REST API engine */}
      <section className="border-t border-border px-6 py-16 md:py-24" id="rest-engine">
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-center lg:gap-16">
            <div>
              <Badge variant="outline" className="mb-4 gap-1.5">
                <Code2 className="h-3.5 w-3.5" />
                API Engine
              </Badge>
              <h2 className="mt-2 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
                PostgREST-compatible syntax.{" "}
                <span className="gradient-text">Multi-tenant engine.</span>
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                We use the same query syntax developers already know from PostgREST
                — filters, ordering, pagination, column selection — but built on our
                own engine designed for multi-tenant isolation from day one. Every
                project gets its own database, its own connection pool, and
                automatic Row-Level Security — without spinning up extra containers
                or paying per-instance costs.
              </p>
              <ul className="mt-8 space-y-3 text-sm">
                {[
                  "Familiar PostgREST filter syntax: eq, neq, gt, lt, ilike, in, is",
                  "Per-project database isolation — not shared schemas",
                  "Automatic RLS enforcement with API key + JWT context",
                  "Built-in connection pooling — no extra PgBouncer setup",
                  "Zero extra containers: one platform serves all projects",
                ].map((item) => (
                  <li key={item} className="flex gap-3">
                    <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
                      <Check className="h-3 w-3" />
                    </span>
                    <span className="text-muted-foreground">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Card className="overflow-hidden border-border/80 bg-gradient-to-b from-card to-muted/20 shadow-medium">
              <CardHeader className="border-b border-border bg-muted/30 pb-4">
                <div className="flex items-center gap-2">
                  <div className="flex h-3 w-3 rounded-full bg-red-400/80" />
                  <div className="flex h-3 w-3 rounded-full bg-yellow-400/80" />
                  <div className="flex h-3 w-3 rounded-full bg-green-400/80" />
                  <span className="ml-2 text-xs text-muted-foreground font-mono">
                    terminal
                  </span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <pre className="overflow-x-auto p-5 text-[13px] leading-relaxed">
                  <code className="text-muted-foreground">
                    <span className="text-emerald-500">GET</span>{" "}
                    <span className="text-foreground">/rest/v1/products</span>
                    {"\n"}
                    {"  "}?select=id,name,price{"\n"}
                    {"  "}&amp;category=eq.electronics{"\n"}
                    {"  "}&amp;price=lt.500{"\n"}
                    {"  "}&amp;order=price.asc{"\n"}
                    {"  "}&amp;limit=20{"\n\n"}
                    <span className="text-muted-foreground/60">
                      {"// "}Same syntax you know.{"\n"}
                      {"// "}Multi-tenant isolation you need.{"\n"}
                      {"// "}Zero extra infrastructure.
                    </span>
                  </code>
                </pre>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Framework row */}
      <section className="border-t border-border bg-muted/15 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <Card className="border-border/80 bg-card/90 shadow-soft">
            <CardHeader className="text-center">
              <Badge variant="outline" className="mx-auto">
                Any client stack
              </Badge>
              <CardTitle className="pt-2 text-2xl sm:text-3xl md:text-4xl">
                Use Kolaybase with{" "}
                <span className="gradient-text">any framework</span>
              </CardTitle>
              <CardDescription className="mx-auto max-w-2xl text-base">
                Your frontend stays yours. Kolaybase speaks HTTP and standards—no
                lock-in to a single client stack or vendor SDK religion.
              </CardDescription>
            </CardHeader>
            <CardContent className="pb-8">
              <div className="flex flex-wrap justify-center gap-2 md:gap-2.5">
                {frameworks.map((name) => (
                  <Badge
                    key={name}
                    variant="secondary"
                    className={cn(
                      "cursor-default px-4 py-2 text-sm font-medium transition-colors",
                      "hover:border-primary/30 hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {name}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </section>

      {/* Platform line */}
      <section className="border-t border-border px-6 py-16 md:py-24">
        <div className="mx-auto max-w-5xl">
          <Card className="overflow-hidden border-primary/15 bg-gradient-to-br from-muted/40 via-card to-card shadow-soft">
            <CardHeader className="text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/25">
                <Globe2 className="h-7 w-7 text-primary" aria-hidden />
              </div>
              <CardTitle className="mt-4 text-balance text-2xl sm:text-3xl md:text-4xl">
                Pick one piece—or run the full stack.
              </CardTitle>
              <CardDescription className="mx-auto max-w-2xl text-base text-muted-foreground">
                <span className="font-medium text-foreground">
                  Best-of-breed pieces, one coherent platform.
                </span>{" "}
                Some tools make you assemble five products and pretend it&apos;s
                &quot;seamless.&quot; Kolaybase is built as a single product:
                database, auth, APIs, and the dashboard experience match—without
                the franken-stack tax.
              </CardDescription>
            </CardHeader>
          </Card>
        </div>
      </section>

      {/* Dashboard productivity */}
      <section className="border-t border-border bg-muted/10 px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-12 lg:grid-cols-2 lg:items-center lg:gap-16">
            <div>
              <Badge variant="secondary" className="gap-1.5">
                <LayoutDashboard className="h-3.5 w-3.5" />
                Stay in one place
              </Badge>
              <h2 className="mt-4 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
                Manage tables, security, and APIs—without a terminal tour
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                Other dashboards love showing you SQL editors and policy
                editors first. Useful for experts—exhausting when you just need
                CRUD and sane defaults. Kolaybase keeps the power, trims the
                busywork.
              </p>
              <Separator className="my-8" />
              <ul className="space-y-4 text-sm">
                {[
                  "Full CRUD from the table editor—spreadsheet-simple when you want it",
                  "Auth and project settings where you expect them—not scattered across tabs",
                  "Security you can grow into—without writing a policy novella on day one",
                ].map((item) => (
                  <li key={item} className="flex gap-3">
                    <Check className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
                    <span className="text-muted-foreground">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
            <Card className="shadow-medium">
              <CardHeader className="pb-4">
                <div className="flex flex-wrap gap-2">
                  {["Table editor", "SQL when you need it", "API & keys"].map(
                    (tab, i) => (
                      <Badge
                        key={tab}
                        variant={i === 0 ? "default" : "secondary"}
                        className="px-3 py-1.5"
                      >
                        {tab}
                      </Badge>
                    ),
                  )}
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3 rounded-lg border border-dashed border-border bg-muted/40 p-5 text-left">
                  <p className="font-semibold text-foreground">Create table</p>
                  <p className="text-sm text-muted-foreground">
                    Name columns, set types, link relations—then hit save. Your
                    REST surface updates automatically.
                  </p>
                  <Separator />
                  <p className="text-xs text-muted-foreground">
                    No deploy step for the backend. No &quot;functions
                    deploy&quot; detour before your first row.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Starter kit + CTA */}
      <section className="border-t border-border px-6 py-16 md:py-24">
        <div className="mx-auto max-w-6xl">
          <Card className="overflow-hidden border-primary/25 bg-gradient-to-br from-primary/[0.12] via-card to-card shadow-medium">
            <div className="noise-overlay opacity-30" aria-hidden />
            <div className="relative grid gap-10 p-8 md:grid-cols-2 md:items-center md:gap-12 md:p-12">
              <div>
                <div className="flex items-center gap-2 text-primary">
                  <div className="rounded-lg bg-primary/15 p-2 ring-1 ring-primary/25">
                    <PackageOpen className="h-5 w-5" />
                  </div>
                  <span className="text-sm font-semibold uppercase tracking-wide">
                    Skip the starter-kit merry-go-round
                  </span>
                </div>
                <h2 className="mt-4 text-balance text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">
                  Start in seconds—without cloning someone else&apos;s repo
                </h2>
                <p className="mt-4 text-lg text-muted-foreground">
                  Templates are fine until you&apos;re maintaining four services
                  just to get auth and a table. Kolaybase is the backend: sign
                  up, model data, call APIs. Less glue code, fewer
                  &quot;works on my machine&quot; deploy stories.
                </p>
                <div className="mt-8 flex flex-wrap gap-3">
                  <Link
                    href={getAppSignupUrl()}
                    className={buttonVariants({ size: "lg" })}
                  >
                    Create your backend
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/docs"
                    className={buttonVariants({ variant: "outline", size: "lg" })}
                  >
                    Read the docs
                  </Link>
                </div>
              </div>
              <Card className="border-border/80 bg-background/90 shadow-subtle backdrop-blur-sm">
                <CardHeader>
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Code2 className="h-4 w-4 text-primary" />
                    What you&apos;re not doing
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  <p className="flex gap-2">
                    <span className="text-primary/60">—</span>
                    Stitching OAuth, DB, and API layers from separate tutorials
                  </p>
                  <p className="flex gap-2">
                    <span className="text-primary/60">—</span>
                    Debugging env files across three deployment targets
                  </p>
                  <p className="flex gap-2">
                    <span className="text-primary/60">—</span>
                    Shipping your product last because the backend
                    &quot;almost&quot; works
                  </p>
                </CardContent>
              </Card>
            </div>
          </Card>
        </div>
      </section>
    </>
  );
}
