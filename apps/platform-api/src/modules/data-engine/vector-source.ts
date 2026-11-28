import * as crypto from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { assertSafePath } from '@basefyio/data-engine';

/** Most source paths a platform-mode entity may name. */
export const MAX_SOURCE_PATHS = 8;
/**
 * Longest source text sent to the provider. Embedding models accept about
 * 8 000 tokens; 24 000 characters stays below that for most text. Longer
 * text is cut here (and the hash is of the cut text, what was embedded).
 */
export const MAX_SOURCE_CHARS = 24_000;

/**
 * `sourcePaths` of a platform-mode entity: 1..8 distinct dot paths under the
 * record's data, each passing the same safe-path rule as filters and sorts.
 * Array paths (`tags[]`) are not accepted: name the array itself instead.
 */
export function validateSourcePaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_SOURCE_PATHS) {
    throw new BadRequestException(`sourcePaths must be an array of 1 to ${MAX_SOURCE_PATHS} field paths`);
  }
  const seen = new Set<string>();
  raw.forEach((p, i) => {
    if (typeof p !== 'string' || p.trim() === '') {
      throw new BadRequestException(`sourcePaths[${i}] must be a non-empty string`);
    }
    if (p.split('.').some((seg) => seg.startsWith('$'))) {
      throw new BadRequestException(`sourcePaths[${i}]: a field path segment may not start with "$"`);
    }
    if (p.includes('[]')) {
      throw new BadRequestException(`sourcePaths[${i}]: name the array field itself, without []`);
    }
    try {
      assertSafePath(p, `sourcePaths[${i}]`);
    } catch (err: any) {
      throw new BadRequestException(err?.message ?? `sourcePaths[${i}] is not a valid field path`);
    }
    if (seen.has(p)) throw new BadRequestException(`sourcePaths[${i}] "${p}" is listed twice`);
    seen.add(p);
  });
  return raw as string[];
}

function valueAt(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/**
 * The text a platform vector is computed from: the value at each source path,
 * in the declared order, joined with "\n". Strings are used as they are;
 * numbers and booleans (and objects or arrays) as JSON text; missing paths,
 * null and empty strings are skipped. An empty result means "nothing to
 * embed". Cut at MAX_SOURCE_CHARS.
 */
export function buildSourceText(data: unknown, paths: string[]): string {
  const parts: string[] = [];
  for (const path of paths) {
    const v = valueAt(data, path);
    if (v === undefined || v === null) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    if (text === undefined || text.trim() === '') continue;
    parts.push(text);
  }
  const joined = parts.join('\n');
  return joined.length > MAX_SOURCE_CHARS ? joined.slice(0, MAX_SOURCE_CHARS) : joined;
}

/** sha256 (hex) of the source text: a record whose text did not change is not embedded again. */
export function sourceHash(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
