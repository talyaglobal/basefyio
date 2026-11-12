import type { Metadata } from "next";
import Link from "next/link";
import { docsMetadata } from "../docs-metadata";

const pageDescription =
  "Protect a basefyio project: on-demand ZIP exports, nightly backups you can restore, restore verification, and point-in-time recovery of the database.";

export async function generateMetadata(): Promise<Metadata> {
  return docsMetadata("/docs/backups", "Backups & PITR", pageDescription);
}

export default function BackupsDocs() {
  return (
    <div>
      <h1>Backups &amp; point-in-time recovery</h1>
      <p>
        Three layers protect a project, all reachable from its <strong>Backup &amp; Export</strong>{" "}
        page in the dashboard:
      </p>
      <div className="docs-table"><table>
        <thead><tr><th>Layer</th><th>What it holds</th><th>How long</th></tr></thead>
        <tbody>
          <tr><td><strong>Export</strong></td><td>A ZIP you ask for: database, auth users, storage objects and configuration (each part optional)</td><td>Downloadable for 24 hours</td></tr>
          <tr><td><strong>Nightly backup</strong></td><td>Database, auth and configuration, taken every night at 03:00 UTC (storage objects are not included)</td><td>7 days</td></tr>
          <tr><td><strong>Point-in-time recovery</strong></td><td>Continuous database history: recover to any instant inside the window</td><td>7 days, to the second</td></tr>
        </tbody>
      </table></div>

      <h2>Export a project</h2>
      <p>
        Choose what to include and start the export. It runs in the background; the page follows
        its progress and offers the download when it is ready. Over the API, with a dashboard
        session:
      </p>
      <pre><code>{`POST /api/projects/:id/export
{ "includeDatabase": true, "includeAuth": true, "includeStorage": true, "includeConfig": true }
→ { "jobId": "…" }

GET /api/projects/:id/export/jobs/:jobId/status     # { state, progress, … }
GET /api/projects/:id/export/jobs/:jobId/download   # the ZIP, once finished`}</code></pre>
      <p>
        The <Link href="/docs/cli">CLI</Link> wraps the same steps as <code>basefyio backup</code>.
        An export can be imported into a new project, here or on a self-hosted install.
      </p>

      <h2>Restore a backup</h2>
      <p>
        Stored archives — your exports and the nightly backups — are listed on the same page,
        newest first. Restore one into the current project (overwriting it) or into a new
        project.
      </p>
      <pre><code>{`GET  /api/projects/:id/backups            # [{ objectKey, filename, size, lastModified, kind, encrypted }]
POST /api/projects/:id/backups/restore    # { objectKey, kind, teamId, nameMode, existingProjectId? }`}</code></pre>

      <h2>Restore verification</h2>
      <p>
        A backup you have never restored is a hope, not a backup. A weekly drill restores the
        newest nightly backup of projects in rotation into a throwaway database and compares
        table and row counts with the source; the results are on the Backup &amp; Export page.
        You can verify your own project&apos;s latest backup at any time.
      </p>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>GET</td><td><code>/api/projects/:id/backups/health</code></td><td>Off-site copy state, encryption and the latest verifications</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:id/backups/verifications</code></td><td>Verification history</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:id/backups/verify</code></td><td>Verify the newest nightly backup now</td></tr>
        </tbody>
      </table></div>

      <h2>Point-in-time recovery</h2>
      <p>
        The database&apos;s write-ahead log is archived continuously, so it can be wound back to
        a chosen instant — for example the minute before a bad migration or an accidental{" "}
        <code>DELETE</code>. The page shows the earliest and latest instants you can recover to.
      </p>
      <pre><code>{`GET  /api/projects/:id/pitr/window    # { earliest, latest, continuousFrom, retentionDays, … }
POST /api/projects/:id/pitr/restore   # { "targetTime": "2026-10-21T14:05:00Z" }`}</code></pre>
      <p>
        The answer says whether the database was recovered to that exact instant (
        <code>exact: true</code>) or, when the log could not cover it, to the nearest earlier
        snapshot (<code>exact: false</code>). Recovery replaces the project&apos;s current database,
        so export first if you might want today&apos;s data back.
      </p>

      <h2>All routes</h2>
      <div className="docs-table"><table>
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>POST</td><td><code>/api/projects/:id/export</code></td><td>Start an export</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:id/export/jobs/:jobId/status</code></td><td>Export progress</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:id/export/jobs/:jobId/events</code></td><td>Export progress as a server-sent event stream</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:id/export/jobs/:jobId/download</code></td><td>Download the finished ZIP</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:id/backups</code></td><td>Stored exports and nightly backups</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:id/backups/restore</code></td><td>Restore a stored archive</td></tr>
          <tr><td>GET</td><td><code>/api/projects/:id/pitr/window</code></td><td>The recoverable time range</td></tr>
          <tr><td>POST</td><td><code>/api/projects/:id/pitr/restore</code></td><td>Recover the database to an instant</td></tr>
        </tbody>
      </table></div>
      <p>
        Running basefyio yourself? Enabling continuous archiving and off-site copies is covered in
        the <Link href="/docs/self-hosting#backups">Self-Hosting guide</Link>.
      </p>
    </div>
  );
}
