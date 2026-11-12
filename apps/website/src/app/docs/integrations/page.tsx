import type { Metadata } from "next";
import Link from "next/link";
import { docsMetadata } from "../docs-metadata";

const pageDescription =
  "Connect a basefyio project to GitHub and Vercel: link a repository and branch, and push the project's connection settings into a Vercel project.";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs/integrations", "Integrations", pageDescription);
}

export default function IntegrationsDocs() {
  return (
    <div>
      <h1>Integrations</h1>
      <p>
        A project can be linked to a <strong>GitHub</strong> repository and to a{" "}
        <strong>Vercel</strong> project. Both are set up on the project&apos;s{" "}
        <strong>Integrations</strong> page; only members of the project&apos;s team can see or change
        them.
      </p>

      <h2>Team connections</h2>
      <p>
        Connect GitHub and Vercel once for the whole team — with the provider&apos;s sign-in flow
        or, for GitHub, a personal access token — and every project in the team can use that
        connection instead of its own token. A project can also be given a token of its own.
      </p>

      <h2>GitHub</h2>
      <p>
        Pick a repository and a branch (<code>main</code> unless you choose another). The
        Integrations page then shows the repository&apos;s recent commits and branches next to the
        project, so you can tell which code a database change belongs to.
      </p>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>PUT</td><td><code>/api/projects/:projectId/integrations/github</code></td><td>Link a repository: <code>{`{ owner, repo, branch?, token? | useTeamToken + teamId }`}</code></td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/integrations/github</code></td><td>The linked repository</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/integrations/github/commits</code></td><td>Recent commits on the linked branch</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/integrations/github/branches</code></td><td>The repository&apos;s branches</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/integrations/github</code></td><td>Unlink</td></tr>
        </tbody>
      </table></div>

      <h2>Vercel</h2>
      <p>
        Choose the Vercel project your frontend deploys from. <strong>Sync Variables</strong> writes
        the basefyio project&apos;s settings into that Vercel project&apos;s environment variables —
        creating the ones that are missing and updating the rest — so a redeploy picks them up:
      </p>
      <div className="docs-table"><table>
        <thead><tr><th>Variable</th><th>Value</th></tr></thead>
        <tbody>
          <tr><td><code>PROJECT_ID</code></td><td>The basefyio project ID</td></tr>
          <tr><td><code>NEXT_PUBLIC_BASEFYIO_URL</code></td><td>The URL your frontend calls basefyio on</td></tr>
          <tr><td><code>NEXT_PUBLIC_BASEFYIO_ANON_KEY</code></td><td>The anon key — safe in the browser</td></tr>
          <tr><td><code>BASEFYIO_SERVICE_ROLE_KEY</code></td><td>The service key — server-side code only</td></tr>
          <tr><td><code>DATABASE_URL</code></td><td>Database URI through the connection pooler</td></tr>
          <tr><td><code>DIRECT_URL</code></td><td>Direct database URI, for migrations</td></tr>
        </tbody>
      </table></div>
      <p>
        The page also lists the Vercel project&apos;s recent deployments.
      </p>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>PUT</td><td><code>/api/projects/:projectId/integrations/vercel</code></td><td>Link a Vercel project</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/integrations/vercel</code></td><td>The linked Vercel project</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:projectId/integrations/vercel/deployments</code></td><td>Recent deployments</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:projectId/integrations/vercel/sync-env</code></td><td>Write the variables above into Vercel</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:projectId/integrations/vercel</code></td><td>Unlink</td></tr>
        </tbody>
      </table></div>
      <p>
        These routes take a dashboard session. Keep the service key out of client code even when
        it sits in your Vercel settings — see <Link href="/docs/security">Security &amp; RLS</Link>.
      </p>
    </div>
  );
}
