import { describe, expect, it } from 'vitest';
import { QueryBuilder } from './database';

/**
 * Writes that cannot silently take the whole table, single() that means one
 * row, upserts that produce valid SQL, and select lists beyond bare columns.
 */

interface Sent {
  path: string;
  headers?: Record<string, string>;
  body: unknown;
}

function fakeHttp(sent: Sent[], reply: (path: string, body: any) => unknown = () => ({ rows: [], rowCount: 0 })) {
  return {
    json: async (path: string, init: { body: string; headers?: Record<string, string> }) => {
      const body = JSON.parse(init.body);
      sent.push({ path, headers: init.headers, body });
      const out = reply(path, body);
      if (out instanceof Error || (out && typeof out === 'object' && 'throws' in (out as object))) {
        throw (out as { throws: unknown }).throws ?? out;
      }
      return out;
    },
  } as never;
}

const table = (sent: Sent[] = [], reply?: (path: string, body: any) => unknown) =>
  new QueryBuilder(fakeHttp(sent, reply), 'project-1', 'posts');

describe('unfiltered update() and delete() are refused (#166)', () => {
  it('refuses an update with no filter, before sending anything', async () => {
    const sent: Sent[] = [];
    const { data, error } = await table(sent).update({ title: 'x' });
    expect(data).toBeNull();
    expect(error?.code).toBe('invalid_request');
    expect(error?.message).toMatch(/every row of "posts"/);
    expect(error?.message).toMatch(/allowFullTable/);
    expect(sent).toHaveLength(0);
  });

  it('refuses a delete with no filter, and single() does not change that', async () => {
    const sent: Sent[] = [];
    const { error } = await table(sent).delete().single();
    expect(error?.message).toMatch(/delete every row/);
    expect(sent).toHaveLength(0);
  });

  it('shows the refusal from toSQL() too, rather than the statement', () => {
    expect(() => table().delete().toSQL()).toThrow(/without a filter/);
  });

  it('runs a whole-table write when asked to on purpose', () => {
    expect(table().update({ title: 'x' }, { allowFullTable: true }).toSQL()).toBe(
      `UPDATE "posts" SET "title" = 'x' RETURNING *`,
    );
    expect(table().delete({ allowFullTable: true }).toSQL()).toBe('DELETE FROM "posts" RETURNING *');
  });

  it('leaves a filtered write exactly as it was', () => {
    expect(table().update({ title: 'x' }).eq('id', 1).toSQL()).toBe(
      `UPDATE "posts" SET "title" = 'x' WHERE "id" = 1 RETURNING *`,
    );
  });

  it('counts an orRaw condition as a filter', () => {
    expect(table().delete().orRaw('id = 1 OR id = 2').toSQL()).toContain('WHERE (id = 1 OR id = 2)');
  });
});

describe('single() and maybeSingle() (#166)', () => {
  it('reads two rows so that "more than one" can be detected', () => {
    expect(table().select().eq('id', 1).single().toSQL()).toBe(`SELECT * FROM "posts" WHERE "id" = 1 LIMIT 2`);
  });

  it('keeps an explicit limit, which is how to take the first of several', () => {
    expect(table().select().order('id').limit(1).single().toSQL()).toMatch(/LIMIT 1$/);
  });

  it('errors when no row matches', async () => {
    const res = await table([], () => ({ rows: [] })).select().eq('id', 1).single();
    expect(res.data).toBeNull();
    expect(res.error).toMatchObject({ code: 'PGRST116', status: 406 });
  });

  it('errors when more than one row matches', async () => {
    const res = await table([], () => ({ rows: [{ id: 1 }, { id: 2 }] })).select().single();
    expect(res.data).toBeNull();
    expect(res.error?.message).toMatch(/more than one/);
  });

  it('returns the one row as an object', async () => {
    const res = await table([], () => ({ rows: [{ id: 1 }] })).select().eq('id', 1).single();
    expect(res).toEqual({ data: { id: 1 }, error: null });
  });

  it('maybeSingle() answers null, not an error, for no row', async () => {
    const res = await table([], () => ({ rows: [] })).select().eq('id', 1).maybeSingle();
    expect(res).toEqual({ data: null, error: null });
  });

  it('guards a write inside the statement, so a wide filter changes nothing', () => {
    const { text, params } = table().update({ title: 'x' }).eq('author', 'a').single().toQuery();
    expect(text).toBe(
      'UPDATE "posts" SET "title" = $1 WHERE ("author" = $2) AND ' +
        `(SELECT CASE WHEN count(*) <= 1 THEN 1 ELSE ('single() refused: ' || count(*) || ' rows matched')::int END ` +
        'FROM "posts" WHERE "author" = $2) = 1 RETURNING *',
    );
    expect(params).toEqual(['x', 'a']);
  });

  it('turns the guard firing into a readable error', async () => {
    const res = await table([], () => ({
      throws: { message: 'SQL error: invalid input syntax for type integer: "single() refused: 3 rows matched"', status: 400, code: '22P02' },
    }))
      .delete()
      .eq('author', 'a')
      .single();
    expect(res.data).toBeNull();
    expect(res.error).toEqual({
      message: 'single() refused this delete: the filter matched 3 rows, and nothing was changed. Narrow the filter to one row',
      code: 'PGRST116',
      status: 406,
    });
  });

  it('refuses single() over an insert of several rows', async () => {
    const sent: Sent[] = [];
    const res = await table(sent).insert([{ a: 1 }, { a: 2 }]).single();
    expect(res.error?.code).toBe('PGRST116');
    expect(sent).toHaveLength(0);
  });
});

describe('upsert (#169, #133)', () => {
  it('goes to the REST endpoint with the resolution header and conflict target', async () => {
    const sent: Sent[] = [];
    const res = await table(sent, () => [{ id: 1, title: 'a' }]).upsert({ id: 1, title: 'a' }, { onConflict: 'id' });
    expect(sent[0].path).toBe('/rest/v1/posts?on_conflict=id');
    expect(sent[0].headers?.Prefer).toBe('return=representation,resolution=merge-duplicates');
    expect(sent[0].body).toEqual([{ id: 1, title: 'a' }]);
    expect(res).toEqual({ data: [{ id: 1, title: 'a' }], error: null });
  });

  it('leaves the conflict target to the server (the primary key) when none is given', async () => {
    const sent: Sent[] = [];
    await table(sent, () => []).upsert([{ id: 1, title: 'a' }, { id: 2 }]);
    expect(sent[0].path).toBe('/rest/v1/posts');
    // Every row carries every column, as the SQL form wrote them.
    expect(sent[0].body).toEqual([{ id: 1, title: 'a' }, { id: 2, title: null }]);
  });

  it('asks for ignore-duplicates', async () => {
    const sent: Sent[] = [];
    await table(sent, () => []).upsert({ id: 1 }, { ignoreDuplicates: true });
    expect(sent[0].headers?.Prefer).toBe('return=representation,resolution=ignore-duplicates');
  });

  it('writes DO NOTHING — not an empty SET — when the row is only its key', () => {
    expect(table().upsert({ id: 1 }, { onConflict: 'id' }).toSQL()).toBe(
      'INSERT INTO "posts" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING RETURNING *',
    );
  });

  it('names the primary key, not the first column, when no target is given', () => {
    expect(table().upsert({ title: 'a', id: 1 }).toSQL()).toContain('ON CONFLICT ON CONSTRAINT "posts_pkey" DO UPDATE SET');
  });

  it('keeps the SQL path for a column name the REST endpoint cannot address', async () => {
    const sent: Sent[] = [];
    await table(sent).upsert({ id: 1, 'first name': 'a' }, { onConflict: 'id' });
    expect(sent[0].path).toBe('/sql/execute');
  });
});

describe('select lists (#170)', () => {
  it('counts', () => {
    expect(table().select('count(*)').toSQL()).toBe('SELECT count(*) FROM "posts"');
  });

  it('aliases with "as" and with "label:column"', () => {
    expect(table().select('title as t, n:id').toSQL()).toBe('SELECT "title" AS "t", "id" AS "n" FROM "posts"');
  });

  it('groups by the plain columns next to an aggregate', () => {
    expect(table().select('status, count(*) as n').toSQL()).toBe(
      'SELECT "status", count(*) AS "n" FROM "posts" GROUP BY "status"',
    );
  });

  it('casts', () => {
    expect(table().select('id::text').toSQL()).toBe('SELECT "id"::text FROM "posts"');
  });

  it('still quotes anything else whole, as before', () => {
    expect(table().select('First Name').toSQL()).toBe('SELECT "First Name" FROM "posts"');
    expect(table().select('x); drop table posts; --').toSQL()).toBe('SELECT "x); drop table posts; --" FROM "posts"');
  });

  it('returns chosen columns from a write instead of turning it into a read', () => {
    expect(table().insert({ title: 'a' }).select('id').toSQL()).toBe(
      `INSERT INTO "posts" ("title") VALUES ('a') RETURNING "id"`,
    );
  });
});

describe('over the wire (#170)', () => {
  it('sends a BigInt as its decimal string instead of throwing', async () => {
    const sent: Sent[] = [];
    const res = await table(sent).select().eq('id', 9007199254740993n);
    expect(res.error).toBeNull();
    expect((sent[0].body as { params: unknown[] }).params).toEqual(['9007199254740993']);
  });

  it('asks the API for more than its default page when the limit is larger', async () => {
    const sent: Sent[] = [];
    await table(sent).select().limit(500);
    expect((sent[0].body as { limit?: number }).limit).toBe(500);
  });

  it('forwards the SQLSTATE code of a database error', async () => {
    const res = await table([], () => ({ throws: { message: 'SQL error: duplicate key', status: 400, code: '23505' } }))
      .insert({ id: 1 });
    expect(res.error).toEqual({ message: 'SQL error: duplicate key', status: 400, code: '23505' });
  });

  it('marks a request that never got through', async () => {
    const res = await table([], () => ({ throws: new TypeError('fetch failed') })).select();
    expect(res.error).toEqual({ message: 'Network error: fetch failed', code: 'network_error' });
  });
});
