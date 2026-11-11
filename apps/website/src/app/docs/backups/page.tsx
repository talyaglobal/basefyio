import type { Metadata } from "next";
import { withAbsoluteSiteUrls } from "@/lib/absolute-site-metadata";

const pageDescription =
  "Backups and point-in-time recovery: nightly base backups, continuous change archiving, and how to restore a project or rewind it to an exact moment.";

export async function generateMetadata(): Promise<Metadata> {
  return withAbsoluteSiteUrls("/docs/backups", {
    title: "Backups & PITR",
    description: pageDescription,
    openGraph: {
      title: "Backups & PITR | basefyio Docs",
      description: pageDescription,
    },
  });
}

export default function BackupsDocs() {
  return (
    <div>
      <h1>Backups &amp; point-in-time recovery</h1>
      <p>
        basefyio protects every project database in two layers: a nightly backup you can restore
        from, and point-in-time recovery (PITR) that rewinds the database to a moment of your
        choice, so an accidental <code>DELETE</code> at 14:32 can be undone by recovering to 14:31.
      </p>

      <h2>How it works</h2>
      <ul>
        <li><strong>Nightly backups</strong> — taken automatically for every project; nothing to configure. The backup page of a project lists them with their health, including whether the newest one has been proven restorable.</li>
        <li><strong>Base backups and change archive</strong> — base backups run nightly and cover the whole database cluster, so they cannot be started per project. Changes are archived continuously between them.</li>
        <li><strong>Retention</strong> — the recovery window is shown in the dashboard with its start, the point exact recovery reaches back to, the latest recoverable moment and the retention in days.</li>
      </ul>

      <h2>Restore a backup</h2>
      <p>
        Open the project and choose <strong>Backup</strong>, pick a backup and restore it. Restoring
        defaults to a <strong>new project</strong>, so the original stays untouched; overwriting
        the existing project asks you to type its name first.
      </p>

      <h2>Recover to a point in time</h2>
      <ol>
        <li>Open <strong>Backup</strong> and find the <em>Point-in-time recovery</em> panel.</li>
        <li>Pick the date and time to recover to. The picker includes seconds and the confirmation shows your time zone. A time outside the recovery window is flagged before anything runs.</li>
        <li>Type <code>RESTORE</code> to confirm, then choose <strong>Recover database</strong>.</li>
      </ol>
      <p>
        Exact recovery reaches back to the start of the continuous archive. For an earlier time the
        database is restored to the nearest snapshot instead, and the panel says so. A new project
        has no base backup until the first nightly run, so recovery becomes available after that.
      </p>

      <h2>Good practice</h2>
      <ul>
        <li>Export what matters to you as well: the project <strong>Export</strong> page produces a copy you hold yourself.</li>
        <li>Try a risky migration on a <a href="/docs/branches">branch</a> first.</li>
        <li>Recovery rewinds the whole database. Anything written after the chosen moment is not in the result.</li>
      </ul>
    </div>
  );
}
