import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio CLI (basefyio): login, projects, migrations, types, and terminal workflows.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/cli", {
    title: "CLI Reference",
    description: pageDescription,
    openGraph: {
      title: "CLI Reference | basefyio Docs",
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
        The basefyio CLI lets you manage projects, push schemas, run
        migrations, generate types, and more — all from your terminal.
      </p>

      <h2>Installation</h2>
      <pre><code>{`npm install -g basefyio-cli`}</code></pre>

      <h2>Authentication</h2>
      <h3>basefyio login</h3>

      <p>
        Log in to your basefyio account. The CLI opens your default browser,
        where you authenticate via Keycloak. After signing in you are shown a
        confirmation page — click <strong>Allow access</strong> to connect the
        CLI to your account, or <strong>Cancel</strong> to abort. The browser
        tab can be closed once the terminal confirms you are logged in.
      </p>
      <pre><code>{`basefyio login

# Custom API URL
basefyio login --api-url https://api.your-domain.com`}</code></pre>
      <p>
        Credentials are stored in <code>~/.basefyio/config.json</code>. Run{" "}
        <code>basefyio login</code> again at any time to switch accounts.
      </p>

      <h3>basefyio logout</h3>
      <p>Sign out and clear saved credentials.</p>
      <pre><code>{`basefyio logout`}</code></pre>

      <h2>Project Setup</h2>

      <h3>basefyio init</h3>
      <p>Create a new project and link the current directory.</p>
      <pre><code>{`basefyio init
# Interactive — prompts for name, team, etc.

basefyio init --name my-app`}</code></pre>

      <h3>basefyio link</h3>
      <p>Link current directory to an existing project.</p>
      <pre><code>{`basefyio link --project-id <uuid>`}</code></pre>

      <h3>basefyio unlink</h3>
      <p>Remove project link from current directory.</p>
      <pre><code>{`basefyio unlink`}</code></pre>

      <h3>basefyio status</h3>
      <p>Show project info, credentials, and connection strings.</p>
      <pre><code>{`basefyio status

# Show API keys (masked by default)
basefyio status --show-keys`}</code></pre>

      <h2>Project Management</h2>

      <h3>basefyio projects</h3>
      <p>List all projects in your active team.</p>
      <pre><code>{`basefyio projects
# or
basefyio list`}</code></pre>

      <h3>basefyio projects:create</h3>
      <pre><code>{`basefyio projects:create --name "My App" --description "Production app"`}</code></pre>

      <h3>basefyio projects:delete</h3>
      <pre><code>{`basefyio projects:delete <projectId>`}</code></pre>

      <h2>Database</h2>

      <h3>basefyio db push</h3>
      <p>
        Push a local schema to the remote database. Supports Prisma schema
        files and raw SQL. Shortcut: <code>basefyio push</code>.
      </p>
      <pre><code>{`# Push Prisma schema
basefyio db push

# Push SQL file
basefyio db push --file schema.sql

# Shortcut
basefyio push`}</code></pre>

      <h3>basefyio db pull</h3>
      <p>Introspect the remote database and save schema locally.</p>
      <pre><code>{`basefyio db pull`}</code></pre>

      <h3>basefyio db reset</h3>
      <p>Drop all tables in the project database.</p>
      <pre><code>{`basefyio db reset
# Skips confirmation
basefyio db reset --force`}</code></pre>

      <h3>basefyio db seed</h3>
      <p>Run a seed file against the database.</p>
      <pre><code>{`basefyio db seed`}</code></pre>

      <h3>basefyio db dump</h3>
      <p>Export database schema as SQL.</p>
      <pre><code>{`basefyio db dump
basefyio db dump --output schema.sql`}</code></pre>

      <h3>basefyio db diff</h3>
      <p>Show differences between local Prisma schema and remote database.</p>
      <pre><code>{`basefyio db diff`}</code></pre>

      <h3>basefyio db execute</h3>
      <p>Run arbitrary SQL.</p>
      <pre><code>{`# From file
basefyio db execute --file query.sql

# Inline
basefyio db execute --query "SELECT * FROM users LIMIT 5"`}</code></pre>

      <h2>Inspect</h2>

      <h3>basefyio inspect</h3>
      <p>Show tables with row counts and sizes.</p>
      <pre><code>{`# All tables
basefyio inspect

# Specific table
basefyio inspect --table users`}</code></pre>

      <h2>Migrations</h2>

      <h3>basefyio migration new</h3>
      <p>Create a new migration file.</p>
      <pre><code>{`basefyio migration new add_orders_table`}</code></pre>

      <h3>basefyio migration up</h3>
      <p>Apply pending migrations.</p>
      <pre><code>{`# Apply all pending
basefyio migration up

# Apply one step
basefyio migration up --step 1

# Dry run (show SQL without executing)
basefyio migration up --dry-run`}</code></pre>

      <h3>basefyio migration down</h3>
      <p>Rollback migrations.</p>
      <pre><code>{`basefyio migration down
basefyio migration down --step 2
basefyio migration down --dry-run`}</code></pre>

      <h3>basefyio migration status</h3>
      <p>Show applied and pending migrations.</p>
      <pre><code>{`basefyio migration status`}</code></pre>

      <h2>Code Generation</h2>

      <h3>basefyio gen types</h3>
      <p>Generate TypeScript type definitions from your database schema.</p>
      <pre><code>{`basefyio gen types
basefyio gen types --output src/types/database.ts`}</code></pre>

      <h3>basefyio gen client</h3>
      <p>Generate a typed API client.</p>
      <pre><code>{`basefyio gen client
basefyio gen client --lang typescript --output src/lib/client.ts`}</code></pre>

      <h2>Utilities</h2>

      <h3>basefyio logs</h3>
      <p>View SQL audit logs.</p>
      <pre><code>{`basefyio logs
basefyio logs --tail 50`}</code></pre>

      <h3>basefyio secrets</h3>
      <p>Manage project environment variables.</p>
      <pre><code>{`# List (values are masked)
basefyio secrets list

# Set
basefyio secrets set DATABASE_URL "postgres://..."

# Remove
basefyio secrets unset DATABASE_URL`}</code></pre>

      <h2>Configuration</h2>
      <p>
        The CLI stores configuration in <code>.basefyio</code> in your project
        directory and credentials in <code>~/.basefyio/config.json</code>.
      </p>
      <pre><code>{`# .basefyio (project config)
{
  "projectId": "uuid",
  "apiUrl": "${apiUrl}"
}`}</code></pre>
    </div>
  );
}
