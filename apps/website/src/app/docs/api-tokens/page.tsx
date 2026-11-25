import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "Drive your basefyio account and projects from scripts and agents with API tokens: which routes take a token, the permission each needs, and how a token stays inside its team.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/api-tokens", {
    title: "API Tokens",
    description: pageDescription,
    openGraph: {
      title: "API Tokens | basefyio Docs",
      description: pageDescription,
    },
  });
}

/** Area, routes, permissions. Mirrors docs/reference/api-tokens.md in the repository. */
const AREAS: [string, string, string][] = [
  ["Projects", "/api/projects, /api/projects/:id, imports, /api/projects/:id/branches", "projects:read · projects:write"],
  ["Project settings", "row limit, connection limit, /api/project-folders, /api/project-tags, AI disclosure", "settings:read · settings:write"],
  ["Credentials", "/api/projects/:projectId/api-keys, database passwords and roles", "secrets:read · secrets:write"],
  ["Database objects", "/api/projects/:projectId/database/* (indexes, triggers, functions, extensions, policies)", "schema:read · schema:write"],
  ["Data import", "/api/projects/:projectId/data-imports/*", "data:read · data:write"],
  ["Exports, backups, recovery", "/api/projects/:id/export, /backups, /pitr", "backups:read · backups:write"],
  ["Activity", "/api/projects/:id/activity", "logs:read"],
  ["Embeddings", "/api/projects/:projectId/embeddings/*", "embeddings:read · embeddings:write"],
  ["Realtime", "/api/projects/:projectId/realtime-bindings", "realtime:read · realtime:write"],
  ["Integrations", "/api/projects/:projectId/integrations/*, /api/team-integrations/:teamId/*", "integrations:read · integrations:write"],
  ["Sheet to App", "/api/blueprints, /api/migrations/:runId", "blueprints:read · blueprints:write"],
  ["Teams", "/api/teams, members, roles, invitations", "team:read · team:write"],
  ["Billing (read only)", "subscription, usage, project costs, invoices, billing account, payment method", "billing:read"],
  ["Notifications", "/api/notifications", "account:read · account:write"],
  ["Feedback", "/api/feedback, comments, history", "feedback:read · feedback:write"],
];

export default function ApiTokensDocs() {
  const base = `${getPublicApiUrl()}/api`;

  return (
    <div>
      <h1>API Tokens</h1>
      <p>
        An API token (<code>bf_pat_…</code>) lets a script, a CI job or an AI agent manage your account and
        projects without signing in to the dashboard. Each token holds a set of permissions (scopes) and,
        optionally, a team: it can do what those permissions allow, inside that team, and nothing else.
      </p>
      <p>
        API tokens are for the management API. Your application&apos;s own data traffic (rows, storage,
        SQL, auth) uses the project&apos;s keys instead; see <a href="/docs/api">API Reference</a>.
      </p>

      <h2>Create a token</h2>
      <p>
        Open <strong>Account → API Tokens</strong> and choose <strong>Create Token</strong>. Name it, turn on
        only the permissions it needs, pick a team if it should stay inside one, and set an expiry for
        automation. The token is shown once; copy it then. Lost tokens are rolled, not recovered.
      </p>

      <h2>Use it</h2>
      <pre><code>{`curl -s ${base}/projects?teamId=<TEAM_ID> \\
  -H "Authorization: Bearer $BASEFYIO_TOKEN"            # needs projects:read

curl -s -X POST ${base}/projects/<PROJECT_ID>/database/indexes \\
  -H "Authorization: Bearer $BASEFYIO_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"table":"orders","columns":["customer_id"]}'      # needs schema:write`}</code></pre>

      <h2>Where a token is accepted</h2>
      <p>
        Reading (<code>GET</code>) needs the area&apos;s <code>:read</code> permission; creating, changing
        and deleting (<code>POST</code>, <code>PUT</code>, <code>PATCH</code>, <code>DELETE</code>) need its{" "}
        <code>:write</code> permission.
      </p>
      <table>
        <thead>
          <tr><th>Area</th><th>Routes</th><th>Permissions</th></tr>
        </thead>
        <tbody>
          {AREAS.map(([area, routes, scopes]) => (
            <tr key={area}>
              <td>{area}</td>
              <td><code>{routes}</code></td>
              <td><code>{scopes}</code></td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Always a dashboard session</h3>
      <p>These answer <code>403</code> to any token, whatever its permissions:</p>
      <ul>
        <li>creating, rolling, listing or revoking API tokens</li>
        <li>sign-in, profile, MFA and organizations</li>
        <li>every billing change: checkout, payment methods, plan changes, cancelling or resuming</li>
        <li>
          creating, deleting or leaving a team, transferring ownership, changing a team&apos;s security or
          role permissions, answering an invitation, and moving a project to another team
        </li>
        <li>the dashboard assistant, search and suggestions</li>
      </ul>
      <p>
        Routes for a project&apos;s own data (tables, rows, storage, SQL, flows) take the project&apos;s keys,
        not an API token. An agent that needs SQL or data access with a token can use the{" "}
        <a href="/docs/mcp">MCP server</a>.
      </p>

      <h2>How access is enforced</h2>
      <ul>
        <li>
          <strong>Closed by default.</strong> A route accepts a token only when it names the permission it
          needs. Any route that does not is refused with <code>403</code>, so a new feature never becomes
          reachable with a token by accident.
        </li>
        <li>
          <strong>Team restriction.</strong> A token created for one team gets <code>403</code>{" "}
          <code>This API token is limited to another team.</code> on any project or team of another team,
          and lists only show its own team, even when you belong to several teams.
        </li>
        <li>
          <strong>Your rights, never more.</strong> The token acts as you: it reaches only teams you are a
          member of, and your team role still applies to every action.
        </li>
      </ul>

      <h2>Errors</h2>
      <table>
        <thead>
          <tr><th>Status</th><th>Meaning</th></tr>
        </thead>
        <tbody>
          <tr><td><code>401</code></td><td>Missing, invalid, revoked or expired token</td></tr>
          <tr>
            <td><code>403</code></td>
            <td>
              The token lacks the permission (<code>API token is missing required scope(s): …</code>), the
              route needs a dashboard session, or the target belongs to another team
            </td>
          </tr>
          <tr><td><code>404</code></td><td>The project or resource is not in a team the token can reach</td></tr>
        </tbody>
      </table>
    </div>
  );
}
