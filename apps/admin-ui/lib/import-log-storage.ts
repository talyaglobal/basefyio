import {
  normalizeImportProgressData,
  parseProjectSupabaseImportLog,
  type ImportProgressData,
  type ProjectSupabaseImportLog,
} from './types';

const storageKey = (projectId: string) => `basefyio_supabase_import_log:${projectId}`;

/** Persist last completed import summary so Overview can show it even if API DB field is empty. */
export function saveProjectSupabaseImportLog(
  projectId: string,
  progress: ImportProgressData,
): void {
  try {
    const payload = {
      ...normalizeImportProgressData(progress),
      completedAt: new Date().toISOString(),
    };
    localStorage.setItem(storageKey(projectId), JSON.stringify(payload));
  } catch {
    /* ignore quota / private mode */
  }
}

export function loadStoredSupabaseImportLog(projectId: string): unknown {
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function logScore(log: ProjectSupabaseImportLog): number {
  const t = log.completedAt ? Date.parse(log.completedAt) : 0;
  return t * 1000 + log.warnings.length * 10 + log.database.rows;
}

/** Prefer API when newer / richer; fall back to local cache from the browser that ran the import. */
export function mergeSupabaseImportLogSources(
  apiRaw: unknown,
  storedRaw: unknown,
): ProjectSupabaseImportLog | null {
  const a = parseProjectSupabaseImportLog(apiRaw);
  const b = parseProjectSupabaseImportLog(storedRaw);
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return logScore(a) >= logScore(b) ? a : b;
}

export function shouldShowSupabaseImportLog(log: ProjectSupabaseImportLog): boolean {
  return (
    !!log.completedAt ||
    log.warnings.length > 0 ||
    log.database.failedTables.length > 0 ||
    log.auth.skipped > 0 ||
    log.database.tables > 0 ||
    log.database.rows > 0 ||
    log.auth.users > 0 ||
    log.storage.buckets > 0 ||
    log.storage.objects > 0
  );
}
