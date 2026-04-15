import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "Kolaybase CLI (kb): login, projects, migrations, types, and terminal workflows.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/cli", {
    title: "CLI Reference",
    description: pageDescription,
    openGraph: {
      title: "CLI Reference | Kolaybase Docs",
      description: pageDescription,
    },
  });
}

export default function CliDocs() {
  const apiUrl = getPublicApiUrl();

  return (
    <div>
      <h1>CLI Reference</h1>
      <p>
        The Kolaybase CLI lets you manage projects, push schemas, run
        migrations, generate types, and more — all from your terminal.
      </p>

      <h2>Installation</h2>
      <pre><code>{`npm install -g kolaybase-cli`}</code></pre>

      <h2>Authentication</h2>
      <h3>kb login</h3>
      <p>
        Log in to your Kolaybase account. The CLI opens your default browser,
        where you authenticate via Keycloak. After signing in you are shown a
        confirmation page — click <strong>Allow access</strong> to connect the
        CLI to your account, or <strong>Cancel</strong> to abort. The browser
        tab can be closed once the terminal confirms you are logged in.
      </p>
      <pre><code>{`kb login

# Custom API URL
kb login --api-url https://api.your-domain.com`}</code></pre>
      <p>
        Credentials are stored in <code>~/.kolaybase/config.json</code>. Run{" "}
        <code>kb login</code> again at any time to switch accounts.
      </p>

      <h2>Project Setup</h2>

      <h3>kb init</h3>
      <p>Create a new project and link the current directory.</p>
      <pre><code>{`kb init
# Interactive — prompts for name, team, etc.

kb init --name my-app`}</code></pre>

      <h3>kb link</h3>
      <p>Link current directory to an existing project.</p>
      <pre><code>{`kb link --project-id <uuid>`}</code></pre>

      <h3>kb unlink</h3>
      <p>Remove project link from current directory.</p>
      <pre><code>{`kb unlink`}</code></pre>

      <h3>kb status</h3>
      <p>Show project info, credentials, and connection strings.</p>
      <pre><code>{`kb status

# Show API keys (masked by default)
kb status --show-keys`}</code></pre>

      <h2>Project Management</h2>

      <h3>kb projects</h3>
      <p>List all projects in your active team.</p>
      <pre><code>{`kb projects
# or
kb list`}</code></pre>

      <h3>kb projects:create</h3>
      <pre><code>{`kb projects:create --name "My App" --description "Production app"`}</code></pre>

      <h3>kb projects:delete</h3>
      <pre><code>{`kb projects:delete <projectId>`}</code></pre>

      <h2>Database</h2>

      <h3>kb db push</h3>
      <p>
        Push a local schema to the remote database. Supports Prisma schema
        files and raw SQL.
      </p>
      <pre><code>{`# Push Prisma schema
kb db push

# Push SQL file
kb db push --file schema.sql`}</code></pre>

      <h3>kb db pull</h3>
      <p>Introspect the remote database and save schema locally.</p>
      <pre><code>{`kb db pull`}</code></pre>

      <h3>kb db reset</h3>
      <p>Drop all tables in the project database.</p>
      <pre><code>{`kb db reset
# Skips confirmation
kb db reset --force`}</code></pre>

      <h3>kb db seed</h3>
      <p>Run a seed file against the database.</p>
      <pre><code>{`kb db seed`}</code></pre>

      <h3>kb db dump</h3>
      <p>Export database schema as SQL.</p>
      <pre><code>{`kb db dump
kb db dump --output schema.sql`}</code></pre>

      <h3>kb db diff</h3>
      <p>Show differences between local Prisma schema and remote database.</p>
      <pre><code>{`kb db diff`}</code></pre>

      <h3>kb db execute</h3>
      <p>Run arbitrary SQL.</p>
      <pre><code>{`# From file
kb db execute --file query.sql

# Inline
kb db execute --query "SELECT * FROM users LIMIT 5"`}</code></pre>

      <h2>Inspect</h2>

      <h3>kb inspect</h3>
      <p>Show tables with row counts and sizes.</p>
      <pre><code>{`# All tables
kb inspect

# Specific table
kb inspect --table users`}</code></pre>

      <h2>Migrations</h2>

      <h3>kb migration new</h3>
      <p>Create a new migration file.</p>
      <pre><code>{`kb migration new add_orders_table`}</code></pre>

      <h3>kb migration up</h3>
      <p>Apply pending migrations.</p>
      <pre><code>{`# Apply all pending
kb migration up

# Apply one step
kb migration up --step 1

# Dry run (show SQL without executing)
kb migration up --dry-run`}</code></pre>

      <h3>kb migration down</h3>
      <p>Rollback migrations.</p>
      <pre><code>{`kb migration down
kb migration down --step 2
kb migration down --dry-run`}</code></pre>

      <h3>kb migration status</h3>
      <p>Show applied and pending migrations.</p>
      <pre><code>{`kb migration status`}</code></pre>

      <h2>Code Generation</h2>

      <h3>kb gen types</h3>
      <p>Generate TypeScript type definitions from your database schema.</p>
      <pre><code>{`kb gen types
kb gen types --output src/types/database.ts`}</code></pre>

      <h3>kb gen client</h3>
      <p>Generate a typed API client.</p>
      <pre><code>{`kb gen client
kb gen client --lang typescript --output src/lib/client.ts`}</code></pre>

      <h2>Utilities</h2>

      <h3>kb logs</h3>
      <p>View SQL audit logs.</p>
      <pre><code>{`kb logs
kb logs --tail 50`}</code></pre>

      <h3>kb secrets</h3>
      <p>Manage project environment variables.</p>
      <pre><code>{`# List (values are masked)
kb secrets list

# Set
kb secrets set DATABASE_URL "postgres://..."

# Remove
kb secrets unset DATABASE_URL`}</code></pre>

      <h2>Configuration</h2>
      <p>
        The CLI stores configuration in <code>.kolaybase</code> in your project
        directory and credentials in <code>~/.kolaybase/config.json</code>.
      </p>
      <pre><code>{`# .kolaybase (project config)
{
  "projectId": "uuid",
  "apiUrl": "${apiUrl}"
}`}</code></pre>
    </div>
  );
}
