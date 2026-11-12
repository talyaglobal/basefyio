import { NotFoundException } from '@nestjs/common';
import { DataQueryService } from './data-query.service';

/** bf.data.view(name) → GET /v1/projects/:id/views/:name runs the saved query `name`. */
function makeService(saved: Record<string, unknown> | null) {
  const collection = {
    query: jest.fn(async (q: any) => ({
      data: Array.from({ length: q.limit }, (_, i) => ({ _id: `d${q.offset + i}` })),
      total: 120,
      hasMore: true,
    })),
    count: jest.fn(async () => 120),
  };
  const prisma = {
    project: { findFirst: jest.fn(async () => ({ id: 'p1', teamId: 't1' })) },
    teamMember: { findUnique: jest.fn(async () => ({ id: 'm1' })) },
    savedDataQuery: { findUnique: jest.fn(async () => saved) },
    entityDefinition: { findUnique: jest.fn(async () => ({ id: 'e1', logicalName: 'orders' })) },
  };
  const activity = { append: jest.fn(async () => undefined) };
  const dataEngine = {
    isAvailable: () => true,
    getEngine: () => ({
      capabilities: () => ({ aggregationPipeline: true }),
      aggregate: jest.fn(async () => ({ data: [{ _id: 'IST', n: 3 }], total: 1, hasMore: false })),
    }),
    getEntityCollection: jest.fn(async () => collection),
  };
  const collections = { listCollections: jest.fn(async () => []) };
  const service = new DataQueryService(prisma as any, activity as any, dataEngine as any, collections as any);
  return { service, collection };
}

describe('DataQueryService.executeView', () => {
  it('answers 404 with guidance when no saved query has that name', async () => {
    const { service } = makeService(null);
    const err = await service.executeView('p1', 'missing', {}).catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err.message).toContain('saved Data Engine query');
  });

  it('runs a JS saved query as a page with limit/offset and a nextCursor', async () => {
    const { service, collection } = makeService({ name: 'feed', mode: 'js', sql: 'db.orders.find({ status: "open" })' });
    const page = await service.executeView('p1', 'feed', { limit: 20, offset: 40 });
    const q = (collection.query.mock.calls as any)[0][0];
    expect(q).toMatchObject({ entity: 'orders', limit: 20, offset: 40 });
    expect(q.filter).toMatchObject({ type: 'field', value: 'open' });
    expect(page).toMatchObject({ total: 120, hasMore: true, nextCursor: '60' });
    expect(page.data).toHaveLength(20);
  });

  it('runs an aggregation saved query in one page', async () => {
    const { service } = makeService({
      name: 'byCity',
      mode: 'aggregation',
      entity: 'orders',
      sql: JSON.stringify([{ $group: { _id: null, n: { $count: null } } }]),
    });
    const page = await service.executeView('p1', 'byCity', {});
    expect(page).toEqual({ data: [{ _id: 'IST', n: 3 }], total: 1, hasMore: false });
  });
});
