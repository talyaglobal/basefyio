/**
 * Pure helpers behind `basefyio backup …` and `basefyio restore`.
 *
 * Nothing here talks to the network or the terminal, so every rule a user
 * depends on — how a backup reference is resolved, what a restore will do,
 * when a job counts as finished — can be tested without a server.
 */

import { stat as fsStat } from 'fs/promises';

// ── Shapes returned by the platform API ───────────────────────────────────

export interface CloudBackupEntry {
  objectKey: string;
  filename: string;
  size: number;
  lastModified: string;
  kind: 'manual' | 'auto';
}

export interface ExportJobProgress {
  step: string;
  detail?: string;
  percent?: number;
  error?: string;
}

export interface ExportJobResult {
  bucket: string;
  objectKey: string;
  filename: string;
  size: number;
}

export interface ExportJobStatus {
  id?: string;
  state: string;
  progress?: ExportJobProgress | number | null;
  result?: ExportJobResult;
  failedReason?: string;
  /** The status route answers `{ error: 'Job not found' }` for an unknown id. */
  error?: string;
}

export interface ArchiveImportResult {
  project: { id: string; name: string; slug: string };
  importedName: string;
  appliedName: string;
  warnings: string[];
}

/** Above this size the API's in-memory archive import is worth a warning. */
export const LARGE_ARCHIVE_WARN_BYTES = 1024 * 1024 * 1024;

// ── Project resolution ────────────────────────────────────────────────────

export function resolveProjectId(input: {
  flag?: string;
  config?: { projectId?: string } | null;
  env?: Record<string, string>;
}): string {
  const fromFlag = input.flag?.trim();
  if (fromFlag) return fromFlag;
  const fromConfig = input.config?.projectId?.trim();
  if (fromConfig) return fromConfig;
  const fromEnv = input.env?.BASEFYIO_PROJECT_ID?.trim();
  if (fromEnv) return fromEnv;
  throw new Error('Not linked to a project. Run:  basefyio link  — or pass --project <id>');
}

// ── Backup references ─────────────────────────────────────────────────────

const newestFirst = (a: CloudBackupEntry, b: CloudBackupEntry) =>
  a.lastModified < b.lastModified ? 1 : a.lastModified > b.lastModified ? -1 : 0;

/**
 * Turn what the user typed into one cloud backup.
 *
 * Accepted forms: the full object key; `latest`, `latest:auto`, `latest:manual`;
 * `#n` (the row number shown by `basefyio backup list`); or a filename, when it
 * names exactly one backup.
 */
export function resolveBackupRef(entries: CloudBackupEntry[], ref: string): CloudBackupEntry {
  const wanted = ref.trim();
  if (!wanted) throw new Error('Backup reference is empty');
  if (!entries.length) throw new Error('No cloud backups found for this project');

  const sorted = [...entries].sort(newestFirst);

  const exact = sorted.find((e) => e.objectKey === wanted);
  if (exact) return exact;

  const latest = wanted.match(/^latest(?::(auto|manual))?$/i);
  if (latest) {
    const kind = latest[1]?.toLowerCase() as 'auto' | 'manual' | undefined;
    const pool = kind ? sorted.filter((e) => e.kind === kind) : sorted;
    if (!pool.length) throw new Error(`No ${kind ?? ''} backups found for this project`.replace('  ', ' '));
    return pool[0];
  }

  const index = wanted.match(/^#(\d+)$/);
  if (index) {
    const n = parseInt(index[1], 10);
    if (n < 1 || n > sorted.length) {
      throw new Error(`Backup #${n} does not exist — the list has ${sorted.length} entr${sorted.length === 1 ? 'y' : 'ies'}`);
    }
    return sorted[n - 1];
  }

  const byName = sorted.filter((e) => e.filename === wanted);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `"${wanted}" names ${byName.length} backups — use the object key instead:\n` +
        byName.map((e) => `    ${e.objectKey}  (${e.kind}, ${e.lastModified})`).join('\n'),
    );
  }

  throw new Error(`No backup matches "${wanted}". Run:  basefyio backup list`);
}

// ── Naming and formatting ─────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0');

/** `<slug>-backup-YYYYMMDD-HHmmss.zip`, in UTC so the name is the same everywhere. */
export function defaultArchiveName(slug: string, date: Date = new Date()): string {
  const safe =
    (slug || '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  const stamp =
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
  return `${safe}-backup-${stamp}.zip`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

// ── Restore plans ─────────────────────────────────────────────────────────

export type RestorePlan =
  | { mode: 'existing'; projectId: string; teamId: string; projectName?: string }
  | { mode: 'new'; name: string; teamId: string };

export interface RestoreFields {
  teamId: string;
  nameMode: 'existing' | 'new';
  existingProjectId?: string;
  newProjectName?: string;
  objectKey?: string;
  kind?: 'manual' | 'auto';
}

/** The body the import and cloud-restore routes expect, from a plan and (for cloud) a source. */
export function buildRestoreBody(
  plan: RestorePlan,
  source?: { objectKey: string; kind: 'manual' | 'auto' },
): RestoreFields {
  const base: RestoreFields =
    plan.mode === 'existing'
      ? { teamId: plan.teamId, nameMode: 'existing', existingProjectId: plan.projectId }
      : { teamId: plan.teamId, nameMode: 'new', newProjectName: plan.name };
  if (source) {
    base.objectKey = source.objectKey;
    base.kind = source.kind;
  }
  return base;
}

/** What a restore does, stated from how the platform actually restores an archive. */
export function describeRestoreEffects(plan: RestorePlan): string[] {
  const target =
    plan.mode === 'existing'
      ? `project ${plan.projectName ? `"${plan.projectName}" ` : ''}(${plan.projectId})`
      : `a new project named "${plan.name}"`;
  const lines = [`Target: ${target}.`];
  if (plan.mode === 'existing') {
    lines.push(
      'Tables present in the archive are dropped and recreated with the archived data;',
      'tables not in the archive are left as they are.',
    );
  } else {
    lines.push('The archived tables and data are created in the new project database.');
  }
  lines.push(
    'Auth users in the archive are recreated with temporary passwords — they must reset them.',
    'Storage buckets and objects in the archive are written to the project.',
  );
  return lines;
}

// ── Multipart form for the archive import route ───────────────────────────

/** The subset of the WHATWG FormData interface this module relies on. */
export interface FormDataLike {
  append(name: string, value: unknown, filename?: string): void;
  get(name: string): unknown;
  has(name: string): boolean;
}

function formDataConstructor(): new () => FormDataLike {
  const ctor = (globalThis as unknown as { FormData?: new () => FormDataLike }).FormData;
  if (!ctor) throw new Error('This command needs Node.js 18 or newer (FormData is not available)');
  return ctor;
}

/** Text fields first, then the archive as the `file` part — the layout the import route reads. */
export function buildImportForm(
  fields: Record<string, string | undefined>,
  archive: Blob,
  filename: string,
): FormDataLike {
  const Ctor = formDataConstructor();
  const form = new Ctor();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue;
    form.append(key, value);
  }
  form.append('file', archive, filename);
  return form;
}

// ── Export job polling ────────────────────────────────────────────────────

export class ExportTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportTimeoutError';
  }
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  /** Consecutive status-fetch failures tolerated before giving up. */
  maxTransientErrors?: number;
  onProgress?: (progress: ExportJobProgress) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll an export job until it completes, fails or the timeout passes.
 *
 * Resolves with the job result (where the archive is). A `failed` job rejects
 * with its reason; an unknown job rejects immediately; a transient fetch error
 * is retried a few times before it is treated as fatal.
 */
export async function pollExportJob(
  fetchStatus: () => Promise<ExportJobStatus | null | undefined>,
  options: PollOptions = {},
): Promise<ExportJobResult> {
  const intervalMs = options.intervalMs ?? 2000;
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;
  const maxTransient = options.maxTransientErrors ?? 5;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;

  const started = now();
  let transientErrors = 0;
  let lastProgress = '';

  for (;;) {
    let status: ExportJobStatus | null | undefined;
    try {
      status = await fetchStatus();
      transientErrors = 0;
    } catch (err) {
      transientErrors++;
      if (transientErrors > maxTransient) throw err;
      status = undefined;
    }

    if (status !== undefined) {
      if (!status || status.error) {
        throw new Error(status?.error || 'Export job not found');
      }

      if (status.progress && typeof status.progress === 'object') {
        const json = JSON.stringify(status.progress);
        if (json !== lastProgress) {
          lastProgress = json;
          options.onProgress?.(status.progress);
        }
      }

      if (status.state === 'completed') {
        if (!status.result) throw new Error('Export completed but the API returned no archive location');
        return status.result;
      }
      if (status.state === 'failed') {
        throw new Error(status.failedReason || 'Export failed');
      }
    }

    if (now() - started >= timeoutMs) {
      throw new ExportTimeoutError(
        `Gave up waiting after ${Math.round(timeoutMs / 60000)} minute(s). The job may still finish — check it with:  basefyio backup status <jobId>`,
      );
    }
    await sleep(intervalMs);
  }
}

// ── Local archive detection ───────────────────────────────────────────────

/** True when `target` is an existing `.zip` file on disk (so not a cloud backup reference). */
export async function isLocalArchive(
  target: string,
  statFn: (path: string) => Promise<{ isFile(): boolean }> = fsStat,
): Promise<boolean> {
  if (!target || !target.toLowerCase().endsWith('.zip')) return false;
  try {
    const info = await statFn(target);
    return info.isFile();
  } catch {
    return false;
  }
}
