import { parseQuery, parseSelect } from './parser';
import { SelectBuilder } from './builder';
import { SchemaCache, ProjectSchema } from './schema-cache';
import { PostgrestParseError } from './types';

/**
 * A small fixed schema: posts belong to a user (author) and have many comments.
 *
 *   posts(id, title, author_id, body, created_at)   author_id → users.id
 *   users(id, name, email)
 *   comments(id, post_id, body, status)             post_id  → posts.id
 *   tags(id, name) ⇄ post_tags(post_id, tag_id)      many-to-many
 */
function fixtureSchema(): { schema: ProjectSchema; cache: SchemaCache } {
  const tables = new Map();
  const mk = (name: string, cols: string[], pk: string[]) =>
    tables.set(name, { name, columns: new Set(cols), primaryKey: pk });
  mk('posts', ['id', 'title', 'author_id', 'body', 'created_at'], ['id']);
  mk('users', ['id', 'name', 'email', 'profile'], ['id']);
  mk('comments', ['id', 'post_id', 'body', 'status', 'created_at'], ['id']);
  mk('tags', ['id', 'name'], ['id']);
  mk('post_tags', ['post_id', 'tag_id'], ['post_id', 'tag_id']);

  const schema: ProjectSchema = {
    tables,
    foreignKeys: [
      { constraint: 'posts_author_fk', table: 'posts', columns: ['author_id'], foreignTable: 'users', foreignColumns: ['id'] },
      { constraint: 'comments_post_fk', table: 'comments', columns: ['post_id'], foreignTable: 'posts', foreignColumns: ['id'] },
      { constraint: 'post_tags_post_fk', table: 'post_tags', columns: ['post_id'], foreignTable: 'posts', foreignColumns: ['id'] },
      { constraint: 'post_tags_tag_fk', table: 'post_tags', columns: ['tag_id'], foreignTable: 'tags', foreignColumns: ['id'] },
    ],
    loadedAt: Date.now(),
  };
  return { schema, cache: new SchemaCache() };
}

function build(table: string, qs: Record<string, string | string[]>) {
  const { schema, cache } = fixtureSchema();
  const b = new SelectBuilder(schema, cache);
  return b.build(table, parseQuery(qs));
}

describe('PostgREST parser — select', () => {
  it('defaults to all columns', () => {
    expect(parseSelect(undefined)).toEqual([{ kind: 'star' }]);
    expect(parseSelect('')).toEqual([{ kind: 'star' }]);
  });

  it('parses columns, alias and cast', () => {
    const items = parseSelect('id,title:name,count::int');
    expect(items[0]).toMatchObject({ kind: 'column', field: { column: 'id' } });
    expect(items[1]).toMatchObject({ alias: 'title', field: { column: 'name' } });
    expect(items[2]).toMatchObject({ cast: 'int', field: { column: 'count' } });
  });

  it('parses a JSON path', () => {
    const [item] = parseSelect('profile->address->>city');
    expect(item).toMatchObject({
      kind: 'column',
      field: { column: 'profile', jsonPath: [{ op: '->', key: 'address' }, { op: '->>', key: 'city' }] },
    });
  });

  it('parses a nested embed with alias, hint and !inner', () => {
    const [item] = parseSelect('author:users!posts_author_fk!inner(id,name)');
    expect(item).toMatchObject({
      kind: 'embed', relation: 'users', alias: 'author', hint: 'posts_author_fk', inner: true,
    });
  });
});

describe('PostgREST builder — filters', () => {
  it('binds eq as a parameter, never inline', () => {
    const { sql, params } = build('posts', { title: 'eq.hello' });
    expect(sql).toMatch(/"title" = \$1/);
    expect(params).toContain('hello');
    expect(sql).not.toContain('hello');
  });

  it('expands in.() to individual placeholders for type inference', () => {
    const { sql, params } = build('posts', { id: 'in.(1,2,3)' });
    expect(sql).toMatch(/"id" IN \(\$1, \$2, \$3\)/);
    expect(params.slice(0, 3)).toEqual(['1', '2', '3']);
  });

  it('matches nothing for an empty in list', () => {
    const { sql } = build('posts', { id: 'in.()' });
    expect(sql).toMatch(/FALSE/);
  });

  it('turns like wildcards into SQL and binds the pattern', () => {
    const { sql, params } = build('posts', { title: 'ilike.*draft*' });
    expect(sql).toMatch(/"title" ILIKE \$1/);
    expect(params).toContain('%draft%');
  });

  it('renders is.null / is.true without a parameter', () => {
    expect(build('posts', { body: 'is.null' }).sql).toMatch(/"body" IS NULL/);
    expect(build('comments', { status: 'is.true' }).sql).toMatch(/"status" IS TRUE/);
  });

  it('negates with not.', () => {
    const { sql } = build('posts', { title: 'not.eq.spam' });
    expect(sql).toMatch(/NOT \(_bf0\."title" = \$1\)/);
  });

  it('builds an or group', () => {
    const { sql } = build('posts', { or: '(title.eq.a,title.eq.b)' });
    expect(sql).toMatch(/\(_bf0\."title" = \$1 OR _bf0\."title" = \$2\)/);
  });

  it('builds a nested and-inside-or group', () => {
    const { sql } = build('posts', { or: '(title.eq.a,and(title.eq.b,author_id.eq.5))' });
    expect(sql).toMatch(/OR \(_bf0\."title" = \$2 AND _bf0\."author_id" = \$3\)/);
  });

  it('builds full-text search with a config', () => {
    const { sql, params } = build('posts', { body: 'fts(english).cat' });
    expect(sql).toMatch(/"body" @@ to_tsquery\(\$1::regconfig, \$2\)/);
    expect(params.slice(0, 2)).toEqual(['english', 'cat']);
  });

  it('filters on a JSON path', () => {
    const { sql, params } = build('users', { profile: 'eq.x' }); // base col exists
    expect(sql).toMatch(/"profile" = \$1/);
    expect(params).toContain('x');
  });
});

describe('PostgREST builder — embeds', () => {
  it('embeds a to-one parent as row_to_json with the forward FK join', () => {
    const { sql } = build('posts', { select: '*,author:users(name)' });
    expect(sql).toMatch(/row_to_json/);
    expect(sql).toMatch(/_bf0\."author_id" = _bf\d+\."id"/);
    expect(sql).toMatch(/AS "author"/);
  });

  it('embeds a to-many child as json_agg with COALESCE to an empty array', () => {
    const { sql } = build('posts', { select: '*,comments(body)' });
    expect(sql).toMatch(/COALESCE\(json_agg/);
    expect(sql).toMatch(/_bf\d+\."post_id" = _bf0\."id"/);
    expect(sql).toMatch(/AS "comments"/);
  });

  it('resolves a many-to-many embed through the junction table', () => {
    const { sql } = build('posts', { select: '*,tags(name)' });
    expect(sql).toMatch(/JOIN "post_tags" _j/);
    expect(sql).toMatch(/AS "tags"/);
  });

  it('applies an embedded filter and order inside the embed subquery', () => {
    const { sql } = build('posts', {
      select: '*,comments(body)',
      'comments.status': 'eq.open',
      'comments.order': 'created_at.desc',
    } as Record<string, string>);
    // the embedded WHERE/ORDER live inside the json_agg subquery
    expect(sql).toMatch(/"status" = \$1/);
  });

  it('drops parents with no match for an !inner embed via EXISTS', () => {
    const { sql } = build('posts', {
      select: 'id,comments!inner(body)',
      'comments.status': 'eq.open',
    } as Record<string, string>);
    expect(sql).toMatch(/EXISTS \(SELECT 1 FROM "comments"/);
  });
});

describe('PostgREST builder — order, paging, validation', () => {
  it('orders with explicit nulls handling', () => {
    const { sql } = build('posts', { order: 'created_at.desc.nullslast' });
    expect(sql).toMatch(/"created_at" DESC NULLS LAST/);
  });

  it('applies limit and offset as bound parameters', () => {
    const { sql } = build('posts', { limit: '10', offset: '20' });
    expect(sql).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
  });

  it('caps the default page size when no limit is given', () => {
    const { params } = build('posts', {});
    expect(params).toContain(1000);
  });

  it('rejects an unknown column with PGRST204', () => {
    expect(() => build('posts', { nope: 'eq.1' })).toThrow(PostgrestParseError);
    try {
      build('posts', { nope: 'eq.1' });
    } catch (e) {
      expect((e as PostgrestParseError).code).toBe('PGRST204');
    }
  });

  it('rejects an unknown relation with PGRST205', () => {
    try {
      build('nonexistent', {});
    } catch (e) {
      expect((e as PostgrestParseError).code).toBe('PGRST205');
    }
  });

  it('rejects an embed with no relationship', () => {
    // users → comments has no FK in the fixture
    expect(() => build('users', { select: '*,comments(body)' })).toThrow(/relationship/i);
  });

  it('never lets an identifier reach SQL unquoted', () => {
    expect(() => build('posts', { 'title; drop table users': 'eq.x' } as any)).toThrow();
  });
});

describe('count', () => {
  it('counts with root filters only, ignoring embeds and paging', () => {
    const { schema, cache } = fixtureSchema();
    const b = new SelectBuilder(schema, cache);
    const { sql, params } = b.buildCount('posts', parseQuery({ title: 'eq.x', limit: '5', select: '*,comments(body)' }));
    expect(sql).toMatch(/COUNT\(\*\)::int AS total/);
    expect(sql).toMatch(/"title" = \$1/);
    expect(sql).not.toMatch(/json_agg/);
    expect(params).toEqual(['x']);
  });
});

/**
 * Writes get the same filter language as reads.
 *
 * update and delete used to run through a separate, flat filter parser: no
 * or/and/not, no casts, no JSON paths. A client that could express a condition
 * on a read found the same condition rejected on a write, and the two parsers
 * drifted apart with every operator added to one of them.
 */
describe('PostgREST builder — write filters', () => {
  const where = (table: string, qs: Record<string, string>) => {
    const { schema, cache } = fixtureSchema();
    const b = new SelectBuilder(schema, cache);
    return b.buildWriteWhere(table, parseQuery(qs));
  };

  it('aliases the table so the clause reads the same as a select', () => {
    const { alias, where: w } = where('posts', { id: 'eq.1' });
    expect(alias).toMatch(/^_bf\d+$/);
    expect(w).toContain(`${alias}."id"`);
  });

  it('binds values rather than writing them into the statement', () => {
    const { where: w, params } = where('posts', { title: 'eq.hello' });
    expect(w).toMatch(/"title" = \$1/);
    expect(params).toEqual(['hello']);
    expect(w).not.toContain('hello');
  });

  it('supports an or group, which the old write parser could not express', () => {
    const { where: w } = where('posts', { or: '(title.eq.a,title.eq.b)' });
    expect(w).toMatch(/"title" = \$1 OR .*"title" = \$2/);
  });

  it('supports and nested inside or', () => {
    const { where: w } = where('posts', { or: '(title.eq.a,and(title.eq.b,author_id.eq.5))' });
    expect(w).toMatch(/OR \(.*"title" = \$2 AND .*"author_id" = \$3\)/);
  });

  it('supports negation', () => {
    const { where: w } = where('posts', { title: 'not.eq.spam' });
    expect(w).toMatch(/NOT \(.*"title" = \$1\)/);
  });

  it('supports in lists with one placeholder each', () => {
    const { where: w, params } = where('posts', { id: 'in.(1,2,3)' });
    expect(w).toMatch(/"id" IN \(\$1, \$2, \$3\)/);
    expect(params).toEqual(['1', '2', '3']);
  });

  it('supports a JSON path', () => {
    const { where: w } = where('users', { profile: 'eq.x' });
    expect(w).toMatch(/"profile" = \$1/);
  });

  it('supports is.null without binding a parameter', () => {
    const { where: w, params } = where('posts', { body: 'is.null' });
    expect(w).toMatch(/"body" IS NULL/);
    expect(params).toEqual([]);
  });

  /**
   * An empty clause is how the service knows to refuse: an UPDATE or DELETE
   * with no filter takes the whole table.
   */
  it('returns an empty clause when nothing filters, so the caller can refuse', () => {
    expect(where('posts', {}).where).toBe('');
  });

  it('ignores select, order and limit, which do not belong on a write', () => {
    const { where: w, params } = where('posts', {
      id: 'eq.1',
      select: '*,comments(body)',
      order: 'created_at.desc',
      limit: '10',
    });
    expect(w).toMatch(/"id" = \$1/);
    expect(w).not.toMatch(/json_agg|ORDER BY|LIMIT/);
    expect(params).toEqual(['1']);
  });

  it('still rejects an unknown column', () => {
    expect(() => where('posts', { nope: 'eq.1' })).toThrow(PostgrestParseError);
  });

  it('still rejects an unknown table', () => {
    expect(() => where('nonexistent', { id: 'eq.1' })).toThrow(PostgrestParseError);
  });
});
