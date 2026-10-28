import {
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  applyListOptions,
  buildListQuery,
  fileObjectFromRow,
  normaliseListOptions,
} from './storage-list.sql';

describe('normaliseListOptions', () => {
  it('fills storage-js defaults', () => {
    expect(normaliseListOptions(undefined)).toEqual({
      prefix: '',
      limit: LIST_DEFAULT_LIMIT,
      offset: 0,
      sortBy: { column: 'name', order: 'asc' },
      search: '',
    });
  });

  it('normalises the prefix to a trailing slash and drops traversal', () => {
    expect(normaliseListOptions({ prefix: '/folder/sub/' }).prefix).toBe('folder/sub/');
    expect(normaliseListOptions({ prefix: 'folder' }).prefix).toBe('folder/');
    expect(normaliseListOptions({ prefix: '../x' }).prefix).toBe('');
  });

  it('whitelists the sort column, bounds the limit and ignores bad numbers', () => {
    const o = normaliseListOptions({ limit: 5000, offset: -2, sortBy: { column: 'metadata', order: 'DESC' }, search: 7 });
    expect(o).toEqual({ prefix: '', limit: LIST_MAX_LIMIT, offset: 0, sortBy: { column: 'name', order: 'desc' }, search: '' });
    expect(normaliseListOptions({ sortBy: { column: 'updated_at', order: 'asc' } }).sortBy).toEqual({ column: 'updated_at', order: 'asc' });
  });
});

describe('buildListQuery', () => {
  it('selects folders from the first segment and files with no further slash, with the parameters in order', () => {
    const q = buildListQuery('docs', normaliseListOptions({ prefix: 'a', limit: 10, offset: 3, search: 'x', sortBy: { column: 'created_at', order: 'desc' } }));
    expect(q.values).toEqual(['docs', 'a/', 2, 'x', 10, 3]);
    expect(q.text).toContain('FROM storage.objects');
    expect(q.text).toContain("left(name, $3::int) = $2::text");
    expect(q.text).toContain("name NOT LIKE '%/'");
    expect(q.text).toContain("split_part(rest, '/', 1) AS name");
    expect(q.text).toContain("position('/' in rest) = 0 AND rest <> ''");
    expect(q.text).toContain('ORDER BY created_at DESC NULLS LAST, name ASC');
    expect(q.text).toContain('LIMIT $5::int OFFSET $6::int');
  });

  it('never interpolates anything but the whitelisted column and order', () => {
    const q = buildListQuery("x'; DROP TABLE storage.objects; --", normaliseListOptions({ prefix: "'; --" }));
    expect(q.text).not.toContain('DROP');
    expect(q.values[0]).toBe("x'; DROP TABLE storage.objects; --");
    expect(q.values[1]).toBe("'; --/");
  });
});

describe('fileObjectFromRow / applyListOptions', () => {
  const rows = [
    fileObjectFromRow({ name: 'b', id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null }),
    fileObjectFromRow({ name: 'a.txt', id: '1', updated_at: new Date('2026-01-02T00:00:00Z') as any, created_at: '2026-01-01T00:00:00.000Z', last_accessed_at: null, metadata: { size: 1 } }),
    fileObjectFromRow({ name: 'c.txt', id: '2', updated_at: '2026-01-03T00:00:00.000Z', created_at: '2026-01-03T00:00:00.000Z', last_accessed_at: null, metadata: { size: 2 } }),
  ];

  it('serialises dates and keeps folders as null-id entries', () => {
    expect(rows[0]).toEqual({ name: 'b', id: null, updated_at: null, created_at: null, last_accessed_at: null, metadata: null });
    expect(rows[1].updated_at).toBe('2026-01-02T00:00:00.000Z');
  });

  it('sorts with nulls last, searches, and pages', () => {
    const byUpdated = applyListOptions(rows, normaliseListOptions({ sortBy: { column: 'updated_at', order: 'desc' } }));
    expect(byUpdated.map((r) => r.name)).toEqual(['c.txt', 'a.txt', 'b']);
    expect(applyListOptions(rows, normaliseListOptions({ search: 'TXT' })).map((r) => r.name)).toEqual(['a.txt', 'c.txt']);
    expect(applyListOptions(rows, normaliseListOptions({ limit: 1, offset: 1 })).map((r) => r.name)).toEqual(['b']);
  });
});
