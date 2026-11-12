/**
 * How long backups are kept, and how backup archives are told apart.
 *
 * Every window is an environment setting so an operator can lengthen it once
 * the disk allows; the defaults keep today's behaviour. The dashboard shows the
 * configured values, never a hard-coded number.
 *
 *   PITR_RETENTION_DAYS        (default 7)  per-project snapshots and archived
 *                                           WAL kept for point-in-time recovery
 *   PITR_CLUSTER_BASE_RETAIN   (default 3)  physical cluster bases kept; exact
 *                                           replay reaches back to the oldest
 *   AUTO_BACKUP_RETENTION_DAYS (default 7)  nightly and on-demand archives
 */
import { envInt } from './backup-env';

/** Upper bounds stop a typo (e.g. 300) from silently filling the disk. */
const MAX_PITR_DAYS = 35;
const MAX_CLUSTER_BASES = 35;
const MAX_ARCHIVE_DAYS = 90;

const clamp = (n: number, max: number) => Math.min(max, Math.max(1, n));

export function pitrRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return clamp(envInt('PITR_RETENTION_DAYS', 7, env), MAX_PITR_DAYS);
}

export function pitrClusterBaseRetain(env: NodeJS.ProcessEnv = process.env): number {
  return clamp(envInt('PITR_CLUSTER_BASE_RETAIN', 3, env), MAX_CLUSTER_BASES);
}

export function autoBackupRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  return clamp(envInt('AUTO_BACKUP_RETENTION_DAYS', 7, env), MAX_ARCHIVE_DAYS);
}

/** Manual exports live in their own bucket for a day. */
export const MANUAL_EXPORT_TTL_HOURS = 24;

/** On-demand backups a project may hold at once (they share the nightly retention). */
export const MAX_ON_DEMAND_BACKUPS = 5;

/**
 * Nightly archives are named `<job>-auto-backup-<slug>-<ts>.zip`; on-demand
 * ones `<job>-backup-<slug>-<ts>.zip`. Both live in the auto-backup bucket.
 */
export function backupTrigger(objectKey: string): 'scheduled' | 'on-demand' {
  const leaf = objectKey.split('/').pop() ?? objectKey;
  return /^[^-]+-auto-backup-/.test(leaf) || leaf.startsWith('auto-backup-') ? 'scheduled' : 'on-demand';
}

/** A dashboard-requested PITR snapshot is refused when the last one is younger than this. */
export const PITR_SNAPSHOT_MIN_INTERVAL_MS = 10 * 60_000;

/** Physical bases are stored one folder per base: `<prefix><stamp>/<file>`. */
export function countClusterBases(objectNames: string[], prefix: string): number {
  return new Set(objectNames.map((n) => n.slice(prefix.length).split('/')[0])).size;
}

/**
 * Whole minutes since the newest snapshot when it is too recent to take
 * another (so the caller can say so), or null when a new one is allowed.
 */
export function snapshotTooRecent(
  newestMs: number,
  nowMs: number,
  minIntervalMs: number = PITR_SNAPSHOT_MIN_INTERVAL_MS,
): number | null {
  if (!newestMs || nowMs - newestMs >= minIntervalMs) return null;
  return Math.max(1, Math.round((nowMs - newestMs) / 60_000));
}
