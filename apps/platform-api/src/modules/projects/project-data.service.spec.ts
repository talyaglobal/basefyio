import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  ProjectDataService,
  ROW_CHANGED_CODE,
  searchWhereClause,
  withoutInternalFields,
} from './project-data.service';

/**
 * A fake project database that answers by statement text and records every
 * statement it is sent.
 */
function harness(answer: (text: string, values?: unknown[]) => unknown = () => undefined) {
  const calls: { text: string; values?: unknown[] }[] = [];
  const client = {
    query: jest.fn(async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      // resolveSchema: the table exists in public.
      if (/FROM pg_catalog\.pg_tables/.test(text)) return { rowCount: 1, rows: [{ schemaname: 'public' }] };
      const out = answer(text, values);
      if (out instanceof Error) throw out;
      return out ?? { rows: [], fields: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client), end: jest.fn(async () => undefined) };
  const realtimeData = { publishChange: jest.fn() };
  const svc = new ProjectDataService({} as any, {} as any, realtimeData as any);
  (svc as any).getProjectPool = jest.fn(async () => ({ pool, project: { maxRowsPerTable: 1000 } }));
  return { svc, calls, realtimeData };
}

const pgError = (code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { code, ...extra });

describe('searchWhereClause (#11)', () => {
  it('casts uuid (and other non-text types) to text instead of ILIKE-ing them directly', () => {
    const where = searchWhereClause(
      [
        { column_name: 'id', data_type: 'uuid' },
        { column_name: 'name', data_type: 'text' },
        { column_name: 'n', data_type: 'integer' },
        { column_name: 'status', data_type: 'USER-DEFINED' },
        { column_name: 'meta', data_type: 'jsonb' },
      ],
      1,
    );
    expect(where).toBe(
      'WHERE (t."id"::text ILIKE $1 OR t."name" ILIKE $1 OR t."n"::text ILIKE $1 OR t."status"::text ILIKE $1)',
    );
  });

  it('quotes column names that contain a double quote', () => {
    expect(searchWhereClause([{ column_name: 'a"b', data_type: 'text' }], 2)).toBe('WHERE (t."a""b" ILIKE $2)');
  });

  it('matches nothing when no column can be searched', () => {
    expect(searchWhereClause([{ column_name: 'blob', data_type: 'bytea' }], 1)).toBe('WHERE FALSE');
  });
});

describe('ProjectDataService.getRows — stable pages (#185, #36)', () => {
  const rowsAnswer = (pk: string[]) => (text: string) => {
    if (text.includes('COUNT(*)')) return { rows: [{ total: 120 }], rowCount: 1 };
    if (text.includes('indisprimary')) return { rows: pk.map((name) => ({ name })), rowCount: pk.length };
    if (text.includes('FROM information_schema.columns') && text.includes('column_name = $3')) return { rowCount: 1, rows: [{}] };
    if (text.startsWith('SELECT t.*')) {
      return {
        rows: Array.from({ length: 51 }, (_, i) => ({ id: i, _bf_ctid: `(0,${i})`, _bf_xmin: '7' })),
        fields: [
          { name: 'id', dataTypeID: 23 },
          { name: '_bf_ctid', dataTypeID: 25 },
          { name: '_bf_xmin', dataTypeID: 25 },
        ],
      };
    }
    return undefined;
  };

  it('orders by the primary key when no sort is chosen', async () => {
    const { svc, calls } = harness(rowsAnswer(['id']));
    const res = await svc.getRows('p1', 'u1', 'items', 2, 50);
    const select = calls.find((c) => c.text.startsWith('SELECT t.*'))!;
    expect(select.text).toContain('ORDER BY t."id" ASC');
    expect(select.values).toEqual([51, 50]);
    expect(res.orderedBy).toEqual(['id']);
  });

  it('adds the key as a tie-breaker to a column sort', async () => {
    const { svc, calls } = harness(rowsAnswer(['id']));
    await svc.getRows('p1', 'u1', 'items', 1, 50, undefined, undefined, 'status', 'desc');
    const select = calls.find((c) => c.text.startsWith('SELECT t.*'))!;
    expect(select.text).toContain('ORDER BY t."status" DESC NULLS LAST, t."id" ASC');
  });

  it('reads a table without a primary key in physical order, without sorting it', async () => {
    const { svc, calls } = harness(rowsAnswer([]));
    await svc.getRows('p1', 'u1', 'legacy', 1, 50);
    const texts = calls.map((c) => c.text);
    expect(texts).toContain('SET LOCAL synchronize_seqscans = off');
    expect(texts).toContain('SET LOCAL max_parallel_workers_per_gather = 0');
    expect(texts.find((t) => t.startsWith('SELECT t.*'))).not.toContain('ORDER BY');
  });

  it('reports whether another page follows and keeps the internal fields out of `fields`', async () => {
    const { svc } = harness(rowsAnswer(['id']));
    const res = await svc.getRows('p1', 'u1', 'items', 1, 50);
    expect(res.rows).toHaveLength(50);
    expect(res.hasMore).toBe(true);
    expect(res.fields!.map((f) => f.name)).toEqual(['id']);
    expect(res.rows[0]._bf_xmin).toBe('7');
  });

  it('turns a Postgres error from a search into a 400 with its message', async () => {
    const { svc } = harness((text) => {
      if (text.includes('information_schema.columns')) return { rows: [{ column_name: 'x', data_type: 'text' }] };
      if (text.includes('COUNT(*)')) return pgError('42883', 'operator does not exist: uuid ~~* unknown');
      return undefined;
    });
    await expect(svc.getRows('p1', 'u1', 'items', 1, 50, undefined, 'row1')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ProjectDataService.updateRow — concurrent edits (#146)', () => {
  it('only updates the row version the editor read', async () => {
    const { svc, calls } = harness((text) =>
      text.startsWith('UPDATE') ? { rowCount: 1, rows: [{ id: 3, name: 'b', _bf_xmin: '9' }] } : undefined,
    );
    const row = await svc.updateRow('p1', 'u1', 'items', { id: 3 }, { name: 'b' }, undefined, '8');
    const update = calls.find((c) => c.text.startsWith('UPDATE'))!;
    expect(update.text).toContain('WHERE "id" IS NOT DISTINCT FROM $2 AND xmin::text = $3');
    expect(update.values).toEqual(['b', 3, '8']);
    expect(row._bf_xmin).toBe('9');
  });

  it('answers 409 ROW_CHANGED when someone else changed the row', async () => {
    const { svc } = harness((text) => {
      if (text.startsWith('UPDATE')) return { rowCount: 0, rows: [] };
      if (text.startsWith('SELECT 1 FROM')) return { rowCount: 1, rows: [{}] };
      return undefined;
    });
    const err = await svc.updateRow('p1', 'u1', 'items', { id: 3 }, { name: 'b' }, undefined, '8').catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ code: ROW_CHANGED_CODE });
  });

  it('answers 404 when the row is gone', async () => {
    const { svc } = harness((text) => (text.startsWith('UPDATE') || text.startsWith('SELECT 1 FROM') ? { rowCount: 0, rows: [] } : undefined));
    await expect(
      svc.updateRow('p1', 'u1', 'items', { id: 3 }, { name: 'b' }, undefined, '8'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('keeps working without a version, as before', async () => {
    const { svc, calls } = harness((text) => (text.startsWith('UPDATE') ? { rowCount: 1, rows: [{ id: 3 }] } : undefined));
    await svc.updateRow('p1', 'u1', 'items', { id: 3 }, { name: 'b' });
    expect(calls.find((c) => c.text.startsWith('UPDATE'))!.text).not.toContain('xmin::text =');
  });

  it('never writes the internal fields and keeps them out of the realtime feed', async () => {
    const { svc, calls, realtimeData } = harness((text) =>
      text.startsWith('UPDATE') ? { rowCount: 1, rows: [{ id: 3, _bf_ctid: '(0,1)', _bf_xmin: '9' }] } : undefined,
    );
    await svc.updateRow('p1', 'u1', 'items', { id: 3 }, { name: 'b', _bf_ctid: '(0,1)', _bf_xmin: '9' });
    expect(calls.find((c) => c.text.startsWith('UPDATE'))!.text).toMatch(/SET "name" = \$1 WHERE/);
    expect(realtimeData.publishChange.mock.calls[0][1].new).toEqual({ id: 3 });
  });
});

describe('ProjectDataService.insertRow (#38)', () => {
  it('inserts a row of defaults when nothing is filled in', async () => {
    const { svc, calls } = harness((text) => (text.startsWith('INSERT') ? { rowCount: 1, rows: [{ id: 1 }] } : undefined));
    await svc.insertRow('p1', 'u1', 'items', {});
    expect(calls.find((c) => c.text.startsWith('INSERT'))!.text).toContain('DEFAULT VALUES');
  });

  it('names the required column that was left empty', async () => {
    const { svc } = harness((text) =>
      text.startsWith('INSERT')
        ? pgError('23502', 'null value in column "title" violates not-null constraint', { column: 'title' })
        : undefined,
    );
    await expect(svc.insertRow('p1', 'u1', 'items', {})).rejects.toThrow('Insert failed: "title" is required');
  });
});

describe('ProjectDataService — names (#35, #37, #39)', () => {
  it('refuses a table name Postgres would cut at 63 characters', async () => {
    const { svc } = harness();
    const name = 'qa_e2e_this_is_a_very_long_table_name_exceeding_sixty_three_chars_limit_xyz';
    await expect(
      svc.createTable('p1', 'u1', name, [{ name: 'id', type: 'integer', nullable: false, isPrimary: true }]),
    ).rejects.toThrow(/is 75 characters long; PostgreSQL allows at most 63/);
  });

  it('says in words that a table with that name already exists', async () => {
    const { svc } = harness((text) => (text.includes('current_schema()') ? { rowCount: 1, rows: [{ relkind: 'r' }] } : undefined));
    const err = await svc
      .createTable('p1', 'u1', 'select', [{ name: 'id', type: 'integer', nullable: false, isPrimary: true }])
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe('A table named "select" already exists. Choose another name.');
  });

  it('creates UNIQUE columns', async () => {
    const { svc, calls } = harness();
    await svc.createTable('p1', 'u1', 'people', [
      { name: 'id', type: 'integer', nullable: false, isPrimary: true, isUnique: true },
      { name: 'email', type: 'text', nullable: false, isPrimary: false, isUnique: true },
    ]);
    const create = calls.find((c) => c.text.startsWith('CREATE TABLE'))!.text;
    expect(create).toContain('"email" text NOT NULL UNIQUE');
    expect(create).not.toContain('"id" integer NOT NULL UNIQUE');
  });

  it('refuses a column listed twice', async () => {
    const { svc } = harness();
    await expect(
      svc.createTable('p1', 'u1', 't', [
        { name: 'a', type: 'text', nullable: true, isPrimary: false },
        { name: 'a', type: 'text', nullable: true, isPrimary: false },
      ]),
    ).rejects.toThrow(/appears more than once/);
  });

  it('renames a table, refusing a name that is taken', async () => {
    const free = harness();
    await expect(free.svc.renameTable('p1', 'u1', 'old', 'new_name')).resolves.toMatchObject({ name: 'new_name' });
    expect(free.calls.map((c) => c.text)).toContain('ALTER TABLE "public"."old" RENAME TO "new_name"');

    const taken = harness((text) => (text.includes('c.relname = $2') ? { rowCount: 1, rows: [{}] } : undefined));
    await expect(taken.svc.renameTable('p1', 'u1', 'old', 'other')).rejects.toBeInstanceOf(ConflictException);
  });

  it('turns an edit column UNIQUE on and reports a rename under its new name, in one transaction', async () => {
    const { svc, calls } = harness((text) => (text.includes('pg_constraint') ? { rowCount: 0, rows: [] } : undefined));
    const res = await svc.editColumn('p1', 'u1', 'people', 'note', { name: 'note_renamed', isUnique: true });
    const texts = calls.map((c) => c.text);
    const begin = texts.indexOf('BEGIN');
    expect(texts[begin + 1]).toBe('ALTER TABLE "people" ADD CONSTRAINT "people_note_key" UNIQUE ("note")');
    expect(texts[begin + 2]).toBe('ALTER TABLE "people" RENAME COLUMN "note" TO "note_renamed"');
    expect(texts[begin + 3]).toBe('COMMIT');
    expect(res.message).toBe('Column "note" renamed to "note_renamed"');
  });

  it('maps a Postgres error from a column edit to a 400 with its message', async () => {
    const { svc } = harness((text) =>
      text.startsWith('ALTER TABLE') ? pgError('42804', 'column "n" cannot be cast automatically to type integer') : undefined,
    );
    await expect(svc.editColumn('p1', 'u1', 't', 'n', { type: 'integer' })).rejects.toThrow(
      'Failed to edit column: column "n" cannot be cast automatically to type integer',
    );
  });
});

describe('withoutInternalFields', () => {
  it('drops only the editor fields', () => {
    expect(withoutInternalFields({ id: 1, _bf_ctid: '(0,1)', _bf_xmin: '2' })).toEqual({ id: 1 });
  });
});
