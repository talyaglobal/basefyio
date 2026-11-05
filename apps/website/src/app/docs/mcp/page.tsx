import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "Connect an AI agent to basefyio over the Model Context Protocol, with an API token whose permissions decide exactly what it can read and change.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/mcp", {
    title: "MCP Server",
    description: pageDescription,
    openGraph: {
      title: "MCP Server | basefyio Docs",
      description: pageDescription,
    },
  });
}

const TOOLS: [string, string, string][] = [
  ["list_teams", "team:read", "Your teams, your role in each and how many projects they hold"],
  ["list_projects", "projects:read", "Active projects of one team, or of every team the token can reach"],
  ["get_project", "projects:read", "One project's details. Keys and passwords are never returned"],
  ["list_tables", "schema:read", "Tables with their schema and row count"],
  ["describe_table", "schema:read", "Columns, types, primary key and foreign keys of a table"],
  ["select_rows", "data:read", "One page of rows (up to 200), with free-text search and sorting"],
  ["insert_row", "data:write", "Insert one row and return it as stored"],
  ["update_rows", "data:write", "Update the rows that match, return the first one"],
  ["delete_row", "data:write", "Delete the first row that matches"],
  ["query_sql", "sql:read", "One read-only statement in a read-only transaction that is always rolled back"],
  ["run_sql", "sql:run", "Any SQL as the database owner, including writes, DDL and DROP"],
  ["list_buckets", "storage:read", "Storage buckets of a project"],
  ["list_objects", "storage:read", "One folder level of a bucket (up to 1,000 entries)"],
  ["list_auth_users", "auth:read", "End users of the project's authentication, 100 per page"],
];

export default function McpDocs() {
  const mcpUrl = `${getPublicApiUrl()}/api/mcp`;

  return (
    <div>
      <h1>MCP Server</h1>
      <p>
        basefyio runs a Model Context Protocol (MCP) server, so an AI agent such as Claude Code or
        Cursor can work with your projects: list tables, read rows, run SQL, browse storage. The agent
        signs in with an API token, and the token&apos;s permissions decide which tools it sees and what
        each call may do — reads and writes alike.
      </p>

      <h2>1. Create a token</h2>
      <p>
        In the dashboard open <strong>Account → API Tokens</strong> and choose{" "}
        <strong>Connect an AI agent</strong>, or <strong>Create Token</strong> for a blank form. Turn on
        only the permissions the agent needs. The <strong>MCP (read-only)</strong> preset selects every
        read tool and nothing that can change data. The token is shown once; copy it then.
      </p>

      <h2>2. Put it in your environment</h2>
      <p>
        Keep the token out of files you commit. Store it in your project&apos;s environment and let the
        client read it from there:
      </p>
      <pre><code>{`# .env (keep it out of version control)
BASEFYIO_MCP_TOKEN=bf_pat_...`}</code></pre>

      <h2>3. Add the server to your client</h2>
      <h3>Claude Code</h3>
      <pre><code>{`claude mcp add --transport http basefyio ${mcpUrl} \\
  --header "Authorization: Bearer \${BASEFYIO_MCP_TOKEN}"`}</code></pre>

      <h3>Clients configured with mcpServers</h3>
      <p>
        For example a <code>.mcp.json</code> at the root of your project. The{" "}
        <code>{"${BASEFYIO_MCP_TOKEN}"}</code> placeholder is filled from the environment by clients that
        support it; check your client&apos;s documentation for its syntax.
      </p>
      <pre><code>{`{
  "mcpServers": {
    "basefyio": {
      "type": "http",
      "url": "${mcpUrl}",
      "headers": { "Authorization": "Bearer \${BASEFYIO_MCP_TOKEN}" }
    }
  }
}`}</code></pre>

      <h2>Tools and the permission each needs</h2>
      <p>
        A tool appears in the agent&apos;s tool list only when the token holds its permission, and the
        permission is checked again on every call.
      </p>
      <table>
        <thead>
          <tr><th>Tool</th><th>Permission</th><th>What it does</th></tr>
        </thead>
        <tbody>
          {TOOLS.map(([name, scope, desc]) => (
            <tr key={name}>
              <td><code>{name}</code></td>
              <td><code>{scope}</code></td>
              <td>{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>How access is enforced</h2>
      <ul>
        <li>
          <strong>Every request is checked afresh.</strong> The server keeps no session: a revoked or
          expired token is refused on its next request.
        </li>
        <li>
          <strong>Projects are checked on every call.</strong> A tool that names a project only runs when
          the token&apos;s owner is a member of that project&apos;s team. A token limited to one team cannot
          reach any other team&apos;s project.
        </li>
        <li>
          <strong>Read-only SQL is enforced by the database.</strong> <code>query_sql</code> accepts one
          SELECT, WITH, VALUES, TABLE or EXPLAIN statement, runs it in a read-only transaction and rolls it
          back, so a write hidden inside a function fails too.
        </li>
        <li>
          <strong>No secrets.</strong> No tool returns a database password, a project key or a connection
          string, and no tool rotates or reveals keys or deletes a project.
        </li>
        <li>
          <strong>Owner rights.</strong> Data and SQL tools act with the project owner&apos;s rights, as the
          dashboard does: row-level security does not filter them. <code>run_sql</code> can drop tables;
          give it only to agents you would trust in the SQL editor.
        </li>
        <li>
          <strong>Limits.</strong> 120 requests per minute per token, at most 200 rows per page, and an
          answer longer than 100,000 characters is cut and says so.
        </li>
        <li>
          <strong>Audit.</strong> Every tool call is recorded with the token, the tool, the project and
          the outcome — never the arguments.
        </li>
      </ul>

      <h2>Protocol details</h2>
      <ul>
        <li>Endpoint: <code>POST {mcpUrl}</code> (Streamable HTTP, stateless, JSON responses)</li>
        <li>Authentication: <code>Authorization: Bearer bf_pat_...</code>; dashboard sessions are not accepted</li>
        <li>
          A missing, revoked or expired token gets <code>401</code>; a token with no MCP permission gets{" "}
          <code>403</code>; a denied tool call returns an error result naming the reason
        </li>
      </ul>
    </div>
  );
}
