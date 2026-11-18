import { describe, expect, it } from 'vitest';
import { DatabaseClient, QueryBuilder } from './database';

/**
 * Values leave the statement.
 *
 * The API scans every statement for forbidden operations and reads string
 * literals too, because a literal is where a smuggled `COPY` would hide. So a
 * value written into SQL is refused as the operation it happens to name: a row
 * whose text said "myfyio copy would post there" could not be written at all.
 *
 * These tests hold the property that fixes it — no value a caller passes
 * appears in the statement — and the two that keep it usable: `toSQL()` still
 * inlines for reading, and a query carrying no values sends the request it
 * always did.
 */

/** Every word the API refuses, measured against production on 2026-09-17. */
const REFUSED = ['copy', 'grant', 'revoke', 'load', 'set role', 'dblink', 'lo_import', 'pg_read_file'];

interface Sent {
  path: string;
  body: Record<string, unknown>;
}

function fakeHttp(sent: Sent[], rows: Record<string, unknown>[] = []) {
  return {
    json: async (path: string, init: { body: string }) => {
      sent.push({ path, body: JSON.parse(init.body) });
      return { rows, rowCount: rows.length };
    },
  } as never;
}

function table(sent: Sent[] = [], rows: Record<string, unknown>[] = []): QueryBuilder {
  return new QueryBuilder(fakeHttp(sent, rows), 'project-1', 'agency_plan');
}

function wordIn(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

describe('QueryBuilder.toQuery — the statement carries no values', () => {
  it('puts a filter value beside the statement, not inside it', () => {
    const { text, params } = table().select().eq('note', 'page load').toQuery();

    expect(text).toBe('SELECT * FROM "agency_plan" WHERE "note" = $1');
    expect(params).toEqual(['page load']);
  });

  it('keeps every refused word out of the statement', () => {
    for (const word of REFUSED) {
      const { text, params } = table()
        .update({ error: `Refusing to publish: myfyio ${word} would post there.` })
        .eq('id', 7)
        .toQuery();

      expect(wordIn(text, word), word).toBe(false);
      expect(params[0]).toContain(word);
    }
  });

  it('numbers every value once, in order', () => {
    const { text, params } = table()
      .update({ status: 'failed', error: 'boom' })
      .eq('id', 'a')
      .neq('lang', 'tr')
      .toQuery();

    expect(text).toBe(
      'UPDATE "agency_plan" SET "status" = $1, "error" = $2 WHERE "id" = $3 AND "lang" != $4 RETURNING *',
    );
    expect(params).toEqual(['failed', 'boom', 'a', 'tr']);
  });

  it('binds every row of an insert', () => {
    const { text, params } = table()
      .insert([{ a: 1, b: 'x' }, { a: 2, b: 'y' }])
      .toQuery();

    expect(text).toBe(
      'INSERT INTO "agency_plan" ("a", "b") VALUES ($1, $2), ($3, $4) RETURNING *',
    );
    expect(params).toEqual([1, 'x', 2, 'y']);
  });

  it('asks a list with one placeholder, and answers an empty one with no rows', () => {
    const many = table().select().in('status', ['planned', 'preview']).toQuery();
    expect(many.text).toBe('SELECT * FROM "agency_plan" WHERE "status" = ANY($1)');
    expect(many.params).toEqual([['planned', 'preview']]);

    // `IN ()` is a syntax error; `= ANY` of nothing is simply no rows.
    const none = table().select().in('status', []).toQuery();
    expect(none.text).toContain('= ANY($1)');
    expect(none.params).toEqual([[]]);
  });

  it('leaves NULL and the booleans as syntax', () => {
    const { text, params } = table().select().is('error', null).toQuery();
    expect(text).toBe('SELECT * FROM "agency_plan" WHERE "error" IS NULL');
    expect(params).toEqual([]);
  });

  it('binds inside an OR group too', () => {
    const { text, params } = table()
      .select()
      .or((q) => q.eq('status', 'failed').eq('status', 'cancelled'))
      .toQuery();

    expect(text).toBe(
      'SELECT * FROM "agency_plan" WHERE ("status" = $1 OR "status" = $2)',
    );
    expect(params).toEqual(['failed', 'cancelled']);
  });

  it('sends undefined as NULL rather than dropping the placeholder', () => {
    const { text, params } = table().insert({ a: undefined }).toQuery();
    expect(text).toContain('VALUES ($1)');
    expect(params).toEqual([null]);
  });

  it('refuses a number Postgres cannot take', () => {
    expect(() => table().select().eq('n', Number.NaN).toQuery()).toThrow(/Non-finite/);
  });
});

describe('QueryBuilder.toSQL — still the readable form', () => {
  it('writes the values in, as it always did', () => {
    const sql = table().select().eq('note', "it's fine").toSQL();
    expect(sql).toBe(`SELECT * FROM "agency_plan" WHERE "note" = 'it''s fine'`);
  });

  it('still uses IN for a list', () => {
    expect(table().select().in('a', [1, 2]).toSQL()).toContain('IN (1, 2)');
  });
});

describe('LIMIT and OFFSET are counts, not values', () => {
  it('writes a whole number', () => {
    expect(table().select().limit(10).offset(20).toSQL()).toContain(
      'LIMIT 10 OFFSET 20',
    );
  });

  it('refuses anything else', () => {
    expect(() => table().select().limit(1.5).toSQL()).toThrow(/limit/);
    expect(() => table().select().offset(-1).toSQL()).toThrow(/offset/);
    // The hole this closes: a string reaching SQL through a typed parameter.
    expect(() => table().select().limit('1; DROP TABLE t' as never).toSQL()).toThrow();
  });
});

describe('what goes over the wire', () => {
  it('sends params when the query carries values', async () => {
    const sent: Sent[] = [];
    await table(sent).select().eq('status', 'failed');

    expect(sent[0]!.body).toEqual({
      projectId: 'project-1',
      query: 'SELECT * FROM "agency_plan" WHERE "status" = $1',
      params: ['failed'],
    });
  });

  it('sends the request it always did when there are none', async () => {
    // An older API has never heard of `params`, and rejects a body carrying an
    // unknown field. A query with no values must keep working against it.
    const sent: Sent[] = [];
    await table(sent).select();

    expect(sent[0]!.body).toEqual({
      projectId: 'project-1',
      query: 'SELECT * FROM "agency_plan"',
    });
    expect('params' in sent[0]!.body).toBe(false);
  });

  it('passes raw SQL params straight through', async () => {
    const sent: Sent[] = [];
    const db = new DatabaseClient(fakeHttp(sent), 'project-1');
    await db.sql('UPDATE t SET error = $1', ['myfyio copy would post there']);

    expect(sent[0]!.body.params).toEqual(['myfyio copy would post there']);
    expect(String(sent[0]!.body.query)).not.toContain('copy');
  });
});

describe('filterless mutation guard — update() and delete() without filters throw', () => {
  it('update() without a filter throws before hitting the network', () => {
    expect(() => table().update({ title: 'x' }).toSQL()).toThrow(/update\(\) requires at least one filter/);
  });

  it('update() without a filter throws in toQuery() too', () => {
    expect(() => table().update({ title: 'x' }).toQuery()).toThrow(/update\(\) requires at least one filter/);
  });

  it('delete() without a filter throws', () => {
    expect(() => table().delete().toSQL()).toThrow(/delete\(\) requires at least one filter/);
  });

  it('update() with a filter proceeds normally', () => {
    const { text } = table().update({ title: 'x' }).eq('id', 1).toQuery();
    expect(text).toBe('UPDATE "agency_plan" SET "title" = $1 WHERE "id" = $2 RETURNING *');
  });

  it('delete() with a filter proceeds normally', () => {
    const { text } = table().delete().eq('id', 5).toQuery();
    expect(text).toBe('DELETE FROM "agency_plan" WHERE "id" = $1 RETURNING *');
  });

  it('update() with an in() filter proceeds normally', () => {
    const { text } = table().update({ status: 'done' }).in('id', [1, 2, 3]).toQuery();
    expect(text).toBe('UPDATE "agency_plan" SET "status" = $1 WHERE "id" = ANY($2) RETURNING *');
  });
});

describe('single() and maybeSingle() row-count semantics', () => {
  it('single() returns the row when exactly 1 row is returned', async () => {
    const row = { id: 1, name: 'Alice' };
    const result = await table([], [row]).select().eq('id', 1).single();
    expect(result.error).toBeNull();
    expect(result.data).toEqual(row);
  });

  it('single() returns an error when 0 rows are returned', async () => {
    const result = await table([], []).select().eq('id', 999).single();
    expect(result.data).toBeNull();
    expect(result.error?.message).toMatch(/single\(\) expected exactly 1 row/);
    expect(result.error?.code).toBe('PGRST116');
  });

  it('single() returns an error when more than 1 row is returned', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const result = await table([], rows).select().single();
    expect(result.data).toBeNull();
    expect(result.error?.message).toMatch(/single\(\) expected at most 1 row/);
    expect(result.error?.code).toBe('PGRST116');
  });

  it('maybeSingle() returns null when 0 rows are returned (not an error)', async () => {
    const result = await table([], []).select().eq('id', 999).maybeSingle();
    expect(result.data).toBeNull();
    expect(result.error).toBeNull();
  });

  it('maybeSingle() returns the row when exactly 1 row is returned', async () => {
    const row = { id: 7, name: 'Bob' };
    const result = await table([], [row]).select().eq('id', 7).maybeSingle();
    expect(result.error).toBeNull();
    expect(result.data).toEqual(row);
  });

  it('maybeSingle() returns an error when more than 1 row is returned', async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const result = await table([], rows).select().maybeSingle();
    expect(result.data).toBeNull();
    expect(result.error?.message).toMatch(/maybeSingle\(\) expected at most 1 row/);
    expect(result.error?.code).toBe('PGRST116');
  });

  it('single() uses LIMIT 2 in the generated SQL', () => {
    // toSQL() is exposed on SingleQueryBuilder so callers can inspect the query.
    const qb = table().select().eq('id', 1);
    const sq = qb.single();
    expect(sq.toSQL()).toContain('LIMIT 2');
  });
});

describe('upsert conflict target', () => {
  const tbl = () => table();

  it('uses DO NOTHING when only the conflict column is supplied', () => {
    const sql = tbl().upsert({ id: 1 }, { onConflict: 'id' }).toSQL();
    expect(sql).toContain('DO NOTHING');
    expect(sql).not.toContain('DO UPDATE SET  ');
  });

  it('defaults the conflict target to id, not the first key', () => {
    const sql = tbl().upsert({ title: 'a', id: 1 }).toSQL();
    expect(sql).toContain('ON CONFLICT ("id") DO UPDATE SET "title" = EXCLUDED."title"');
  });
});
