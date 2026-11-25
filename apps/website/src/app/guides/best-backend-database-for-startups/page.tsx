import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { Breadcrumbs } from "@/components/seo/breadcrumbs";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { faqSchema, pageArticleSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest, getAppSignupUrl } from "@/lib/site-url";

const PATH = "/guides/best-backend-database-for-startups";
const TITLE = "Best Backend and Database for Startups";
const DESCRIPTION =
  "How to pick a database and backend platform for a startup: Supabase, Firebase, Appwrite, PocketBase, Neon and basefyio compared, with who each one suits.";
const UPDATED = "2026-11-25";

const FAQS = [
  {
    question: "What is the best database for a startup?",
    answer:
      "For most startups with structured data, a managed SQL database is the safest default because the data model survives product changes and every tool speaks SQL. Add a backend platform on top if you also want auth, storage and an API without building them.",
  },
  {
    question: "Should a startup use SQL or NoSQL?",
    answer:
      "Start with SQL unless your data is genuinely document-shaped or you depend on offline mobile sync. Relational data, reporting and migrations are easier on SQL, and you can still store JSON where you need flexibility.",
  },
  {
    question: "Is a backend-as-a-service worth it for an early-stage startup?",
    answer:
      "Usually yes. Authentication, file storage and an API are the same work for every product, and a BaaS lets a small team ship them in days. Check how hard it is to leave before you commit: standard SQL data and a self-hosting option keep that cost low.",
  },
  {
    question: "Where does basefyio fit?",
    answer:
      "basefyio suits teams that want a dedicated SQL database per project, a self-hostable stack, and built-in AI search and automation. It is newer than the big names and currently in beta, so weigh that against your risk tolerance.",
  },
];

const OPTIONS: {
  name: string;
  url: string;
  bestFor: string;
  data: string;
  selfHost: string;
  batteries: string;
}[] = [
  {
    name: "basefyio",
    url: "/",
    bestFor: "Teams that want SQL per project and the option to self-host",
    data: "Dedicated SQL database per project, plus optional document collections",
    selfHost: "Yes, Docker Compose",
    batteries: "Auth, storage, REST API, realtime, SDK, CLI",
  },
  {
    name: "Supabase",
    url: "https://supabase.com/docs",
    bestFor: "Teams that want the most established SQL-based platform",
    // VERIFY: Postgres-based, with auth, storage, realtime and edge functions.
    data: "Postgres database per project",
    // VERIFY: Docker-based self-hosting is documented.
    selfHost: "Yes, via Docker",
    batteries: "Auth, storage, realtime, edge functions",
  },
  {
    name: "Firebase",
    url: "https://firebase.google.com/docs",
    bestFor: "Mobile-first apps with document-shaped data",
    // VERIFY: Firestore / Realtime Database are document stores.
    data: "Document databases (Firestore, Realtime Database)",
    // VERIFY: no production self-hosting.
    selfHost: "No, Google-managed",
    batteries: "Auth, storage, functions, hosting, mobile SDKs",
  },
  {
    name: "Appwrite",
    url: "https://appwrite.io/docs",
    bestFor: "Multi-platform apps that want many client SDKs",
    data: "Collections accessed through its API and SDKs",
    // VERIFY: Docker-based self-hosting is documented.
    selfHost: "Yes, via Docker",
    batteries: "Auth, storage, functions, realtime, messaging",
  },
  {
    name: "PocketBase",
    url: "https://pocketbase.io/docs/",
    bestFor: "Small projects and prototypes on one server",
    // VERIFY: SQLite-based single Go binary.
    data: "SQLite, single binary",
    selfHost: "Yes, that is the model",
    batteries: "Auth, files, realtime, admin UI",
  },
  {
    name: "Neon",
    url: "https://neon.com/docs",
    bestFor: "Teams that only need a serverless Postgres database",
    // VERIFY: Neon is serverless Postgres; confirm whether it now bundles auth.
    data: "Serverless Postgres",
    selfHost: "Managed service",
    batteries: "Database focused; bring your own auth and API",
  },
];

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({
    path: PATH,
    title: TITLE,
    description: DESCRIPTION,
    type: "article",
    publishedTime: UPDATED,
    modifiedTime: UPDATED,
    keywords: ["best database for startups", "best backend for startups", "BaaS comparison"],
  });
}

export default async function StartupBackendGuide() {
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const url = `${base}${PATH}`;
  const signupUrl = getAppSignupUrl();
  const linkCls = "underline underline-offset-2 hover:text-foreground";

  return (
    <SiteShell>
      <JsonLd data={faqSchema(FAQS)} />
      <JsonLd
        data={pageArticleSchema({
          url,
          headline: TITLE,
          description: DESCRIPTION,
          datePublished: UPDATED,
          dateModified: UPDATED,
          siteUrl: base,
        })}
      />
      <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
        <Breadcrumbs
          items={[
            { name: "Home", url: `${base}/` },
            { name: TITLE, url },
          ]}
        />

        <header className="mb-10">
          <h1 className="text-4xl font-bold tracking-tight">
            Best database and backend for startups
          </h1>
          <p className="mt-4 text-lg text-foreground">
            For most startups the best choice is a managed SQL database wrapped
            in a backend platform that already provides authentication, file
            storage and an API. Supabase is the most established option;
            Firebase suits mobile-first apps with document data; basefyio, Appwrite
            and PocketBase suit teams that want to self-host.
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            Last updated: <time dateTime={UPDATED}>November 25, 2026</time>.
            Written by the basefyio team, so read our own entry with that in
            mind.
          </p>
        </header>

        <section className="mb-12">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            The options at a glance
          </h2>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left">
                  <th className="px-4 py-3 font-semibold">Option</th>
                  <th className="px-4 py-3 font-semibold">Best for</th>
                  <th className="px-4 py-3 font-semibold">Data model</th>
                  <th className="px-4 py-3 font-semibold">Self-host</th>
                  <th className="px-4 py-3 font-semibold">Included</th>
                </tr>
              </thead>
              <tbody>
                {OPTIONS.map((o) => (
                  <tr key={o.name} className="border-b border-border last:border-0 align-top">
                    <td className="px-4 py-3 font-medium">
                      {o.url.startsWith("http") ? (
                        <a href={o.url} target="_blank" rel="noopener" className={linkCls}>
                          {o.name}
                        </a>
                      ) : (
                        <Link href={o.url} className={linkCls}>
                          {o.name}
                        </Link>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{o.bestFor}</td>
                    <td className="px-4 py-3 text-muted-foreground">{o.data}</td>
                    <td className="px-4 py-3 text-muted-foreground">{o.selfHost}</td>
                    <td className="px-4 py-3 text-muted-foreground">{o.batteries}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-sm text-muted-foreground">
            Competitor details come from each project&apos;s public
            documentation (linked above) and change over time. Check pricing and
            limits on their pages.
          </p>
        </section>

        <section className="mb-12">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            How to choose
          </h2>
          <ul className="list-disc space-y-3 pl-5 text-muted-foreground">
            <li>
              <strong className="text-foreground">Pick SQL unless you have a reason not to.</strong>{" "}
              Relational data, reporting and migrations are easier, and SQL data is portable.
            </li>
            <li>
              <strong className="text-foreground">Check how you would leave.</strong>{" "}
              Standard SQL data and a self-hosting option keep the cost of switching low.
            </li>
            <li>
              <strong className="text-foreground">Match the SDKs to your client.</strong>{" "}
              Native mobile teams often prefer Firebase or Appwrite SDKs; web teams are well served by all of them.
            </li>
            <li>
              <strong className="text-foreground">Price the second year, not the first.</strong>{" "}
              Compare what database size, egress and requests cost once you have users, on each pricing page.
            </li>
            <li>
              <strong className="text-foreground">Weigh maturity honestly.</strong>{" "}
              A younger platform can fit better, but it carries more risk than an established one.
            </li>
          </ul>
        </section>

        <section className="mb-12">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            Where basefyio fits, and where it does not
          </h2>
          <p className="text-muted-foreground">
            basefyio gives every project a dedicated SQL database, an isolated
            authentication realm, S3-compatible object storage and an
            auto-generated REST API, with a JavaScript/TypeScript SDK and a CLI.
            The server is open source under AGPL-3.0-or-later and runs on your
            own infrastructure with Docker Compose, or you can use the hosted
            service. It also adds automation flows, AI search and an App Builder,
            and it can import an existing Supabase project.
          </p>
          <p className="mt-3 text-muted-foreground">
            It is not the right pick if you need the largest community and
            ecosystem today, native mobile SDKs, or a platform that is already
            out of beta. See the head-to-head pages:{" "}
            <Link href="/compare/basefyio-vs-supabase" className={linkCls}>
              basefyio vs. Supabase
            </Link>
            ,{" "}
            <Link href="/compare/basefyio-vs-firebase" className={linkCls}>
              basefyio vs. Firebase
            </Link>{" "}
            and{" "}
            <Link href="/compare/basefyio-vs-appwrite" className={linkCls}>
              basefyio vs. Appwrite
            </Link>
            , or browse{" "}
            <Link href="/compare" className={linkCls}>
              all comparisons
            </Link>
            .
          </p>
        </section>

        <section className="mb-12">
          <h2 className="mb-4 text-2xl font-semibold tracking-tight">
            Frequently asked questions
          </h2>
          <dl className="space-y-6">
            {FAQS.map((faq) => (
              <div key={faq.question}>
                <dt className="font-semibold">{faq.question}</dt>
                <dd className="mt-1.5 text-muted-foreground">{faq.answer}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="flex flex-col items-start gap-4 rounded-xl border border-border bg-accent/30 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold">Try basefyio on the free plan</h2>
            <p className="mt-1 text-muted-foreground">
              Create a project and get a database, auth, storage and a REST API.
            </p>
          </div>
          <Link
            href={signupUrl}
            className="inline-flex h-10 items-center rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
        </section>
      </div>
    </SiteShell>
  );
}
