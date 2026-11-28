import { BadRequestException } from '@nestjs/common';
import { assertSafePath, compileFilterObject, compileSortObject } from '@basefyio/data-engine';

const AST_TYPES = new Set(['field', 'and', 'or', 'not']);

function parseJson(raw: string, name: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestException(`"${name}" must be valid JSON`);
  }
}

/**
 * Accepts the documented plain-object format ({ "grp": "g1", "age": { "$gt": 3 } }),
 * and the internal AST ({ "type": "field", ... }) that older clients send.
 * `raw` is the JSON text of a query parameter, or the already-parsed object of
 * a request body (vector search).
 */
export function parseFilterParam(raw?: unknown): any {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value: unknown;
  if (typeof raw === 'string') value = parseJson(raw, 'filter');
  else if (typeof raw === 'object' && !Array.isArray(raw)) value = raw;
  else throw new BadRequestException('"filter" must be an object');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const t = (value as Record<string, unknown>).type;
    if (typeof t === 'string' && AST_TYPES.has(t) && 'conditions' in value === (t === 'and' || t === 'or')) {
      return value;
    }
  }
  try {
    return compileFilterObject(value, 'filter');
  } catch (err: any) {
    throw new BadRequestException(err.message || 'Invalid filter');
  }
}

/**
 * Accepts { "field": 1 | -1 | "asc" | "desc" } and the array form
 * [{ "path": "field", "direction": "asc" | "desc" }] used by the SDK
 * (path may also be { "path": "field" }). An invalid direction is a 400.
 */
export function parseSortParam(raw?: string): any {
  if (!raw) return undefined;
  const value = parseJson(raw, 'sort');
  try {
    if (Array.isArray(value)) {
      if (value.length === 0) return undefined;
      if (value.length > 5) throw new BadRequestException('sort supports at most 5 fields');
      return value.map((item: any) => {
        const p = item && typeof item === 'object' ? (typeof item.path === 'string' ? item.path : item.path?.path) : undefined;
        if (typeof p !== 'string') throw new BadRequestException('each sort item needs a "path" string');
        assertSafePath(p, 'sort');
        const dir = item.direction === undefined ? 'asc' : item.direction;
        if (dir !== 'asc' && dir !== 'desc') {
          throw new BadRequestException(`invalid sort direction for "${p}" — use "asc" or "desc"`);
        }
        return { path: { path: p, isArrayPath: p.includes('[]') }, direction: dir };
      });
    }
    return compileSortObject(value, 'sort');
  } catch (err: any) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException(err.message || 'Invalid sort');
  }
}

const MAX_LIMIT = 1000;

function wholeNumber(raw: string, name: string): number {
  if (!/^\d+$/.test(raw.trim())) {
    throw new BadRequestException(`"${name}" must be a whole number of 0 or more`);
  }
  return parseInt(raw, 10);
}

/**
 * limit, offset and cursor of a list request. A value that is not a plain number is a 400 (it used to
 * be read as "everything" or as one record). `cursor` is the `nextCursor` the previous page returned;
 * it carries the position of the next page, so it cannot be combined with an explicit offset.
 */
export function parsePagingParams(
  limitRaw?: string,
  offsetRaw?: string,
  cursorRaw?: string,
): { limit?: number; offset?: number } {
  let limit: number | undefined;
  if (limitRaw !== undefined && limitRaw !== '') {
    limit = wholeNumber(limitRaw, 'limit');
    if (limit < 1 || limit > MAX_LIMIT) {
      throw new BadRequestException(`"limit" must be between 1 and ${MAX_LIMIT}`);
    }
  }
  const hasOffset = offsetRaw !== undefined && offsetRaw !== '';
  const hasCursor = cursorRaw !== undefined && cursorRaw !== '';
  if (hasOffset && hasCursor) {
    throw new BadRequestException('Use either "offset" or "cursor", not both');
  }
  let offset: number | undefined;
  if (hasOffset) offset = wholeNumber(offsetRaw as string, 'offset');
  if (hasCursor) offset = wholeNumber(cursorRaw as string, 'cursor');
  return { limit, offset };
}
