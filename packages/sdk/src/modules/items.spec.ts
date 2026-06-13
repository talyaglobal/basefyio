import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createItemsModule } from './items.js';

const PAGE: import('../lib/types.js').StructureItemsPage = {
  data: [{ id: 'i-1', data: { title: 'Alice' }, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  nextCursor: null,
  total: 1,
};

function makeClient() {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

describe('ItemsModule (structure-based)', () => {
  let client: ReturnType<typeof makeClient>;
  let items: ReturnType<typeof createItemsModule>;

  beforeEach(() => {
    client = makeClient();
    items = createItemsModule(client as any);
  });

  it('list: calls GET with correct structure path', async () => {
    client.get.mockResolvedValue(PAGE);
    const result = await items.list('p-1', 'str-1');
    expect(client.get).toHaveBeenCalledWith('/v1/projects/p-1/structures/str-1/items');
    expect(result.data).toHaveLength(1);
  });

  it('list: appends limit and cursor params', async () => {
    client.get.mockResolvedValue(PAGE);
    await items.list('p-1', 'str-1', { limit: 10, cursor: 'tok-abc' });
    const call = client.get.mock.calls[0][0] as string;
    expect(call).toContain('limit=10');
    expect(call).toContain('cursor=tok-abc');
  });

  it('get: calls GET with itemId', async () => {
    const item = PAGE.data[0];
    client.get.mockResolvedValue(item);
    const result = await items.get('p-1', 'str-1', 'i-1');
    expect(client.get).toHaveBeenCalledWith('/v1/projects/p-1/structures/str-1/items/i-1');
    expect(result.id).toBe('i-1');
  });

  it('create: calls POST with data', async () => {
    const item = PAGE.data[0];
    client.post.mockResolvedValue(item);
    const result = await items.create('p-1', 'str-1', { title: 'Alice' });
    expect(client.post).toHaveBeenCalledWith(
      '/v1/projects/p-1/structures/str-1/items',
      { title: 'Alice' },
    );
    expect(result.id).toBe('i-1');
  });

  it('update: calls PATCH with itemId and data', async () => {
    const item = PAGE.data[0];
    client.patch.mockResolvedValue(item);
    await items.update('p-1', 'str-1', 'i-1', { title: 'Bob' });
    expect(client.patch).toHaveBeenCalledWith(
      '/v1/projects/p-1/structures/str-1/items/i-1',
      { title: 'Bob' },
    );
  });

  it('delete: calls DELETE with itemId', async () => {
    client.delete.mockResolvedValue({ deleted: true, id: 'i-1' });
    const result = await items.delete('p-1', 'str-1', 'i-1');
    expect(client.delete).toHaveBeenCalledWith('/v1/projects/p-1/structures/str-1/items/i-1');
    expect(result.deleted).toBe(true);
  });
});
