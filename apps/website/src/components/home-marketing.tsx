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
  Minus,
  PackageOpen,
  Sparkles,
  Wand2,
  X,
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
                Production-ready
              </Badge>
              <CardTitle
                id="trusted-heading"
                className="mx-auto max-w-2xl pt-2 text-xl font-bold tracking-tight sm:text-2xl"
              >
                Enterprise infrastructure, startup speed
              </CardTitle>
              <CardDescription className="mx-auto max-w-2xl text-base">
                Keycloak for auth, PostgreSQL for data, PostgREST-compatible API
                for access — all managed from a single dashboard. Built for
                teams that need compliance-ready infrastructure without the
                setup cost.
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

      {/* PostgREST comparison */}
      <section
        className="relative px-6 py-16 md:py-24"
        id="why-kolaybase"
      >
        <div className="absolute inset-0 bg-gradient-radial from-primary/[0.06] via-transparent to-transparent" />
        <div className="relative mx-auto max-w-6xl">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="outline" className="mb-4">
              Kolaybase vs PostgREST
            </Badge>
            <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl md:text-5xl">
              PostgREST syntax you know.{" "}
              <span className="gradient-text">Platform you need.</span>
            </h2>
            <p className="mt-5 text-lg text-muted-foreground">
              PostgREST is a great tool for single-database REST exposure. But
              when you need multi-tenancy, auth, storage, and a dashboard —
              you end up gluing together 5+ services. Kolaybase gives you the
              same query syntax with everything integrated.
            </p>
          </div>

          {/* Comparison table */}
          <div className="mx-auto mt-14 max-w-4xl overflow-hidden rounded-xl border border-border bg-card shadow-soft">
            <div className="grid grid-cols-[1fr_120px_120px] gap-0 text-sm sm:grid-cols-[1fr_140px_140px]">
              {/* Header */}
              <div className="border-b border-border bg-muted/50 px-5 py-3 font-semibold text-foreground">
                Feature
              </div>
              <div className="border-b border-l border-border bg-muted/50 px-4 py-3 text-center font-semibold text-muted-foreground">
                PostgREST
              </div>
              <div className="border-b border-l border-border bg-primary/5 px-4 py-3 text-center font-semibold text-primary">
                Kolaybase
              </div>
              {/* Rows */}
              {[
                { feature: "PostgREST-compatible query syntax", pg: true, kb: true },
                { feature: "Multi-tenant database isolation", pg: false, kb: true },
                { feature: "Built-in authentication (Keycloak)", pg: false, kb: true },
                { feature: "Automatic RLS with JWT context", pg: "manual", kb: true },
                { feature: "Connection pooling (built-in)", pg: false, kb: true },
                { feature: "Object storage (S3-compatible)", pg: false, kb: true },
                { feature: "Visual schema editor", pg: false, kb: true },
                { feature: "REST API Explorer in dashboard", pg: false, kb: true },
                { feature: "Per-project API keys", pg: false, kb: true },
                { feature: "No extra containers per project", pg: false, kb: true },
              ].map(({ feature, pg, kb }, i) => (
                <div key={feature} className="contents">
                  <div className={cn("px-5 py-3 text-muted-foreground", i % 2 === 0 ? "bg-muted/20" : "")}>
                    {feature}
                  </div>
                  <div className={cn("flex items-center justify-center border-l border-border px-4 py-3", i % 2 === 0 ? "bg-muted/20" : "")}>
                    {pg === true ? (
                      <Check className="h-4 w-4 text-emerald-500" />
                    ) : pg === "manual" ? (
                      <Minus className="h-4 w-4 text-amber-500" />
                    ) : (
                      <X className="h-4 w-4 text-muted-foreground/40" />
                    )}
                  </div>
                  <div className={cn("flex items-center justify-center border-l border-border px-4 py-3", i % 2 === 0 ? "bg-primary/[0.03]" : "bg-primary/[0.01]")}>
                    {kb === true ? (
                      <Check className="h-4 w-4 text-primary" />
                    ) : (
                      <X className="h-4 w-4 text-muted-foreground/40" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p className="mx-auto mt-6 max-w-2xl text-center text-sm text-muted-foreground">
            PostgREST is open-source and excellent at what it does. Kolaybase
            builds on the same query conventions while adding the platform
            layer teams need in production.
          </p>
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

      {/* REST API engine — live examples */}
      <section className="border-t border-border px-6 py-16 md:py-24" id="rest-engine">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-3xl text-center mb-14">
            <Badge variant="outline" className="mb-4 gap-1.5">
              <Code2 className="h-3.5 w-3.5" />
              REST API
            </Badge>
            <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
              Every table is an API endpoint.{" "}
              <span className="gradient-text">Instantly.</span>
            </h2>
            <p className="mt-4 text-lg text-muted-foreground">
              Create a table in the dashboard — a full CRUD REST API is live
              immediately. Standard HTTP, standard JSON, PostgREST-compatible
              filters. No code generation step, no deploy, no waiting.
            </p>
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            {/* SELECT example */}
            <Card className="overflow-hidden border-border/80 shadow-subtle">
              <CardHeader className="border-b border-border bg-muted/30 py-3 px-5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-bold font-mono bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">GET</span>
                  <span className="text-xs text-muted-foreground font-mono">/rest/v1/products</span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
                  <code className="text-muted-foreground">
                    {"curl '/rest/v1/products"}{"\n"}
                    {"  ?select=id,name,price"}{"\n"}
                    {"  &category=eq.electronics"}{"\n"}
                    {"  &price=lt.500"}{"\n"}
                    {"  &order=price.asc&limit=20' \\"}{"\n"}
                    {"  -H \"apikey: YOUR_ANON_KEY\""}
                  </code>
                </pre>
              </CardContent>
            </Card>
            {/* INSERT example */}
            <Card className="overflow-hidden border-border/80 shadow-subtle">
              <CardHeader className="border-b border-border bg-muted/30 py-3 px-5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-bold font-mono bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400">POST</span>
                  <span className="text-xs text-muted-foreground font-mono">/rest/v1/products</span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
                  <code className="text-muted-foreground">
                    {"curl -X POST '/rest/v1/products' \\"}{"\n"}
                    {"  -H \"apikey: YOUR_SERVICE_KEY\" \\"}{"\n"}
                    {"  -H \"Content-Type: application/json\" \\"}{"\n"}
                    {"  -H \"Prefer: return=representation\" \\"}{"\n"}
                    {"  -d '{\"name\": \"Widget\", \"price\": 29.99}'"}
                  </code>
                </pre>
              </CardContent>
            </Card>
            {/* UPDATE example */}
            <Card className="overflow-hidden border-border/80 shadow-subtle">
              <CardHeader className="border-b border-border bg-muted/30 py-3 px-5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-bold font-mono bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400">PATCH</span>
                  <span className="text-xs text-muted-foreground font-mono">/rest/v1/products?id=eq.42</span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
                  <code className="text-muted-foreground">
                    {"curl -X PATCH '/rest/v1/products?id=eq.42' \\"}{"\n"}
                    {"  -H \"apikey: YOUR_SERVICE_KEY\" \\"}{"\n"}
                    {"  -H \"Content-Type: application/json\" \\"}{"\n"}
                    {"  -d '{\"price\": 24.99}'"}
                  </code>
                </pre>
              </CardContent>
            </Card>
            {/* DELETE example */}
            <Card className="overflow-hidden border-border/80 shadow-subtle">
              <CardHeader className="border-b border-border bg-muted/30 py-3 px-5">
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center rounded px-2 py-0.5 text-xs font-bold font-mono bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400">DELETE</span>
                  <span className="text-xs text-muted-foreground font-mono">/rest/v1/products?id=eq.42</span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
                  <code className="text-muted-foreground">
                    {"curl -X DELETE '/rest/v1/products?id=eq.42' \\"}{"\n"}
                    {"  -H \"apikey: YOUR_SERVICE_KEY\""}
                  </code>
                </pre>
              </CardContent>
            </Card>
          </div>
          <p className="mt-8 text-center text-sm text-muted-foreground">
            Full filter reference:{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">eq</code>{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">neq</code>{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">gt</code>{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">gte</code>{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">lt</code>{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">lte</code>{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">like</code>{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">ilike</code>{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">is</code>{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">in</code>
            {" "}— plus <code className="bg-muted px-1.5 py-0.5 rounded text-xs">order</code>,{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">limit</code>,{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">offset</code>,{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">select</code>.
          </p>
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

      {/* CTA */}
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
                    Ready for production
                  </span>
                </div>
                <h2 className="mt-4 text-balance text-2xl font-bold tracking-tight sm:text-3xl md:text-4xl">
                  From prototype to production — on one platform
                </h2>
                <p className="mt-4 text-lg text-muted-foreground">
                  Stop assembling backends from five different services. Kolaybase
                  gives you isolated PostgreSQL, enterprise auth, object storage,
                  and a PostgREST-compatible API — all managed, all integrated,
                  all from your dashboard.
                </p>
                <div className="mt-8 flex flex-wrap gap-3">
                  <Link
                    href={getAppSignupUrl()}
                    className={buttonVariants({ size: "lg" })}
                  >
                    Start Building
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                  <Link
                    href="/docs"
                    className={buttonVariants({ variant: "outline", size: "lg" })}
                  >
                    Documentation
                  </Link>
                </div>
              </div>
              <Card className="border-border/80 bg-background/90 shadow-subtle backdrop-blur-sm">
                <CardHeader>
                  <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Code2 className="h-4 w-4 text-primary" />
                    What&apos;s included
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 text-sm text-muted-foreground">
                  {[
                    "Isolated PostgreSQL per project with PgBouncer pooling",
                    "Keycloak auth with per-project realms and 8 OAuth providers",
                    "PostgREST-compatible REST API with automatic RLS",
                    "S3-compatible object storage (MinIO)",
                    "Visual dashboard — tables, auth, API explorer, backups",
                  ].map((item) => (
                    <p key={item} className="flex gap-2">
                      <Check className="h-4 w-4 shrink-0 text-primary mt-0.5" />
                      {item}
                    </p>
                  ))}
                </CardContent>
              </Card>
            </div>
          </Card>
        </div>
      </section>
    </>
  );
}
