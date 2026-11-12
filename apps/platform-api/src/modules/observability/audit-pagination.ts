import { BadRequestException } from '@nestjs/common';

/**
 * Keyset (cursor) paging for the root audit list.
 *
 * OFFSET paging over ~1.7M rows read every skipped row (seconds per page,
 * worst at "Last"), and rows written while someone paged shifted the offsets
 * so page 2 could start with a record newer than page 1's. A cursor names the
 * row a page ends on — (created_at, id), the same order as the index — so a
 * page costs the same anywhere and live writes cannot shift it.
 */

export type AuditPageDirection = 'first' | 'next' | 'prev' | 'last';

export const AUDIT_PAGE_DIRECTIONS: AuditPageDirection[] = ['first', 'next', 'prev', 'last'];

export interface AuditCursor {
  createdAt: Date;
  id: string;
}

export function encodeAuditCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeAuditCursor(value: string): AuditCursor {
  let decoded = '';
  try {
    decoded = Buffer.from(value, 'base64url').toString('utf8');
  } catch {
    decoded = '';
  }
  const sep = decoded.indexOf('|');
  const createdAt = sep > 0 ? new Date(decoded.slice(0, sep)) : new Date(NaN);
  const id = sep > 0 ? decoded.slice(sep + 1) : '';
  if (isNaN(createdAt.getTime()) || !id || id.length > 64) {
    throw new BadRequestException('Invalid audit page cursor; reload the first page');
  }
  return { createdAt, id };
}

export function parseAuditDirection(value: string | undefined): AuditPageDirection | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  if ((AUDIT_PAGE_DIRECTIONS as string[]).includes(v)) return v as AuditPageDirection;
  throw new BadRequestException(`direction must be one of: ${AUDIT_PAGE_DIRECTIONS.join(', ')}`);
}

/**
 * The query for one page. `reverse` means the rows come back oldest-first and
 * must be flipped to the newest-first order the list shows.
 */
export function auditKeysetQuery(
  direction: AuditPageDirection,
  cursor: AuditCursor | null,
): {
  where: Record<string, unknown> | null;
  orderBy: Array<Record<string, 'asc' | 'desc'>>;
  reverse: boolean;
} {
  const desc: Array<Record<string, 'asc' | 'desc'>> = [{ createdAt: 'desc' }, { id: 'desc' }];
  const asc: Array<Record<string, 'asc' | 'desc'>> = [{ createdAt: 'asc' }, { id: 'asc' }];
  if ((direction === 'next' || direction === 'prev') && !cursor) {
    throw new BadRequestException(`A cursor is required to page ${direction}`);
  }
  switch (direction) {
    case 'first':
      return { where: null, orderBy: desc, reverse: false };
    case 'last':
      return { where: null, orderBy: asc, reverse: true };
    case 'next':
      return {
        where: {
          OR: [
            { createdAt: { lt: cursor!.createdAt } },
            { createdAt: cursor!.createdAt, id: { lt: cursor!.id } },
          ],
        },
        orderBy: desc,
        reverse: false,
      };
    case 'prev':
      return {
        where: {
          OR: [
            { createdAt: { gt: cursor!.createdAt } },
            { createdAt: cursor!.createdAt, id: { gt: cursor!.id } },
          ],
        },
        orderBy: asc,
        reverse: true,
      };
  }
}

/**
 * Turn the `take + 1` rows of a page query into the page plus whether more
 * pages exist on either side.
 */
export function shapeAuditPage<T extends { createdAt: Date; id: string }>(
  direction: AuditPageDirection,
  fetched: T[],
  take: number,
): { rows: T[]; hasNext: boolean; hasPrev: boolean; nextCursor: string | null; prevCursor: string | null } {
  const more = fetched.length > take;
  const page = fetched.slice(0, take);
  const towardOlder = direction === 'first' || direction === 'next';
  const rows = towardOlder ? page : [...page].reverse();
  const hasNext = towardOlder ? more : direction === 'prev';
  const hasPrev = towardOlder ? direction === 'next' : more;
  return {
    rows,
    hasNext: hasNext && rows.length > 0,
    hasPrev: hasPrev && rows.length > 0,
    nextCursor: rows.length ? encodeAuditCursor(rows[rows.length - 1]) : null,
    prevCursor: rows.length ? encodeAuditCursor(rows[0]) : null,
  };
}

/** A start date after the end date returns nothing; say so instead. */
export function assertAuditDateRange(from: Date | null, to: Date | null): void {
  if (from && to && from.getTime() > to.getTime()) {
    throw new BadRequestException('The start date is after the end date');
  }
}
