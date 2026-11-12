import type { Metadata } from "next";
import Link from "next/link";
import { docsMetadata } from "../docs-metadata";

const pageDescription =
  "basefyio preview branches: a separate copy of a project's database — schema only or with data — for testing changes before they reach production.";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs/branches", "Branches", pageDescription);
}

export default function BranchesDocs() {
  return (
    <div>
      <h1>Branches</h1>
      <p>
        A <strong>preview branch</strong> is a separate project in the same team whose database
        is filled from its parent. Try a migration, test a pull request or give a reviewer real
        data without touching the production project — then delete the branch.
      </p>

      <h2>Create a branch</h2>
      <p>
        Open the project&apos;s <strong>Branches</strong> page and choose{" "}
        <strong>New preview branch</strong> (pick <em>Schema only</em> or <em>Schema and data</em>), or call the API with a dashboard session or an account API
        token that has the <code>projects:write</code> scope.
      </p>
      <div className="docs-table"><table>
        <thead><tr><th>Data mode</th><th>What is copied</th></tr></thead>
        <tbody>
          <tr><td><code>schema</code> (default)</td><td>Tables, functions and row-level security policies — no rows</td></tr>
          <tr><td><code>full</code></td><td>Everything in <code>schema</code> plus every row. Refused for databases above the size limit (2 GB by default)</td></tr>
        </tbody>
      </table></div>
      <pre><code>{`POST /api/projects/:id/branches
{ "name": "add-invoices", "dataMode": "schema" }`}</code></pre>
      <p>
        The answer comes back at once with the new project and a <code>previewBranch</code> block;
        the copy runs in the background and its <code>syncStatus</code> moves from{" "}
        <code>pending</code> to <code>ready</code> (or <code>failed</code>, with{" "}
        <code>syncError</code>). The branch is an ordinary project: it has its own keys, API URL
        and connection string.
      </p>

      <h2>Rules</h2>
      <ul>
        <li>A name is 2–40 lowercase letters, digits and hyphens, unique under its parent.</li>
        <li>A project can have up to three live branches by default; a branch cannot be branched again.</li>
        <li>Only active projects with a relational database can be branched.</li>
        <li>Your plan must include branches; branches do not count against the plan&apos;s project quota.</li>
        <li>Deleting a branch moves it to the trash, like any project.</li>
      </ul>

      <h2>Routes</h2>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>POST</td><td><code>/api/projects/:id/branches</code></td><td>Create a branch of this project</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:id/branches</code></td><td>List the project&apos;s branches with their sync status</td></tr>
          <tr><td>DELETE</td><td><code>/api/projects/:id/branches/:branchId</code></td><td>Move a branch to the trash</td></tr>
        </tbody>
      </table></div>

      <hr />
      <p>
        Branches copy a database at one moment. To go back in time on the production project
        itself, use <Link href="/docs/backups">point-in-time recovery</Link>.
      </p>
    </div>
  );
}
