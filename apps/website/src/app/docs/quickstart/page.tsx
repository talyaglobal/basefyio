import type { Metadata } from "next";
import Link from "next/link";
import { docsMetadata } from "../docs-metadata";
import { getAppPortalUrl, getAppSignupUrl, getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "Create a basefyio project, copy its keys, add a table with a row-level security policy, and query it over REST and from the JavaScript SDK.";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs/quickstart", "Quickstart", pageDescription);
}

export default function QuickstartDocs() {
  const apiUrl = getPublicApiUrl();
  const appUrl = getAppPortalUrl();
  const signupUrl = getAppSignupUrl();

  return (
    <div>
      <h1>Quickstart</h1>
      <p>
        Five minutes from a new account to data coming back from your own API. You need a
        browser, and Node.js 18 or newer for the SDK step.
      </p>

      <h2>1. Create an account and a project</h2>
      <p>
        Sign up at <a href={signupUrl}>{new URL(signupUrl).host}</a> — the Free plan needs no
        credit card. In the dashboard choose <strong>New project</strong>, give it a name, and wait
        a few seconds while its database, auth realm and storage are created.
      </p>

      <h2>2. Copy the project ID and keys</h2>
      <p>
        Open the project&apos;s <strong>Connection</strong> page. You need three values:
      </p>
      <div className="docs-table"><table>
        <thead><tr><th>Value</th><th>Where it goes</th></tr></thead>
        <tbody>
          <tr><td><strong>Project ID</strong></td><td>Identifies the project to the SDK and the CLI</td></tr>
          <tr><td><strong>Anon key</strong></td><td>Safe in browser and mobile code; row-level security applies to it</td></tr>
          <tr><td><strong>Service key</strong></td><td>Server-side only; bypasses row-level security. Never ship it to a client</td></tr>
        </tbody>
      </table></div>

      <h2>3. Create a table</h2>
      <p>
        Open the <strong>SQL Editor</strong> and run the statement below. It creates a table,
        switches on row-level security and allows anyone holding the anon key to read it — a
        good starting point you will tighten later (see <Link href="/docs/security">Security &amp; RLS</Link>).
      </p>
      <pre><code>{`create table todos (
  id bigint generated always as identity primary key,
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);

alter table todos enable row level security;

create policy "anyone can read todos" on todos
  for select to anon, authenticated
  using (true);

insert into todos (title) values ('Read the docs'), ('Ship it');`}</code></pre>
      <p>
        You can do the same without SQL in the <strong>Table Editor</strong>.
      </p>

      <h2>4. Query it over REST</h2>
      <p>
        Every table is an endpoint under <code>{`${apiUrl}/api/rest/v1/`}</code>. Send the anon key
        in the <code>apikey</code> header:
      </p>
      <pre><code>{`curl "${apiUrl}/api/rest/v1/todos?select=id,title,done&order=id.asc" \\
  -H "apikey: YOUR_ANON_KEY"`}</code></pre>
      <pre><code>{`[
  { "id": 1, "title": "Read the docs", "done": false },
  { "id": 2, "title": "Ship it", "done": false }
]`}</code></pre>
      <p>
        Filters, ordering, pagination, inserts, updates and deletes are in the{" "}
        <Link href="/docs/api">API reference</Link>.
      </p>

      <h2>5. Query it from JavaScript</h2>
      <pre><code>{`npm install basefyio-js`}</code></pre>
      <pre><code>{`import { createClient } from 'basefyio-js'

const bf = createClient({
  apiUrl: '${apiUrl}',
  projectId: 'YOUR_PROJECT_ID',
  apiKey: 'YOUR_ANON_KEY',
})

const { data, error } = await bf.from('todos').select('id, title, done').eq('done', false)
if (error) throw error
console.log(data)`}</code></pre>
      <p>
        Writing rows from a browser needs a signed-in user and a policy that allows it: add{" "}
        <Link href="/docs/auth">authentication</Link>, then an <code>insert</code> policy for the{" "}
        <code>authenticated</code> role.
      </p>

      <h2>6. Optional: the CLI</h2>
      <pre><code>{`npm install -g basefyio-cli
basefyio login
basefyio link --project-id YOUR_PROJECT_ID   # writes the project's settings to .env
basefyio gen types --output src/types/database.ts`}</code></pre>
      <p>
        With the <code>.env</code> written by <code>basefyio link</code>,{" "}
        <code>createClient()</code> needs no arguments. See the <Link href="/docs/cli">CLI reference</Link>.
      </p>

      <h2>Next steps</h2>
      <ul>
        <li><Link href="/docs/auth">Authentication</Link> — sign your users up and in</li>
        <li><Link href="/docs/storage">Storage</Link> — upload files to buckets</li>
        <li><Link href="/docs/realtime">Realtime</Link> — receive changes as they happen</li>
        <li><Link href="/docs/connect">Connect</Link> — use pgAdmin, DBeaver, Prisma or Drizzle</li>
        <li>Manage the project any time from the <a href={appUrl}>dashboard</a></li>
      </ul>
    </div>
  );
}
