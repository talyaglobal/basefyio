import type { Metadata } from "next";
import Link from "next/link";
import { SiteShell } from "@/components/site-shell";
import { Breadcrumbs } from "@/components/seo/breadcrumbs";
import { JsonLd } from "@/components/seo/json-ld";
import { buildMetadata } from "@/lib/seo/metadata";
import { aboutPageSchema } from "@/lib/seo/json-ld";
import { getSiteUrlFromRequest } from "@/lib/site-url";
import { docsUrl } from "@/lib/public-hosts";

const TITLE = "About basefyio";
const DESCRIPTION =
  "basefyio is an open-source backend platform from Talya Smart: a dedicated SQL database, auth, storage and a REST API for every project. Who it is for and how to reach us.";

export async function generateMetadata(): Promise<Metadata> {
  return buildMetadata({ path: "/about", title: TITLE, description: DESCRIPTION });
}

export default async function AboutPage() {
  const base = (await getSiteUrlFromRequest()).replace(/\/$/, "");
  const url = `${base}/about`;
  const linkCls = "underline underline-offset-2 hover:text-foreground";

  return (
    <SiteShell>
      <JsonLd data={aboutPageSchema(url, base)} />
      <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
        <Breadcrumbs
          items={[
            { name: "Home", url: `${base}/` },
            { name: "About", url },
          ]}
        />
        <h1 className="text-4xl font-bold tracking-tight">About basefyio</h1>
        <p className="mt-4 text-lg text-foreground">
          basefyio is a backend-as-a-service platform for developers. Every
          project gets a dedicated SQL database, an isolated authentication
          realm, S3-compatible object storage and an auto-generated REST API,
          and the whole platform can run on your own infrastructure.
        </p>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">What it is</h2>
        <p className="mt-3 text-muted-foreground">
          basefyio is a multi-tenant platform: one installation manages many
          projects, each isolated from the others. Besides the database, auth,
          storage and REST API, it includes realtime change events, automation
          flows, AI search (embeddings and RAG queries), an App Builder that
          turns a spreadsheet into tables, a dashboard with a SQL editor, a
          JavaScript/TypeScript SDK and a command-line tool. The product is
          currently in beta.
        </p>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">Who it is for</h2>
        <p className="mt-3 text-muted-foreground">
          Developers and small teams who want a backend without building
          authentication, storage and an API themselves, and who care about
          owning where their data runs. See{" "}
          <Link href="/use-cases" className={linkCls}>use cases</Link> and the{" "}
          <Link href="/guides/best-backend-database-for-startups" className={linkCls}>
            guide to choosing a backend for a startup
          </Link>
          , or compare basefyio with{" "}
          <Link href="/compare" className={linkCls}>other platforms</Link>.
        </p>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">Who builds it</h2>
        <p className="mt-3 text-muted-foreground">
          basefyio is developed and operated by Talya Smart. The server and
          dashboard are open source under AGPL-3.0-or-later; the client SDK and
          CLI are MIT-licensed. The source is on{" "}
          <a href="https://github.com/talyaglobal/basefyio" target="_blank" rel="noopener" className={linkCls}>
            GitHub
          </a>
          .
        </p>

        <h2 className="mt-10 text-2xl font-semibold tracking-tight">Contact</h2>
        <p className="mt-3 text-muted-foreground">
          Email{" "}
          <a href="mailto:support@talyasmart.com" className={linkCls}>
            support@talyasmart.com
          </a>
          . Documentation is at{" "}
          <Link href={docsUrl()} className={linkCls}>the docs</Link>, and service
          health is on the{" "}
          <Link href="/status" className={linkCls}>status page</Link>. Legal:{" "}
          <Link href="/privacy" className={linkCls}>privacy</Link> and{" "}
          <Link href="/terms" className={linkCls}>terms</Link>.
        </p>
      </div>
    </SiteShell>
  );
}
