import { BadRequestException } from '@nestjs/common';
import {
  assertAuditDateRange,
  auditKeysetQuery,
  decodeAuditCursor,
  encodeAuditCursor,
  parseAuditDirection,
  shapeAuditPage,
} from './audit-pagination';

const row = (n: number) => ({ id: `id-${String(n).padStart(3, '0')}`, createdAt: new Date(Date.UTC(2026, 9, 21, 0, 0, n)) });

/** An in-memory audit table, newest first, with the same keyset rules as the database. */
function runQuery(table: ReturnType<typeof row>[], q: ReturnType<typeof auditKeysetQuery>, take: number) {
  const cmp = (a: ReturnType<typeof row>, b: ReturnType<typeof row>) =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  let rows = [...table];
  const or = (q.where as any)?.OR as any[] | undefined;
  if (or) {
    rows = rows.filter((r) =>
      or.some((cond) => {
        const c = cond.createdAt;
        if (c instanceof Date) {
          const op = Object.keys(cond.id)[0];
          return r.createdAt.getTime() === c.getTime() && (op === 'lt' ? r.id < cond.id.lt : r.id > cond.id.gt);
        }
        return c.lt ? r.createdAt < c.lt : r.createdAt > c.gt;
      }),
    );
  }
  rows.sort(cmp);
  if (q.orderBy[0].createdAt === 'desc') rows.reverse();
  return rows.slice(0, take + 1);
}

describe('audit keyset paging', () => {
  // 7 rows, two of them sharing a timestamp; pages of 3.
  const table = [row(1), row(2), row(3), row(4), row(5), row(6), row(7)];
  table.push({ id: 'id-0055', createdAt: row(5).createdAt });
  const take = 3;

  const page = (direction: any, cursor: string | null = null) => {
    const q = auditKeysetQuery(direction, cursor ? decodeAuditCursor(cursor) : null);
    return shapeAuditPage(direction, runQuery(table, q, take), take);
  };

  it('walks newest to oldest and back without gaps or repeats', () => {
    const p1 = page('first');
    expect(p1.rows.map((r) => r.id)).toEqual(['id-007', 'id-006', 'id-0055']);
    expect(p1).toMatchObject({ hasPrev: false, hasNext: true });

    const p2 = page('next', p1.nextCursor);
    expect(p2.rows.map((r) => r.id)).toEqual(['id-005', 'id-004', 'id-003']);
    expect(p2).toMatchObject({ hasPrev: true, hasNext: true });

    const p3 = page('next', p2.nextCursor);
    expect(p3.rows.map((r) => r.id)).toEqual(['id-002', 'id-001']);
    expect(p3).toMatchObject({ hasPrev: true, hasNext: false });

    const back = page('prev', p3.prevCursor);
    expect(back.rows.map((r) => r.id)).toEqual(p2.rows.map((r) => r.id));
    expect(back).toMatchObject({ hasPrev: true, hasNext: true });

    const backToTop = page('prev', back.prevCursor);
    expect(backToTop.rows.map((r) => r.id)).toEqual(p1.rows.map((r) => r.id));
    expect(backToTop.hasPrev).toBe(false);
  });

  it('"last" lands on the oldest records with nothing after them', () => {
    const last = page('last');
    expect(last.rows.map((r) => r.id)).toEqual(['id-003', 'id-002', 'id-001']);
    expect(last).toMatchObject({ hasNext: false, hasPrev: true });
  });

  it('is not shifted by rows written while paging', () => {
    const p1 = page('first');
    // New activity arrives before "Next" is clicked.
    table.push(row(8), row(9));
    const p2 = page('next', p1.nextCursor);
    expect(p2.rows[0].createdAt.getTime()).toBeLessThanOrEqual(p1.rows[p1.rows.length - 1].createdAt.getTime());
    expect(p2.rows.map((r) => r.id)).toEqual(['id-005', 'id-004', 'id-003']);
  });
});

describe('audit cursor and inputs', () => {
  it('round-trips a cursor and rejects garbage', () => {
    const r = row(3);
    expect(decodeAuditCursor(encodeAuditCursor(r))).toEqual(r);
    expect(() => decodeAuditCursor('not-a-cursor')).toThrow(BadRequestException);
    expect(() => auditKeysetQuery('next', null)).toThrow(BadRequestException);
  });

  it('accepts the four directions only', () => {
    expect(parseAuditDirection(undefined)).toBeUndefined();
    expect(parseAuditDirection('Last')).toBe('last');
    expect(() => parseAuditDirection('sideways')).toThrow(BadRequestException);
  });

  it('refuses a start date after the end date', () => {
    expect(() => assertAuditDateRange(new Date('2026-10-22'), new Date('2026-10-01'))).toThrow(
      'The start date is after the end date',
    );
    expect(() => assertAuditDateRange(new Date('2026-10-01'), new Date('2026-10-22'))).not.toThrow();
    expect(() => assertAuditDateRange(null, new Date('2026-10-22'))).not.toThrow();
  });
});
