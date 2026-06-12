import { SupabaseCompatService, parseSupabaseFilter, parseSupabaseOrder } from './supabase-compat.service';

describe('parseSupabaseFilter', () => {
  it('parses eq filter', () => {
    const filters = parseSupabaseFilter({ status: 'eq.active', select: '*' });
    expect(filters).toEqual({ status: 'active' });
  });

  it('ignores non-eq operators in V1', () => {
    const filters = parseSupabaseFilter({ age: 'gte.18' });
    expect(filters).toEqual({});
  });

  it('skips reserved keys', () => {
    const filters = parseSupabaseFilter({ select: '*', order: 'id.asc', status: 'eq.active' });
    expect(filters).toEqual({ status: 'active' });
  });

  it('handles multiple filters', () => {
    const filters = parseSupabaseFilter({ status: 'eq.active', type: 'eq.premium' });
    expect(filters).toEqual({ status: 'active', type: 'premium' });
  });
});

describe('parseSupabaseOrder', () => {
  it('parses asc order', () => {
    expect(parseSupabaseOrder('created_at.asc')).toEqual({ sort: 'created_at', order: 'asc' });
  });

  it('parses desc order with nullslast', () => {
    expect(parseSupabaseOrder('updated_at.desc.nullslast')).toEqual({ sort: 'updated_at', order: 'desc' });
  });

  it('returns empty object when no order param', () => {
    expect(parseSupabaseOrder(undefined)).toEqual({});
  });
});

describe('SupabaseCompatService', () => {
  const mockItemsService = {
    listItems: jest.fn().mockResolvedValue({ data: [{ id: '1', name: 'Alice' }], nextCursor: null, total: 1 }),
    createItem: jest.fn().mockResolvedValue({ id: '2', name: 'Bob' }),
    updateItem: jest.fn().mockResolvedValue({ id: '1', name: 'Updated' }),
    deleteItem: jest.fn().mockResolvedValue({ deleted: true, id: '1' }),
  };

  it('select returns an array', async () => {
    const svc = new SupabaseCompatService(mockItemsService as any);
    const result = await svc.select('p-1', 'customers', { status: 'eq.active' });
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
  });

  it('insert wraps single object in array', async () => {
    const svc = new SupabaseCompatService(mockItemsService as any);
    const result = await svc.insert('p-1', 'customers', { name: 'Bob' });
    expect(result).toHaveLength(1);
  });

  it('insert handles array input', async () => {
    const svc = new SupabaseCompatService(mockItemsService as any);
    const result = await svc.insert('p-1', 'customers', [{ name: 'Alice' }, { name: 'Bob' }]);
    expect(result).toHaveLength(2);
  });

  it('update requires id filter', async () => {
    const svc = new SupabaseCompatService(mockItemsService as any);
    await expect(svc.update('p-1', 'customers', {}, { name: 'X' })).rejects.toThrow('id=eq');
  });

  it('delete requires id filter', async () => {
    const svc = new SupabaseCompatService(mockItemsService as any);
    await expect(svc.delete('p-1', 'customers', {})).rejects.toThrow('id=eq');
  });
});
