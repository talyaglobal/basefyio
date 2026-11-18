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
 */
export function parseFilterParam(raw?: string): any {
  if (!raw) return undefined;
  const value = parseJson(raw, 'filter');
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
