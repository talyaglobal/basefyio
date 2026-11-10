import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";
import { getPublicApiUrl } from "@/lib/site-url";

const pageDescription =
  "basefyio Branches: disposable preview projects created from a project's schema (and optionally its data), to try a migration or feature without touching the original.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/branches", {
    title: "Branches",
    description: pageDescription,
    openGraph: {
      title: "Branches | basefyio Docs",
      description: pageDescription,
    },
  });
}

export default function BranchesDocs() {
  const apiUrl = getPublicApiUrl();

  return (
    <div>
      <h1>Branches</h1>
      <p>
        A <strong>preview branch</strong> is a separate project with its own database, auth realm
        and API keys, created from another project&apos;s schema (and optionally its data). Try a
        migration or a feature there; the original project is never touched. Branches are meant to
        be disposable — a pull request, a staging copy, an experiment.
      </p>

      <h2>What a branch copies</h2>
      <table>
        <thead>
          <tr><th>Mode</th><th>Copies</th></tr>
        </thead>
        <tbody>
          <tr><td><strong>Schema only</strong> (default)</td><td>Tables, views, functions and policies, with no rows. Fast at any size.</td></tr>
          <tr><td><strong>Schema and data</strong></td><td>Everything above plus every row as of the moment you create it. Refused when the database is larger than the full-copy limit (2&nbsp;GB by default) — branch schema-only instead.</td></tr>
        </tbody>
      </table>
      <p>
        <strong>Not copied:</strong> auth users, storage files, flows and realtime settings. A
        branch starts with an empty auth realm and empty buckets, and gets its own API keys.
      </p>

      <h2>In the dashboard</h2>
      <p>Open your project and choose <strong>Branches</strong>.</p>
      <ul>
        <li><strong>New branch</strong> — enter a name such as <code>pr-42</code> or <code>staging</code> and choose <em>Schema only</em> or <em>Schema and data</em>. The branch appears in the list while it is being populated and shows <code>pending</code>, <code>ready</code> or <code>failed</code>; a failure shows its reason.</li>
        <li>Open a branch like any other project, with its own tables, keys and connection details.</li>
        <li><strong>Delete</strong> — moves the branch to the trash, like any project. It is purged after 24 hours, and its name is free again immediately.</li>
      </ul>

      <h2>Rules and limits</h2>
      <ul>
        <li>Names are 2–40 characters: lowercase letters, digits and hyphens, starting and ending with a letter or digit. A name is unique per parent project.</li>
        <li>Only an <strong>active PostgreSQL project</strong> can be branched. NoSQL projects, projects on a dedicated database and projects that are not active are refused.</li>
        <li>Branches are one level deep: a branch cannot be branched again — create further branches from the parent.</li>
        <li>Up to <strong>3 live branches per project</strong> by default; delete one to create another.</li>
        <li>Branching is part of your plan&apos;s entitlements; creating a branch is refused if the plan does not include it.</li>
        <li>
          There is <strong>no merge</strong>. A branch is a copy to experiment on; to bring a
          change back, run the same migration on the parent project.
        </li>
      </ul>

      <h2>REST API</h2>
      <p>
        Routes are under <code>{`${apiUrl}/api/projects/:projectId/branches`}</code>, where{" "}
        <code>:projectId</code> is the <strong>parent</strong> project. They need a dashboard
        session or a platform API token with the <code>projects:read</code> (list) or{" "}
        <code>projects:write</code> (create, delete) scope.
      </p>
      <table>
        <thead>
          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td>GET</td><td><code>/</code></td><td>List branches (name, status, data mode, sync status and error, created)</td></tr>
          <tr><td>POST</td><td><code>/</code></td><td>Create <code>{`{ name, dataMode? }`}</code> — <code>dataMode</code> is <code>&quot;schema&quot;</code> (default) or <code>&quot;full&quot;</code></td></tr>
          <tr><td>DELETE</td><td><code>/:branchId</code></td><td>Move the branch to the trash</td></tr>
        </tbody>
      </table>

      <h3>Example</h3>
      <pre><code>{`# Create a schema-only branch
curl -s -X POST ${apiUrl}/api/projects/$PROJECT_ID/branches \\
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
  -d '{"name":"pr-42","dataMode":"schema"}'

# List branches, then delete one
curl -s ${apiUrl}/api/projects/$PROJECT_ID/branches -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE ${apiUrl}/api/projects/$PROJECT_ID/branches/$BRANCH_ID -H "Authorization: Bearer $TOKEN"`}</code></pre>
      <p className="text-sm">
        Creation returns right away with the new project and its <code>previewBranch</code> details;
        the copy continues in the background, so poll the list until the sync status is{" "}
        <code>ready</code>.
      </p>
    </div>
  );
}
