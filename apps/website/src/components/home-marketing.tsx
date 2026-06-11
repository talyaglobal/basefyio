import Link from "next/link";
import {
  ArrowRight,
  Bot,
  Check,
  Code2,
  Database,
  Globe2,
  Key,
  Lock,
  MessageSquare,
  Server,
  Shield,
  Sparkles,
  Table2,
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
import { ScrollReveal } from "@/components/scroll-reveal";
import { HowItWorks } from "@/components/how-it-works";

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

const FEATURES = [
  {
    icon: Database,
    title: "Dedicated Database",
    desc: "Every project gets its own isolated database. Full SQL power, no shared tables, no noisy neighbors.",
    pills: ["SQL", "REST API", "Row-level auth"],
    band: "base.db",
  },
  {
    icon: Lock,
    title: "Authentication",
    desc: "Email/password, Google, GitHub, and 8+ OAuth providers. User management, sessions, and JWT — ready out of the box.",
    pills: ["OAuth", "JWT", "SSO"],
    band: "base.auth",
  },
  {
    icon: Zap,
    title: "Instant REST API",
    desc: "Create a table, get a REST API instantly. Powerful filters, pagination, and sorting — no code needed.",
    pills: ["Auto-gen", "Filters", "Pagination"],
    band: "base.api",
  },
  {
    icon: Shield,
    title: "Storage & CDN",
    desc: "S3-compatible object storage with edge CDN. Upload, manage, and serve files with automatic optimization.",
    pills: ["S3-compatible", "Edge CDN", "Resumable"],
    band: "base.storage",
  },
] as const;

const COMING_SOON = [
  {
    icon: "📰",
    title: "Headless CMS",
    desc: "Content modelling baked into your project — structured content, media and localisation served over the same REST API.",
    pills: ["Content API", "Media", "i18n"],
    band: "base.cms",
  },
  {
    icon: "📱",
    title: "NoSQL for Mobile",
    desc: "An offline-first document store that syncs to your database — mobile apps work offline and converge automatically.",
    pills: ["Offline-first", "Sync", "Document DB"],
    band: "base.mobile",
  },
  {
    icon: "📊",
    title: "Microsoft Integration",
    desc: "Import and sync MS Excel, SharePoint and Microsoft 365 data straight into your project — every data type, one backend.",
    pills: ["Excel", "Microsoft 365", "SharePoint"],
    band: "base.msft",
  },
] as const;

export function HomeMarketing() {
  return (
    <>
      {/* ============ HOW IT WORKS ============ */}
      <section className="relative px-6 py-20 md:py-28" id="how">
        <div className="absolute inset-0 bg-gradient-radial from-primary/[0.04] via-transparent to-transparent" />
        <div className="relative mx-auto max-w-6xl">
          <ScrollReveal>
            <HowItWorks />
          </ScrollReveal>
        </div>
      </section>

      {/* ============ FEATURES (4 cards) ============ */}
      <section className="relative px-6 py-20 md:py-28" id="features">
        <div className="mx-auto max-w-6xl">
          <ScrollReveal>
            <span className="section-label">One project, every layer</span>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Everything your app needs. Nothing it doesn&apos;t.
            </h2>
          </ScrollReveal>

          <div className="mt-12 grid gap-5 sm:grid-cols-2">
            {FEATURES.map((f, i) => {
              const Icon = f.icon;
              return (
                <ScrollReveal key={f.title} delay={i % 2 === 0 ? 0 : 1}>
                  <div className="landing-feature-card h-full">
                    <div className="feature-icon">
                      <Icon className="h-6 w-6 text-primary" />
                    </div>
                    <h3 className="text-xl font-semibold tracking-tight">
                      {f.title}
                    </h3>
                    <p className="mt-2 text-sm text-muted-foreground leading-relaxed">
                      {f.desc}
                    </p>
                    <div className="mt-4 flex flex-wrap gap-2">
                      {f.pills.map((p) => (
                        <span key={p} className="feat-pill-tag">
                          {p}
                        </span>
                      ))}
                    </div>
                    <div className="feature-bottom-band">{f.band}</div>
                  </div>
                </ScrollReveal>
              );
            })}
          </div>
        </div>
      </section>

      {/* ============ LAYERS SPOTLIGHT ============ */}
      <section
        className="relative overflow-hidden px-6 py-20 md:py-28"
        id="layers"
        style={{
          background:
            "linear-gradient(180deg, hsl(var(--background)) 0%, hsl(var(--card)) 100%)",
        }}
      >
        <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-12 lg:items-center lg:gap-16">
          <div className="lg:col-span-5">
            <ScrollReveal>
              <h2 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
                <span className="block text-muted-foreground">ONE PROJECT.</span>
                <span className="block">EVERY LAYER.</span>
              </h2>
              <p className="mt-6 text-muted-foreground">
                basefyio gives every app:
              </p>
              <div className="mt-6 flex flex-col gap-0">
                <div className="layer-row">
                  <span className="layer-key">Database + REST</span>
                  <span className="layer-val">relational data, instant API</span>
                </div>
                <div className="layer-row">
                  <span className="layer-key">Authentication</span>
                  <span className="layer-val">OAuth, JWT, SSO</span>
                </div>
                <div className="layer-row">
                  <span className="layer-key">Storage</span>
                  <span className="layer-val">files, assets, edge CDN</span>
                </div>
                <div className="layer-row">
                  <span className="layer-key">AI Assistant</span>
                  <span className="layer-val">schema-aware project AI</span>
                </div>
              </div>
              <p className="mt-6 text-sm text-muted-foreground">
                One provisioning call. One connection string. One dashboard.
              </p>
            </ScrollReveal>
          </div>

          <div className="lg:col-span-7">
            <ScrollReveal delay={1}>
              <div className="landing-code-block">
                <div>
                  <span className="tok-key">import</span>
                  {" { basefyio } "}
                  <span className="tok-key">from</span>{" "}
                  <span className="tok-str">&apos;@basefyio/sdk&apos;</span>
                </div>
                <div>&nbsp;</div>
                <div>
                  <span className="tok-key">const</span>{" "}
                  <span className="tok-var">db</span> = basefyio.
                  <span className="tok-prop">db</span>
                  {"           "}
                  <span className="tok-com">{"// database + REST"}</span>
                </div>
                <div>
                  <span className="tok-key">const</span>{" "}
                  <span className="tok-var">auth</span> = basefyio.
                  <span className="tok-prop">auth</span>
                  {"       "}
                  <span className="tok-com">{"// auth + OAuth"}</span>
                </div>
                <div>
                  <span className="tok-key">const</span>{" "}
                  <span className="tok-var">storage</span> = basefyio.
                  <span className="tok-prop">storage</span>
                  {"  "}
                  <span className="tok-com">{"// s3 + cdn"}</span>
                </div>
                <div>&nbsp;</div>
                <div>
                  <span className="tok-com">
                    {"// query your data with powerful REST syntax"}
                  </span>
                </div>
                <div>
                  <span className="tok-key">const</span>{" "}
                  <span className="tok-var">users</span> ={" "}
                  <span className="tok-key">await</span> db.
                  <span className="tok-fn">from</span>(
                  <span className="tok-str">&apos;users&apos;</span>)
                </div>
                <div>
                  {"  ."}
                  <span className="tok-fn">select</span>(
                  <span className="tok-str">&apos;id, name, email&apos;</span>)
                </div>
                <div>
                  {"  ."}
                  <span className="tok-fn">eq</span>(
                  <span className="tok-str">&apos;active&apos;</span>,{" "}
                  <span className="tok-var">true</span>)
                </div>
                <div>&nbsp;</div>
                <div>
                  <span className="tok-com">
                    {"// ask the project AI — understands your schema"}
                  </span>
                </div>
                <div>
                  <span className="tok-key">const</span>{" "}
                  <span className="tok-var">insight</span> ={" "}
                  <span className="tok-key">await</span> basefyio.
                  <span className="tok-fn">ai</span>({"{"})
                </div>
                <div>
                  {"  "}
                  <span className="tok-prop">prompt</span>:{" "}
                  <span className="tok-str">
                    &quot;which tables reference users.id?&quot;
                  </span>
                </div>
                <div>
                  {"}"})
                  <span className="code-cursor-blink" />
                </div>
              </div>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* ============ AI ASSISTANT ============ */}
      <section
        className="border-t border-border px-6 py-20 md:py-28"
        id="ai-assistant"
      >
        <div className="mx-auto max-w-6xl">
          <div className="grid gap-10 lg:grid-cols-2 lg:items-stretch lg:gap-12">
            <div className="flex flex-col justify-center">
              <ScrollReveal>
                <Badge variant="accent" className="w-fit gap-1.5 px-3 py-1">
                  <Wand2 className="h-3.5 w-3.5" />
                  Intelligent assistant
                </Badge>
                <h2 className="mt-4 text-balance text-3xl font-bold tracking-tight sm:text-4xl">
                  Chat with your project &mdash; not just your tables
                </h2>
                <p className="mt-4 text-lg text-muted-foreground">
                  basefyio includes a smart AI that understands your schema and
                  project context. Ask in plain language: explore relationships,
                  catch risky patterns, get migration ideas, or summarize how
                  your API surface maps to the database.
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
              </ScrollReveal>
            </div>

            <ScrollReveal delay={1}>
              <Card className="flex h-full flex-col overflow-hidden border-primary/20 bg-gradient-to-b from-card to-muted/20 shadow-medium">
                <CardHeader className="space-y-1 border-b border-border bg-muted/30 pb-4">
                  <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-subtle">
                      <Bot className="h-4 w-4" />
                    </div>
                    Project assistant
                    <Badge
                      variant="secondary"
                      className="ml-auto text-[10px] uppercase"
                    >
                      Live context
                    </Badge>
                  </div>
                  <CardDescription>
                    Example conversation &mdash; your real project stays private.
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
                      . Neither has a covering index &mdash; want suggested{" "}
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
                      Yes &mdash; optimize for our read-heavy dashboard queries.
                    </div>
                  </div>
                </CardContent>
                <CardFooter className="border-t border-border bg-muted/20 py-4">
                  <p className="text-xs text-muted-foreground">
                    The assistant reasons over your project context in the
                    dashboard &mdash; so answers stay relevant to{" "}
                    <span className="font-medium text-foreground">your</span>{" "}
                    schema, not generic database trivia.
                  </p>
                </CardFooter>
              </Card>
            </ScrollReveal>
          </div>
        </div>
      </section>

      {/* ============ REST API ENGINE ============ */}
      <section
        className="border-t border-border px-6 py-20 md:py-28"
        id="rest-engine"
      >
        <div className="mx-auto max-w-6xl">
          <ScrollReveal>
            <div className="mx-auto mb-14 max-w-3xl text-center">
              <Badge variant="outline" className="mb-4 gap-1.5">
                <Code2 className="h-3.5 w-3.5" />
                REST API
              </Badge>
              <h2 className="text-balance text-3xl font-bold tracking-tight sm:text-4xl">
                Every table is an API endpoint.{" "}
                <span className="gradient-text">Instantly.</span>
              </h2>
              <p className="mt-4 text-lg text-muted-foreground">
                Create a table in the dashboard &mdash; your API is live
                instantly. Standard HTTP, standard JSON. No code generation, no
                deploy step.
              </p>
            </div>
          </ScrollReveal>
          <div className="grid gap-5 md:grid-cols-2">
            {[
              {
                method: "GET",
                path: "/rest/v1/products",
                color:
                  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
                code: `curl '/rest/v1/products\n  ?select=id,name,price\n  &category=eq.electronics\n  &price=lt.500\n  &order=price.asc&limit=20' \\\n  -H "apikey: YOUR_ANON_KEY"`,
              },
              {
                method: "POST",
                path: "/rest/v1/products",
                color:
                  "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400",
                code: `curl -X POST '/rest/v1/products' \\\n  -H "apikey: YOUR_SERVICE_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "Prefer: return=representation" \\\n  -d '{"name": "Widget", "price": 29.99}'`,
              },
              {
                method: "PATCH",
                path: "/rest/v1/products?id=eq.42",
                color:
                  "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400",
                code: `curl -X PATCH '/rest/v1/products?id=eq.42' \\\n  -H "apikey: YOUR_SERVICE_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"price": 24.99}'`,
              },
              {
                method: "DELETE",
                path: "/rest/v1/products?id=eq.42",
                color:
                  "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400",
                code: `curl -X DELETE '/rest/v1/products?id=eq.42' \\\n  -H "apikey: YOUR_SERVICE_KEY"`,
              },
            ].map((ex, i) => (
              <ScrollReveal key={ex.method} delay={i % 2 === 0 ? 0 : 1}>
                <Card className="h-full overflow-hidden border-border/80 shadow-subtle">
                  <CardHeader className="border-b border-border bg-muted/30 px-5 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "inline-flex items-center rounded px-2 py-0.5 text-xs font-bold font-mono",
                          ex.color,
                        )}
                      >
                        {ex.method}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {ex.path}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="p-0">
                    <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
                      <code className="text-muted-foreground whitespace-pre">
                        {ex.code}
                      </code>
                    </pre>
                  </CardContent>
                </Card>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============ COMING SOON ============ */}
      <section className="relative px-6 py-20 md:py-28" id="coming">
        <div className="mx-auto max-w-6xl">
          <ScrollReveal>
            <span className="section-label">Coming soon &middot; roadmap</span>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Four worlds, two universes.
            </h2>
            <p className="mt-5 max-w-xl text-muted-foreground">
              basefyio is merging the SaaS, mobile and data worlds into a single
              backend &mdash; so one connection string powers your web product,
              your mobile app and your AI.
            </p>
            <p className="mt-4 text-base font-semibold text-amber-400">
              basefyio is able to handle every type of data &mdash; including MS
              Excel.
            </p>
          </ScrollReveal>

          <ScrollReveal delay={1}>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <span className="world-tag">SaaS world</span>
              <span className="world-plus">+</span>
              <span className="world-tag">Mobile world</span>
              <span className="world-plus">+</span>
              <span className="world-tag">Data world</span>
              <span className="world-plus">+</span>
              <span className="world-tag">MS365 world</span>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="universe-tag">Structured Data</span>
              <span className="text-lg font-bold text-muted-foreground">
                &times;
              </span>
              <span className="universe-tag">Unstructured Data</span>
            </div>
          </ScrollReveal>

          <div className="mt-10 grid gap-5 sm:grid-cols-3">
            {COMING_SOON.map((c, i) => (
              <ScrollReveal key={c.title} delay={i as 0 | 1 | 2}>
                <div className="landing-feature-card relative h-full">
                  <span className="soon-badge-tag">Coming soon</span>
                  <div className="feature-icon text-2xl">{c.icon}</div>
                  <h3 className="text-xl font-semibold tracking-tight">
                    {c.title}
                  </h3>
                  <p className="mt-2 min-h-[72px] text-sm text-muted-foreground leading-relaxed">
                    {c.desc}
                  </p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {c.pills.map((p) => (
                      <span key={p} className="feat-pill-tag">
                        {p}
                      </span>
                    ))}
                  </div>
                  <div className="feature-bottom-band">{c.band}</div>
                </div>
              </ScrollReveal>
            ))}
          </div>
        </div>
      </section>

      {/* ============ FRAMEWORK ROW ============ */}
      <section className="border-t border-border bg-muted/10 px-6 py-20 md:py-28">
        <div className="mx-auto max-w-6xl">
          <ScrollReveal>
            <Card className="border-border/80 bg-card/90 shadow-soft">
              <CardHeader className="text-center">
                <Badge variant="outline" className="mx-auto">
                  Any client stack
                </Badge>
                <CardTitle className="pt-2 text-2xl sm:text-3xl md:text-4xl">
                  Use basefyio with{" "}
                  <span className="gradient-text">any framework</span>
                </CardTitle>
                <CardDescription className="mx-auto max-w-2xl text-base">
                  Standard HTTP &mdash; no proprietary SDK required. Works with
                  any language, any framework.
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
          </ScrollReveal>
        </div>
      </section>

      {/* ============ STUDENT OFFER STRIP ============ */}
      <div className="offer-strip-landing">
        <div className="mx-auto max-w-6xl px-6">
          <ScrollReveal>
            <div className="offer-inner">
              <p className="offer-text">
                &#x1F393; 90% off for high-school &amp; college students,
                teachers and research assistants!
              </p>
              <Link
                href={getAppSignupUrl()}
                className="inline-flex shrink-0 items-center rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-subtle transition-all hover:opacity-90"
              >
                Validate ID &rarr;
              </Link>
            </div>
          </ScrollReveal>
        </div>
      </div>

      {/* ============ FINAL CTA ============ */}
      <section className="final-cta-glow relative overflow-hidden px-6 py-20 md:py-28">
        <div className="relative mx-auto max-w-4xl text-center">
          <ScrollReveal>
            <h2 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              Your backend is{" "}
              <span className="gradient-text">one command away.</span>
            </h2>
            <p className="mx-auto mt-6 max-w-xl text-lg text-muted-foreground">
              No glue code. No five vendors. One project for database, auth,
              storage and instant API.
            </p>
          </ScrollReveal>
          <ScrollReveal delay={1}>
            <Link
              href={getAppSignupUrl()}
              className="mt-10 inline-flex h-14 items-center gap-2 rounded-xl bg-primary px-8 text-base font-bold text-primary-foreground shadow-medium transition-all hover:opacity-90 active:scale-[0.98]"
            >
              <Zap className="h-5 w-5" />
              Start building for free &rarr;
            </Link>
            <p className="mt-5 text-xs text-muted-foreground">
              No credit card required &middot; Free tier &middot; Self-hostable
            </p>
          </ScrollReveal>
        </div>
      </section>
    </>
  );
}
