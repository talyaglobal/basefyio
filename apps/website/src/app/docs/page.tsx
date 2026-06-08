import type { Metadata } from "next";
import Link from "next/link";
import { Server, Code, Terminal } from "lucide-react";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getAppPortalUrl, getAppSignupUrl, getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio is a backend-as-a-service platform. PostgreSQL, authentication, file storage, and auto-generated REST API for every project.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs", {
    title: "Documentation",
    description: pageDescription,
    openGraph: {
      title: "Documentation | basefyio Docs",
      description: pageDescription,
    },
  });
}

function appPortalHostLabel(): string {
  try {
    return new URL(getAppPortalUrl()).host;
  } catch {
    return "app.basefyio.com";
  }
}

export default function DocsOverview() {
  const apiUrl = getPublicApiUrl();
  const signupUrl = getAppSignupUrl();
  const appHost = appPortalHostLabel();

  return (
    <div>
      <h1>Documentation</h1>
      <p>
        basefyio is a backend-as-a-service platform. It provides a PostgreSQL
        database, authentication, file storage, and auto-generated REST API for
        every project you create.
      </p>

      <h2>Quick Start</h2>
      <p>
        Create a free account at{" "}
        <a href={signupUrl}>{appHost}</a>, create
        a project, and start building immediately.
      </p>
      <pre><code>{`npm install basefyio-js`}</code></pre>
      <pre><code>{`import { createClient } from 'basefyio-js'

const bf = createClient({
  apiUrl: '${apiUrl}',
  projectId: 'your-project-id',
  apiKey: 'your-anon-key',
})

// Query data
const { data, error } = await bf.from('posts').select()

// Sign up a user
const { data: user } = await bf.auth.signUp({
  email: 'user@example.com',
  password: 'securepassword',
})`}</code></pre>

      <h2>Explore</h2>
      <div className="not-prose grid gap-4 sm:grid-cols-3 mt-6">
        {[
          { href: "/docs/api", icon: Server, title: "API Reference", desc: "REST endpoints for data, auth, and storage" },
          { href: "/docs/sdk", icon: Code, title: "SDK", desc: "JavaScript/TypeScript client library" },
          { href: "/docs/cli", icon: Terminal, title: "CLI", desc: "Command-line tool for project management" },
        ].map(({ href, icon: Icon, title, desc }) => (
          <Link
            key={href}
            href={href}
            className="rounded-xl border border-border bg-card p-5 hover:border-muted-foreground/30 transition-colors group"
          >
            <Icon className="h-5 w-5 text-primary mb-3" />
            <div className="font-semibold text-foreground group-hover:text-primary transition-colors">{title}</div>
            <div className="text-sm text-muted-foreground mt-1">{desc}</div>
          </Link>
        ))}
      </div>

      <h2>Core Concepts</h2>
      <h3>Projects</h3>
      <p>
        Each project gets its own PostgreSQL database, Keycloak authentication
        realm, storage buckets, and API keys. Projects belong to teams.
      </p>
      <h3>API Keys</h3>
      <p>
        Every project has two keys: an <strong>anon key</strong> (public, limited
        access) and a <strong>service key</strong> (private, full access). The
        anon key is safe to use in client-side code. The service key should only
        be used server-side.
      </p>
      <h3>Authentication</h3>
      <p>
        basefyio provides email/password sign-up, email verification, magic
        links, password reset, and OAuth (Google, GitHub). All managed per
        project.
      </p>
      <h3>Storage</h3>
      <p>
        S3-compatible file storage powered by MinIO. Create buckets, upload
        files, generate signed URLs, and set public access per bucket.
      </p>
    </div>
  );
}
