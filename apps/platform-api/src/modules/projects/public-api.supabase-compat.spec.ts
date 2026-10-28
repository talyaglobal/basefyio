// ProjectsService reaches an ESM-only Keycloak client through its own imports,
// which Jest cannot load. Only its identity matters for construction here.
jest.mock('./projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../realtime-data/realtime-data.service', () => ({
  RealtimeDataService: class {
    publishChange = jest.fn();
  },
}));

import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PostgrestClient } from '@supabase/postgrest-js';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { RealtimeDataService } from '../realtime-data/realtime-data.service';
import { ProjectsService } from './projects.service';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';
import { isSupabaseCompat } from './postgrest/compat';
import { fixtureSchema } from './postgrest/test-fixtures';

/**
 * The real supabase-js / postgrest-js clients against the real controller.
 *
 * What a client written for Supabase needs of `/api/rest/v1` is not just the
 * query grammar — it is bare arrays, `Content-Range`, 201/204, 406 for
 * `.single()`, `{code, message, details, hint}` errors, and `rpc` returning
 * the function's value rather than rows. These tests drive the published
 * clients over HTTP at a listening Nest app, with the database replaced by a
 * scripted connection, so what is asserted is the wire, not a mock of it.
 * The last block pins that a caller without the client's headers still gets
 * `{data, count}`, `{count}`, `T[]` and the platform error body.
 */

interface Statement {
  sql: string;
  params: unknown[];
}

/** A scripted database connection: what the next statements return. */
interface ScriptedDb {
  rows: Record<string, unknown>[];
  total: number;
  fns: Record<string, unknown>[];
  fail: unknown;
  calls: Statement[];
  reset(): void;
  /** Statements other than the catalogue lookup, in order. */
  statements(): Statement[];
}

const db: ScriptedDb = {
  rows: [],
  total: 0,
  fns: [],
  fail: null,
  calls: [],
  reset() {
    db.rows = [];
    db.total = 0;
    db.fns = [];
    db.fail = null;
    db.calls = [];
  },
  statements() {
    return db.calls.filter((c) => !/FROM pg_proc/.test(c.sql));
  },
};

const client = {
  query: jest.fn(async (sql: string, params: unknown[] = []) => {
    db.calls.push({ sql, params });
    if (db.fail) {
      const e = db.fail;
      db.fail = null;
      throw e;
    }
    if (/COUNT\(\*\)::int AS total/.test(sql)) return { rows: [{ total: db.total }], rowCount: 1 };
    if (/FROM pg_proc/.test(sql)) return { rows: db.fns, rowCount: db.fns.length };
    return { rows: db.rows, rowCount: db.rows.length };
  }),
};

const PROJECT = '00000000-0000-4000-8000-000000000001';
const KEY = 'anon-key';

let app: INestApplication;
let base: string;
let realtime: { publishChange: jest.Mock };

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [PublicApiController],
    providers: [
      PublicApiService,
      { provide: PrismaService, useValue: {} },
      { provide: ConfigService, useValue: { get: () => undefined } },
      { provide: ProjectsService, useValue: {} },
      { provide: RealtimeDataService, useValue: { publishChange: jest.fn() } },
    ],
  })
    .overrideGuard(ApiKeyGuard)
    .useValue({
      canActivate: (ctx: any) => {
        const req = ctx.switchToHttp().getRequest();
        if (!req.headers.apikey && !req.query?.apikey) {
          // What the real guard does first; the compat filter must render it.
          const { UnauthorizedException } = require('@nestjs/common');
          throw new UnauthorizedException('Missing apikey');
        }
        req.apiKeyPayload = { projectId: PROJECT, role: 'anon', dbRole: 'anon', jwtClaims: undefined };
        req.supabaseCompat = isSupabaseCompat(req.headers);
        return true;
      },
    })
    .compile();

  app = moduleRef.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  await app.listen(0);
  const address = app.getHttpServer().address();
  base = `http://127.0.0.1:${address.port}/api`;

  const service = moduleRef.get(PublicApiService);
  clearInterval((service as any).poolCleanupTimer);
  // The transaction wrapper is replaced, not withRls itself, so error
  // classification still runs on what the scripted connection throws.
  jest.spyOn(service as any, 'runRlsTransaction').mockImplementation((_p: any, _ctx: any, fn: any) => fn(client));
  jest.spyOn((service as any).schemaCache, 'get').mockImplementation(async () => fixtureSchema().schema);
  realtime = moduleRef.get(RealtimeDataService) as any;
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  db.reset();
  realtime.publishChange.mockClear();
});

const postgrest = (opts: { schema?: string } = {}) =>
  new PostgrestClient(`${base}/rest/v1`, { headers: { apikey: KEY }, schema: opts.schema ?? 'public' });

describe('postgrest-js — reads', () => {
  it('gets a bare array and a count from Content-Range', async () => {
    db.rows = [{ id: 1, title: 'a' }, { id: 2, title: 'b' }];
    db.total = 2;
    const res = await postgrest().from('posts').select('id,title', { count: 'exact' });
    expect(res.error).toBeNull();
    expect(res.status).toBe(200);
    expect(res.data).toEqual(db.rows);
    expect(res.count).toBe(2);
  });

  it('runs no count query unless one was asked for', async () => {
    db.rows = [{ id: 1 }];
    const res = await postgrest().from('posts').select('id');
    expect(res.count).toBeNull();
    expect(db.statements().some((s) => /COUNT\(\*\)/.test(s.sql))).toBe(false);
  });

  it('answers HEAD with the count only', async () => {
    db.total = 42;
    const res = await postgrest().from('posts').select('*', { head: true, count: 'exact' });
    expect(res.error).toBeNull();
    expect(res.data).toBeNull();
    expect(res.count).toBe(42);
    expect(db.statements()).toHaveLength(1);
    expect(db.statements()[0].sql).toMatch(/COUNT\(\*\)/);
  });

  it('answers 206 for a page that is a strict subset of the total', async () => {
    db.rows = [{ id: 1 }, { id: 2 }];
    db.total = 5;
    const res = await postgrest().from('posts').select('id', { count: 'exact' }).range(0, 1);
    expect(res.status).toBe(206);
    expect(res.count).toBe(5);
    const { sql, params } = db.statements().find((s) => !/COUNT/.test(s.sql))!;
    expect(sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(params).toEqual(expect.arrayContaining([2, 0]));
  });

  it('orders with Postgres’s NULLS placement, as .order() expects', async () => {
    await postgrest().from('posts').select('id').order('created_at', { ascending: false }).order('title');
    expect(db.statements()[0].sql).toMatch(/"created_at" DESC NULLS FIRST, _bf0\."title" ASC NULLS LAST/);
  });

  it('returns one object for .single() and 406 PGRST116 when there is not exactly one row', async () => {
    db.rows = [{ id: 7 }];
    const one = await postgrest().from('posts').select('id').eq('id', 7).single();
    expect(one.error).toBeNull();
    expect(one.data).toEqual({ id: 7 });

    db.rows = [];
    const none = await postgrest().from('posts').select('id').eq('id', 8).single();
    expect(none.status).toBe(406);
    expect(none.error).toEqual({
      code: 'PGRST116',
      message: 'JSON object requested, multiple (or no) rows returned',
      details: 'The result contains 0 rows',
      hint: null,
    });
  });

  it('gives .maybeSingle() null for no rows', async () => {
    const res = await postgrest().from('posts').select('id').eq('id', 8).maybeSingle();
    expect(res.error).toBeNull();
    expect(res.data).toBeNull();
  });

  it('refuses a schema other than public with 406 PGRST106', async () => {
    const res = await postgrest({ schema: 'private' }).from('posts').select('id');
    expect(res.status).toBe(406);
    expect(res.error?.code).toBe('PGRST106');
  });

  it('refuses csv with 406 PGRST107', async () => {
    const res = await postgrest().from('posts').select('id').csv();
    expect(res.status).toBe(406);
    expect(res.error?.code).toBe('PGRST107');
  });

  it('reports a malformed filter as 400 PGRST100 rather than a 500', async () => {
    const res = await postgrest().from('posts').select('id').filter('id', 'nope' as any, 1);
    expect(res.status).toBe(400);
    expect(res.error).toMatchObject({ code: 'PGRST100', message: expect.stringMatching(/Unknown operator "nope"/) });
  });

  it('reports an unknown relation as 404 PGRST205 and an unknown column as 400 PGRST204', async () => {
    const rel = await postgrest().from('nope').select('id');
    expect(rel.status).toBe(404);
    expect(rel.error?.code).toBe('PGRST205');
    const col = await postgrest().from('posts').select('nope');
    expect(col.status).toBe(400);
    expect(col.error?.code).toBe('PGRST204');
  });
});

describe('postgrest-js — writes', () => {
  it('inserts with 201 and no body by default', async () => {
    db.rows = [{ id: 1, title: 'a' }];
    const res = await postgrest().from('posts').insert({ title: 'a' });
    expect(res.error).toBeNull();
    expect(res.status).toBe(201);
    expect(res.data).toBeNull();
    const { sql, params } = db.statements()[0];
    expect(sql).toBe('INSERT INTO "posts" ("title") VALUES ($1) RETURNING *');
    expect(params).toEqual(['a']);
    expect(realtime.publishChange).toHaveBeenCalledWith(PROJECT, expect.objectContaining({ type: 'INSERT', new: { id: 1, title: 'a' } }));
  });

  it('returns the rows with .select() and counts them', async () => {
    db.rows = [{ id: 1, title: 'a' }];
    const res = await postgrest().from('posts').insert({ title: 'a' }, { count: 'exact' }).select();
    expect(res.status).toBe(201);
    expect(res.data).toEqual([{ id: 1, title: 'a' }]);
    expect(res.count).toBe(1);
  });

  it('takes the union of columns across rows, filling gaps with NULL', async () => {
    await postgrest().from('posts').insert([{ title: 'a' }, { body: 'b' }]);
    const { sql, params } = db.statements()[0];
    expect(sql).toBe('INSERT INTO "posts" ("title", "body") VALUES ($1, $2), ($3, $4) RETURNING *');
    expect(params).toEqual(['a', null, null, 'b']);
  });

  it('fills gaps with DEFAULT under defaultToNull: false', async () => {
    await postgrest().from('posts').insert([{ title: 'a' }, { body: 'b' }], { defaultToNull: false });
    const { sql, params } = db.statements()[0];
    expect(sql).toBe('INSERT INTO "posts" ("title", "body") VALUES ($1, DEFAULT), (DEFAULT, $2) RETURNING *');
    expect(params).toEqual(['a', 'b']);
  });

  it('upserts on the primary key with DO UPDATE, or DO NOTHING for ignoreDuplicates', async () => {
    await postgrest().from('posts').upsert({ id: 1, title: 'a' });
    expect(db.statements()[0].sql).toBe(
      'INSERT INTO "posts" ("id", "title") VALUES ($1, $2) ON CONFLICT ("id") DO UPDATE SET "id" = EXCLUDED."id", "title" = EXCLUDED."title" RETURNING *',
    );
    db.reset();
    await postgrest().from('posts').upsert({ id: 1, title: 'a' }, { ignoreDuplicates: true, onConflict: 'title' });
    expect(db.statements()[0].sql).toBe(
      'INSERT INTO "posts" ("id", "title") VALUES ($1, $2) ON CONFLICT ("title") DO NOTHING RETURNING *',
    );
  });

  it('refuses an upsert into a table with no primary key and no on_conflict', async () => {
    const res = await postgrest().from('events').upsert({ name: 'x' });
    expect(res.status).toBe(400);
    expect(res.error?.message).toMatch(/no primary key/);
  });

  it('inserts nothing for an empty array and answers 201 []', async () => {
    const res = await postgrest().from('posts').insert([]).select();
    expect(res.status).toBe(201);
    expect(res.data).toEqual([]);
    expect(db.statements()).toHaveLength(0);
  });

  it('projects the representation through select=, embeds included, keeping full rows for realtime', async () => {
    db.rows = [{ __basefyio_raw: { id: 1, title: 'a', author_id: 9 }, id: 1, author: { name: 'n' } }];
    const res = await postgrest().from('posts').insert({ title: 'a', author_id: 9 }).select('id,author:users(name)').single();
    expect(res.error).toBeNull();
    expect(res.data).toEqual({ id: 1, author: { name: 'n' } });
    const { sql } = db.statements()[0];
    expect(sql).toMatch(/^WITH _w AS \(INSERT INTO "posts" \("title", "author_id"\) VALUES \(\$1, \$2\) RETURNING \*\) SELECT row_to_json\(_bf0\) AS "__basefyio_raw", _bf0\."id" AS "id", \(SELECT row_to_json/);
    expect(sql).toMatch(/FROM _w _bf0$/);
    expect(realtime.publishChange).toHaveBeenCalledWith(PROJECT, expect.objectContaining({ new: { id: 1, title: 'a', author_id: 9 } }));
  });

  it('rolls back a write whose .single() did not get exactly one row', async () => {
    db.rows = [];
    const res = await postgrest().from('posts').insert({ title: 'a' }).select().single();
    expect(res.status).toBe(406);
    expect(res.error?.code).toBe('PGRST116');
    expect(realtime.publishChange).not.toHaveBeenCalled();
  });

  it('updates with 204 by default and 200 + rows with .select()', async () => {
    db.rows = [{ id: 1, title: 'b' }];
    const quiet = await postgrest().from('posts').update({ title: 'b' }).eq('id', 1);
    expect(quiet.status).toBe(204);
    expect(quiet.data).toBeNull();
    const { sql, params } = db.statements()[0];
    expect(sql).toMatch(/^UPDATE "posts" AS _bf0 SET "title" = \$2 WHERE _bf0\."id" = \$1 RETURNING \*$/);
    expect(params).toEqual(['1', 'b']);

    const loud = await postgrest().from('posts').update({ title: 'b' }).eq('id', 1).select();
    expect(loud.status).toBe(200);
    expect(loud.data).toEqual([{ id: 1, title: 'b' }]);
  });

  it('deletes with 204 by default and 200 + rows with .select()', async () => {
    db.rows = [{ id: 1 }];
    const quiet = await postgrest().from('posts').delete().eq('id', 1);
    expect(quiet.status).toBe(204);
    expect(db.statements()[0].sql).toMatch(/^DELETE FROM "posts" AS _bf0 WHERE _bf0\."id" = \$1 RETURNING \*$/);
    const loud = await postgrest().from('posts').delete({ count: 'exact' }).eq('id', 1).select();
    expect(loud.status).toBe(200);
    expect(loud.data).toEqual([{ id: 1 }]);
    expect(loud.count).toBe(1);
  });

  it('still refuses an unfiltered update or delete, in PostgREST’s error shape', async () => {
    const res = await postgrest().from('posts').delete();
    expect(res.status).toBe(400);
    expect(res.error).toMatchObject({ code: '21000', message: expect.stringMatching(/requires at least one filter/) });
  });

  it('hands a Postgres error to the client with its SQLSTATE, details and status', async () => {
    db.fail = {
      code: '23505',
      message: 'duplicate key value violates unique constraint "posts_pkey"',
      detail: 'Key (id)=(1) already exists.',
    };
    const res = await postgrest().from('posts').insert({ id: 1, title: 'a' });
    expect(res.status).toBe(409);
    expect(res.error).toEqual({
      code: '23505',
      message: 'duplicate key value violates unique constraint "posts_pkey"',
      details: 'Key (id)=(1) already exists.',
      hint: null,
    });
  });

  it('reports a policy denial to the anonymous role as 401 42501', async () => {
    db.fail = { code: '42501', message: 'permission denied for table posts' };
    const res = await postgrest().from('posts').insert({ title: 'a' });
    expect(res.status).toBe(401);
    expect(res.error?.code).toBe('42501');
  });
});

describe('postgrest-js — rpc', () => {
  const scalar = { signature: 'add(a integer, b integer)', definer: false, argnames: ['a', 'b'], argmodes: [], typtype: 'b', typname: 'int4', typrelid: 0 };

  it('binds the arguments as parameters and returns a scalar bare', async () => {
    db.fns = [scalar];
    db.rows = [{ v: 3 }];
    const res = await postgrest().rpc('add', { a: 1, b: 2 });
    expect(res.error).toBeNull();
    expect(res.status).toBe(200);
    expect(res.data).toBe(3);
    const { sql, params } = db.statements()[0];
    expect(sql).toBe('SELECT "add"("a" := $1, "b" := $2) AS v');
    expect(params).toEqual([1, 2]);
  });

  it('returns a composite as one object and a SETOF as an array, with a count when asked', async () => {
    db.fns = [{ signature: 'me()', definer: false, argnames: [], argmodes: [], typtype: 'c', typname: 'users', typrelid: 5 }];
    db.rows = [{ id: 1, name: 'n' }];
    const one = await postgrest().rpc('me');
    expect(one.data).toEqual({ id: 1, name: 'n' });

    db.fns = [{ signature: 'list()', definer: false, argnames: [], argmodes: [], proretset: true, typtype: 'c', typname: 'posts', typrelid: 6 }];
    db.rows = [{ id: 1 }, { id: 2 }];
    const many = await postgrest().rpc('list', {}, { count: 'exact' });
    expect(many.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(many.count).toBe(2);
  });

  it('calls over GET with the arguments in the query string', async () => {
    db.fns = [scalar];
    db.rows = [{ v: 3 }];
    const res = await postgrest().rpc('add', { a: 1, b: 2 }, { get: true });
    expect(res.data).toBe(3);
    expect(db.statements()[0].params).toEqual(['1', '2']);
  });

  it('answers void with 204 and data null', async () => {
    db.fns = [{ signature: 'ping()', definer: false, argnames: [], argmodes: [], typtype: 'p', typname: 'void' }];
    const res = await postgrest().rpc('ping');
    expect(res.error).toBeNull();
    expect(res.status).toBe(204);
    expect(res.data).toBeNull();
  });

  it('reports a missing function as 404 PGRST202', async () => {
    const res = await postgrest().rpc('nope', { x: 1 });
    expect(res.status).toBe(404);
    expect(res.error?.code).toBe('PGRST202');
    expect(res.error?.message).toBe('Could not find the function public.nope(x) in the schema cache');
  });
});

describe('supabase-js — the whole client, unchanged', () => {
  it('reads, writes and calls through createClient()', async () => {
    const supabase = createClient(base, KEY, { auth: { persistSession: false, autoRefreshToken: false } });

    db.rows = [{ id: 1, title: 'a' }];
    db.total = 1;
    const read = await supabase.from('posts').select('*', { count: 'exact' }).eq('id', 1);
    expect(read.error).toBeNull();
    expect(read.data).toEqual([{ id: 1, title: 'a' }]);
    expect(read.count).toBe(1);
    // The client's own headers are what switched the dialect.
    expect(db.statements()[0].sql).toMatch(/"id" = \$1/);

    db.reset();
    db.rows = [{ id: 2, title: 'b' }];
    const written = await supabase.from('posts').insert({ title: 'b' }).select().single();
    expect(written.status).toBe(201);
    expect(written.data).toEqual({ id: 2, title: 'b' });

    db.reset();
    db.fns = [{ signature: 'add(a integer, b integer)', definer: false, argnames: ['a', 'b'], argmodes: [], typtype: 'b', typname: 'int4', typrelid: 0 }];
    db.rows = [{ v: 3 }];
    const called = await supabase.rpc('add', { a: 1, b: 2 });
    expect(called.data).toBe(3);
    supabase.realtime.disconnect();
  });

  it('gets the guard’s refusal in PostgREST’s shape', async () => {
    // No apikey at all; the profile header alone marks the caller as a PostgREST client.
    const res = await new PostgrestClient(`${base}/rest/v1`, { schema: 'public' }).from('posts').select('*');
    expect(res.status).toBe(401);
    expect(res.error).toEqual({ code: 'PGRST301', message: 'Missing apikey', details: null, hint: null });
  });
});

/**
 * basefyio-js and basefyio-python send none of the headers above. For them
 * nothing changes: the envelope, the write summary, the rpc rows, the error
 * body — including the live `$` fix, which they get for free.
 */
describe('a caller without the client’s headers keeps the platform contract', () => {
  const raw = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/rest/v1${path}`, { ...init, headers: { apikey: KEY, 'content-type': 'application/json', ...(init.headers ?? {}) } });

  it('reads {data, count} with the count always computed', async () => {
    db.rows = [{ id: 1 }];
    db.total = 1;
    const res = await raw('/posts?select=id');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect(await res.json()).toEqual({ data: [{ id: 1 }], count: 1 });
    expect(db.statements().some((s) => /COUNT\(\*\)/.test(s.sql))).toBe(true);
  });

  it('keeps the legacy NULLS default and the keys-of-first-row insert', async () => {
    await raw('/posts?order=created_at.asc');
    expect(db.statements()[0].sql).toMatch(/ASC NULLS FIRST/);
    db.reset();
    db.rows = [{ id: 1 }, { id: 2 }];
    const res = await raw('/posts', { method: 'POST', body: JSON.stringify([{ title: 'a' }, { body: 'b' }]) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ count: 2 });
    expect(db.statements()[0].sql).toBe('INSERT INTO "posts" ("title") VALUES ($1), ($2) RETURNING *');
  });

  it('writes answer {count}, or the rows under Prefer: return=representation', async () => {
    db.rows = [{ id: 1, title: 'b' }];
    const quiet = await raw('/posts?id=eq.1', { method: 'PATCH', body: JSON.stringify({ title: 'b' }) });
    expect(quiet.status).toBe(200);
    expect(await quiet.json()).toEqual({ count: 1 });
    const loud = await raw('/posts?id=eq.1', { method: 'DELETE', headers: { prefer: 'return=representation' } });
    expect(loud.status).toBe(200);
    expect(await loud.json()).toEqual([{ id: 1, title: 'b' }]);
  });

  it('rpc returns the rows as an array, with the arguments now actually bound', async () => {
    db.fns = [{ signature: 'add(a integer, b integer)', definer: false, argnames: ['a', 'b'], argmodes: [] }];
    db.rows = [{ add: 3 }];
    const res = await raw('/rpc/add', { method: 'POST', body: JSON.stringify({ a: 1, b: 2 }) });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual([{ add: 3 }]);
    expect(db.statements()[0]).toEqual({ sql: 'SELECT * FROM "add"("a" := $1, "b" := $2)', params: [1, 2] });
  });

  it('turns a malformed filter into the platform 400, not a 500', async () => {
    const res = await raw('/posts?id=nope.1');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ statusCode: 400, code: 'PGRST100', message: expect.stringMatching(/Unknown operator/) });
  });

  it('gets the platform error body, with the old messages and statuses', async () => {
    const missing = await raw('/rpc/nope', { method: 'POST', body: '{}' });
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ statusCode: 400, message: 'Function "nope" not found' });

    db.fail = { code: '23505', message: 'dup', detail: 'Key (id)=(1) already exists.' };
    const dup = await raw('/posts', { method: 'POST', body: JSON.stringify({ id: 1 }) });
    expect(dup.status).toBe(409);
    const body = await dup.json();
    expect(body).toMatchObject({ statusCode: 409, message: 'Key (id)=(1) already exists.' });
    expect(Object.keys(body).sort()).toEqual(['message', 'statusCode', 'timestamp']);

    const unauth = await fetch(`${base}/rest/v1/posts`);
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toMatchObject({ statusCode: 401, message: 'Missing apikey' });
  });
});
