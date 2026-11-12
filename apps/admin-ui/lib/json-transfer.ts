/**
 * Export / import helpers for JSON documents (collections and entities).
 * Export writes a JSON array file; import reads one back.
 */

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Read an import file: a JSON array of objects, a single object, or
 * newline-delimited JSON (one object per line). Throws a readable Error.
 */
export async function readJsonDocuments(file: File): Promise<Record<string, unknown>[]> {
  const text = await file.text();
  let docs: unknown;
  try {
    docs = JSON.parse(text);
  } catch {
    try {
      docs = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      throw new Error(`${file.name} is not valid JSON (expected an array of objects or one object per line)`);
    }
  }
  const list = Array.isArray(docs) ? docs : [docs];
  const bad = list.findIndex((d) => typeof d !== 'object' || d === null || Array.isArray(d));
  if (bad !== -1) throw new Error(`Item ${bad + 1} in ${file.name} is not a JSON object`);
  return list as Record<string, unknown>[];
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The Data Engine document envelope — owned by the engine, never part of the user data. */
export const ENVELOPE_FIELDS = new Set([
  '_id', '_entity', '_projectId', '_schemaVersion', '_version', '_lastEventId',
  '_eventSequence', '_status', '_createdAt', '_updatedAt', '_createdBy', '_deletedAt',
]);

/** Strip the envelope (`_id`, `_version`, …) so exported entity documents can be re-imported. */
export function withoutEnvelope(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) if (!ENVELOPE_FIELDS.has(k)) out[k] = v;
  return out;
}
