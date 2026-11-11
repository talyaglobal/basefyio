import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getAppSignupUrl, getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "Quickstart: create a basefyio project, make a table and read and write it from your app in a few minutes.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/quickstart", {
    title: "Quickstart",
    description: pageDescription,
    openGraph: {
      title: "Quickstart | basefyio Docs",
      description: pageDescription,
    },
  });
}

export default function QuickstartDocs() {
  const apiUrl = getPublicApiUrl();

  return (
    <div>
      <h1>Quickstart</h1>
      <p>
        From nothing to a working database API in a few minutes: create a project, add a table, then
        read and write it from your app.
      </p>

      <h2>1. Create a project</h2>
      <p>
        <a href={getAppSignupUrl()}>Sign up</a>, then choose <strong>New project</strong> in the
        dashboard. Every project gets its own dedicated database, auth realm, storage and API keys.
      </p>

      <h2>2. Add a table</h2>
      <p>
        Open <strong>Database</strong> in your project and create a table (for example{" "}
        <code>posts</code> with <code>id</code>, <code>title</code> and <code>status</code>
        columns), or run SQL in the SQL editor.
      </p>

      <h2>3. Get your keys</h2>
      <p>
        The <strong>Connection</strong> page shows the project ID, the anon key (safe in a browser)
        and the connection strings. From a terminal, <code>basefyio login</code> and{" "}
        <code>basefyio link --project-id &lt;uuid&gt;</code> write them to a <code>.env</code> for
        you — see the <a href="/docs/cli">CLI</a> page.
      </p>

      <h2>4. Query it</h2>
      <pre><code>{`npm install basefyio-js`}</code></pre>
      <pre><code>{`import { createClient } from 'basefyio-js'

const bf = createClient({
  apiUrl: '${apiUrl}',
  projectId: 'your-project-id',
  apiKey: 'your-anon-key',
})

await bf.from('posts').insert({ title: 'Hello', status: 'published' })

const { data, error } = await bf.from('posts').select().eq('status', 'published')`}</code></pre>
      <p>The same table is available over plain HTTP:</p>
      <pre><code>{`curl "${apiUrl}/api/rest/v1/posts?select=*" \\
  -H "apikey: <anon-key>"`}</code></pre>
      <p>
        Row Level Security applies to the anon key: turn it on and add policies before you expose a
        table to the browser (see <a href="/docs/security">Security &amp; RLS</a>).
      </p>

      <h2>Next steps</h2>
      <ul>
        <li><a href="/docs/auth">Authentication</a> — sign up and sign in your own users.</li>
        <li><a href="/docs/storage">Storage</a> — buckets and file uploads.</li>
        <li><a href="/docs/realtime">Realtime</a> — subscribe to inserts, updates and deletes.</li>
        <li><a href="/docs/backups">Backups &amp; point-in-time recovery</a> — know how to undo a mistake.</li>
      </ul>
    </div>
  );
}
