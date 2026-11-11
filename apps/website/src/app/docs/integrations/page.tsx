import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio Integrations: connect a project to GitHub and Vercel, see commits and deployments, and sync your project's environment variables to Vercel.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/integrations", {
    title: "Integrations",
    description: pageDescription,
    openGraph: {
      title: "Integrations | basefyio Docs",
      description: pageDescription,
    },
  });
}

export default function IntegrationsDocs() {
  const apiUrl = getPublicApiUrl();

  return (
    <div>
      <h1>Integrations</h1>
      <p>
        Connect a project to the tools you ship with. Two providers are supported today:{" "}
        <strong>GitHub</strong> and <strong>Vercel</strong>. Each connection belongs to a single
        project, or you can connect a provider once for your whole <strong>team</strong> and reuse
        it across projects.
      </p>

      <h2>Providers</h2>
      <table>
        <thead>
          <tr><th>Provider</th><th>What you get</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>GitHub</strong></td><td>Link a repository and branch to the project, then see its recent commits and branches in the dashboard.</td></tr>
          <tr><td><strong>Vercel</strong></td><td>Link a Vercel project, see its deployments, and <strong>sync your basefyio environment variables</strong> to it in one click.</td></tr>
        </tbody>
      </table>

      <h2>In the dashboard</h2>
      <p>Open your project and choose <strong>Integrations</strong>.</p>
      <ul>
        <li><strong>GitHub</strong> — use the team&apos;s GitHub connection or provide a token, select a repository, then pick a branch (defaults to <code>main</code>). <strong>Disconnect</strong> removes the link.</li>
        <li><strong>Vercel</strong> — use the team&apos;s Vercel connection or provide a token, then select a Vercel project. <strong>Save Environment Variables</strong> pushes the variables below to that project; <strong>Disconnect</strong> removes the link.</li>
        <li><strong>Team connections</strong> — a team can connect GitHub (OAuth or a personal access token) and Vercel once, and each project then picks the team connection instead of its own token.</li>
      </ul>

      <h3>Variables synced to Vercel</h3>
      <table>
        <thead>
          <tr><th>Variable</th><th>Value</th></tr>
        </thead>
        <tbody>
          <tr><td><code>NEXT_PUBLIC_BASEFYIO_URL</code></td><td>The project&apos;s API base URL</td></tr>
          <tr><td><code>NEXT_PUBLIC_BASEFYIO_ANON_KEY</code></td><td>The anon key</td></tr>
          <tr><td><code>BASEFYIO_SERVICE_ROLE_KEY</code></td><td>The service key — keep it server-side</td></tr>
          <tr><td><code>DATABASE_URL</code>, <code>DIRECT_URL</code></td><td>Pooled and direct database connection strings</td></tr>
          <tr><td><code>PROJECT_ID</code></td><td>The project id</td></tr>
        </tbody>
      </table>
      <p className="text-sm">
        Existing variables with the same name are updated; the response reports how many were
        created and updated.
      </p>

      <h2>REST API</h2>
      <p>
        Routes are under <code>{`${apiUrl}/api/projects/:projectId/integrations`}</code> and need a
        dashboard session.
      </p>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>PUT</td><td><code>/github</code></td><td>Connect <code>{`{ owner, repo, branch?, token? | useTeamToken, teamId? }`}</code></td></tr>
          <tr><td>GET</td><td><code>/github</code></td><td>Connection status</td></tr>
          <tr><td>DELETE</td><td><code>/github</code></td><td>Disconnect</td></tr>
          <tr><td>GET</td><td><code>/github/repos</code></td><td>List the token&apos;s repositories (<code>?token=</code>)</td></tr>
          <tr><td>GET</td><td><code>/github/commits</code></td><td>Recent commits of the linked repository</td></tr>
          <tr><td>GET</td><td><code>/github/branches</code></td><td>Branches of the linked repository</td></tr>
          <tr><td>PUT</td><td><code>/vercel</code></td><td>Connect <code>{`{ projectId, teamId?, token? | useTeamToken, sourceTeamId? }`}</code></td></tr>
          <tr><td>GET</td><td><code>/vercel</code></td><td>Connection status</td></tr>
          <tr><td>DELETE</td><td><code>/vercel</code></td><td>Disconnect</td></tr>
          <tr><td>GET</td><td><code>/vercel/projects</code></td><td>List Vercel projects (<code>?token=&amp;teamId=</code>)</td></tr>
          <tr><td>GET</td><td><code>/vercel/deployments</code></td><td>Recent deployments</td></tr>
          <tr><td>POST</td><td><code>/vercel/sync-env</code></td><td>Push the variables above to the linked Vercel project</td></tr>
        </tbody>
      </table>
      <pre><code>{`# Connect a GitHub repository, then read its latest commits
curl -s -X PUT ${apiUrl}/api/projects/$PROJECT_ID/integrations/github \\
  -H "Authorization: Bearer $SESSION_TOKEN" -H "Content-Type: application/json" \\
  -d '{"token":"ghp_...","owner":"my-org","repo":"my-app","branch":"main"}'
curl -s ${apiUrl}/api/projects/$PROJECT_ID/integrations/github/commits \\
  -H "Authorization: Bearer $SESSION_TOKEN"`}</code></pre>

      <h2>Notes</h2>
      <ul>
        <li>Connecting needs a token with access to the repository or Vercel project, or a team connection that already has one.</li>
        <li>Syncing writes your <strong>service key</strong> into Vercel; only link a Vercel project you trust with it.</li>
        <li>Integrations are managed from the dashboard session; they are not available with a project API key.</li>
      </ul>
    </div>
  );
}
