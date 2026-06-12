import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createItemsModule } from './items.js';

const PAGE: import('../lib/types.js').ItemsPage = {
  data: [{ id: 'i-1', name: 'Alice' }],
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

describe('ItemsModule', () => {
  let client: ReturnType<typeof makeClient>;
  let items: ReturnType<typeof createItemsModule>;

  beforeEach(() => {
    client = makeClient();
    items = createItemsModule(client as any);
  });

  it('list: calls GET with correct path', async () => {
    client.get.mockResolvedValue(PAGE);
    const result = await items.list('p-1', 'customers');
    expect(client.get).toHaveBeenCalledWith('/v1/projects/p-1/items/customers');
    expect(result.data).toHaveLength(1);
  });

  it('list: appends query params for filter/sort/cursor', async () => {
    client.get.mockResolvedValue(PAGE);
    await items.list('p-1', 'customers', {
      limit: 10,
      sort: 'created_at',
      order: 'desc',
      filters: { status: 'active' },
      cursor: 'abc123',
    });
    const call = client.get.mock.calls[0][0] as string;
    expect(call).toContain('limit=10');
    expect(call).toContain('sort=created_at');
    expect(call).toContain('order=desc');
    expect(call).toContain('filter%5Bstatus%5D=active');
    expect(call).toContain('cursor=abc123');
  });

  it('get: calls GET with id', async () => {
    client.get.mockResolvedValue({ id: 'i-1', name: 'Alice' });
    const result = await items.get('p-1', 'customers', 'i-1');
    expect(client.get).toHaveBeenCalledWith('/v1/projects/p-1/items/customers/i-1');
    expect(result.id).toBe('i-1');
  });

  it('create: calls POST with data', async () => {
    client.post.mockResolvedValue({ id: 'i-2', name: 'Bob' });
    await items.create('p-1', 'customers', { name: 'Bob' });
    expect(client.post).toHaveBeenCalledWith('/v1/projects/p-1/items/customers', { name: 'Bob' });
  });

  it('update: calls PATCH with data', async () => {
    client.patch.mockResolvedValue({ id: 'i-1', name: 'Alice Updated' });
    await items.update('p-1', 'customers', 'i-1', { name: 'Alice Updated' });
    expect(client.patch).toHaveBeenCalledWith('/v1/projects/p-1/items/customers/i-1', { name: 'Alice Updated' });
  });

  it('delete: calls DELETE', async () => {
    client.delete.mockResolvedValue({ deleted: true, id: 'i-1' });
    const result = await items.delete('p-1', 'customers', 'i-1');
    expect(result.deleted).toBe(true);
  });
});
