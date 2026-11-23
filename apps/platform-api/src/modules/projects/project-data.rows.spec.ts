import { ProjectDataService, buildStableOrderClause } from './project-data.service';

/**
 * The Table Editor row listing (feedback: "Filter rows" always 500, and pages
 * of a big table not deterministic), against a fake client that records the SQL
 * and parameters it was sent.
 */

interface Sent {
  sql: string;
  params?: unknown[];
}

function service(opts: { columns?: { column_name: string; data_type: string }[]; pk?: string[]; dataFields?: { name: string; dataTypeID: number }[] }) {
  const sent: Sent[] = [];
  const client = {
    query: async (text: string, params?: unknown[]) => {
      const sql = text.trim().replace(/\s+/g, ' ');
      sent.push({ sql, params });
      if (sql.includes('FROM information_schema.columns') && sql.includes('ORDER BY ordinal_position')) {
        return { rows: opts.columns ?? [], rowCount: (opts.columns ?? []).length };
      }
      if (sql.includes('column_name = $3')) return { rows: [{ column_name: params?.[2] }], rowCount: 1 };
      if (sql.includes('pg_index')) return { rows: (opts.pk ?? []).map((column_name) => ({ column_name })) };
      if (sql.startsWith('SELECT COUNT(*)')) return { rows: [{ total: 2 }] };
      if (sql.startsWith('SELECT t.*') && opts.dataFields) return { rows: [{ id: 1, _bf_ctid: '(0,1)' }], rowCount: 1, fields: opts.dataFields };
      if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) return { rows: [{ id: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0, fields: [] };
    },
    release: () => {},
  };
  const svc: any = Object.create(ProjectDataService.prototype);
  svc.getProjectPool = async () => ({ pool: { connect: async () => client, end: async () => {} }, project: {} });
  svc.resolveSchema = async () => 'public';
  svc.elevateForRead = async () => false;
  svc.realtimeData = { publishChange: () => {} };
  const dataQuery = () => sent.filter((s) => s.sql.startsWith('SELECT t.*')).pop()!;
  return { svc: svc as ProjectDataService, sent, dataQuery };
}

describe('ProjectDataService.getRows search', () => {
  it('casts uuid columns to text, because uuid has no ILIKE operator', async () => {
    const { svc, dataQuery } = service({
      columns: [
        { column_name: 'id', data_type: 'uuid' },
        { column_name: 'title', data_type: 'text' },
      ],
      pk: ['id'],
    });
    await svc.getRows('p1', 'u1', 'posts', 1, 50, undefined, 'abc');
    const sql = dataQuery().sql;
    expect(sql).toContain('t."id"::text ILIKE $1');
    expect(sql).toContain('t."title" ILIKE $1');
    expect(sql).not.toMatch(/t\."id" ILIKE/);
  });
});

describe('ProjectDataService.getRows ordering', () => {
  it('orders by the primary key when the caller gave no sort', async () => {
    const { svc, dataQuery } = service({ pk: ['id'] });
    await svc.getRows('p1', 'u1', 'posts');
    expect(dataQuery().sql).toContain('ORDER BY t."id" ASC LIMIT');
  });

  it('falls back to the physical row id when the table has no primary key', async () => {
    const { svc, dataQuery } = service({ pk: [] });
    await svc.getRows('p1', 'u1', 'legacy');
    expect(dataQuery().sql).toContain('ORDER BY t.ctid ASC LIMIT');
  });

  it('keeps a requested sort and appends the primary key as the tie-breaker', async () => {
    const { svc, dataQuery } = service({ pk: ['id'] });
    await svc.getRows('p1', 'u1', 'posts', 1, 50, undefined, undefined, 'name', 'desc');
    expect(dataQuery().sql).toContain('ORDER BY t."name" DESC NULLS LAST, t."id" ASC LIMIT');
  });

  it('uses every column of a composite primary key', async () => {
    const { svc, dataQuery } = service({ pk: ['org_id', 'user_id'] });
    await svc.getRows('p1', 'u1', 'members');
    expect(dataQuery().sql).toContain('ORDER BY t."org_id" ASC, t."user_id" ASC LIMIT');
  });
});

describe('ProjectDataService.getRows paging bounds', () => {
  it('never sends a negative OFFSET for page 0 or below', async () => {
    const { svc, dataQuery } = service({ pk: ['id'] });
    const out = await svc.getRows('p1', 'u1', 'posts', 0, 50);
    expect(dataQuery().params).toEqual([50, 0]);
    expect(out.page).toBe(1);
  });

  it('never sends a limit below 1', async () => {
    const { svc, dataQuery } = service({ pk: ['id'] });
    await svc.getRows('p1', 'u1', 'posts', 1, 0);
    expect(dataQuery().params).toEqual([1, 0]);
  });
});

describe('buildStableOrderClause', () => {
  it('escapes a double quote in a primary key column name', () => {
    expect(buildStableOrderClause('', ['we"ird'])).toBe('ORDER BY t."we""ird" ASC');
  });

  it('appends to an existing ORDER BY instead of starting a second one', () => {
    expect(buildStableOrderClause('ORDER BY t."a" ASC NULLS LAST', ['id'])).toBe(
      'ORDER BY t."a" ASC NULLS LAST, t."id" ASC',
    );
  });
});

describe('the internal _bf_ctid row address (#36)', () => {
  it('stays in each row for the grid\'s edit/delete but is not listed as a column', async () => {
    const { svc } = service({ pk: [], dataFields: [{ name: 'id', dataTypeID: 23 }, { name: '_bf_ctid', dataTypeID: 25 }] });
    const out: any = await svc.getRows('p1', 'u1', 'legacy');
    expect(out.fields.map((f: any) => f.name)).toEqual(['id']);
    expect(out.rows[0]._bf_ctid).toBe('(0,1)');
  });

  it('is never written by an insert', async () => {
    const { svc, sent } = service({});
    await svc.insertRow('p1', 'u1', 'legacy', { id: 1, _bf_ctid: '(9,9)' });
    const insert = sent.find((s) => s.sql.startsWith('INSERT'))!;
    expect(insert.sql).not.toContain('_bf_ctid');
    expect(insert.params).toEqual([1]);
  });

  it('is never written by an update, but still addresses the row', async () => {
    const { svc, sent } = service({});
    await svc.updateRow('p1', 'u1', 'legacy', { _bf_ctid: '(0,1)' }, { name: 'x', _bf_ctid: '(9,9)' });
    const update = sent.find((s) => s.sql.startsWith('UPDATE'))!;
    expect(update.sql).toBe('UPDATE "public"."legacy" SET "name" = $1 WHERE ctid = $2::tid RETURNING *');
    expect(update.params).toEqual(['x', '(0,1)']);
  });

  it('refuses an update that only tries to set it', async () => {
    const { svc } = service({});
    await expect(svc.updateRow('p1', 'u1', 'legacy', { _bf_ctid: '(0,1)' }, { _bf_ctid: '(9,9)' })).rejects.toThrow(/No data to update/);
  });
});
