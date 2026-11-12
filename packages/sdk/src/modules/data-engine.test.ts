import { describe, expect, it } from 'vitest';
import { DataEngineClient } from './data-engine';

interface Call {
  path: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A stand-in for BasefyioFetchClient that records calls and answers each one. */
function fakeHttp(answer: (call: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  const http = {
    async json(path: string, init: any = {}) {
      const call = { path, method: init.method ?? 'GET', headers: init.headers, body: init.body };
      calls.push(call);
      return answer(call);
    },
  };
  return { http: http as never, calls };
}

const BASE = '/v1/projects/p1/data/orders';

describe('Data Engine client', () => {
  it('sends filter and sort in the documented format', async () => {
    const { http, calls } = fakeHttp(() => ({ data: [], total: 0, hasMore: false }));
    await new DataEngineClient(http, 'p1').collection('orders').find({ grp: 'g1' }).sort('_createdAt', 'desc').limit(5);
    const url = new URL(`https://x${calls[0].path}`);
    expect(url.pathname).toBe(BASE);
    expect(JSON.parse(url.searchParams.get('filter')!)).toEqual({ grp: 'g1' });
    expect(JSON.parse(url.searchParams.get('sort')!)).toEqual([{ path: '_createdAt', direction: 'desc' }]);
  });

  it('sends If-Match on update, replace and delete when ifMatch is given', async () => {
    const { http, calls } = fakeHttp();
    const orders = new DataEngineClient(http, 'p1').collection('orders');
    await orders.update('d1', { x: 1 }, { ifMatch: 4 });
    await orders.replace('d1', { x: 1 }, { ifMatch: 5 });
    await orders.delete('d1', { ifMatch: 6 });
    await orders.update('d1', { x: 2 });
    expect(calls.map((c) => c.headers?.['If-Match'])).toEqual(['"4"', '"5"', '"6"', undefined]);
  });

  it('restores, bulk-inserts and counts', async () => {
    const { http, calls } = fakeHttp((call) => (call.path.includes('/count') ? { count: 3 } : []));
    const orders = new DataEngineClient(http, 'p1').collection('orders');
    await orders.restore('d1');
    await orders.insertMany([{ n: 1 }, { n: 2 }]);
    const { data: n } = await orders.count({ status: 'paid' });

    expect(calls[0]).toMatchObject({ path: `${BASE}/d1/restore`, method: 'POST' });
    expect(calls[1]).toMatchObject({ path: BASE, method: 'POST' });
    expect(JSON.parse(calls[1].body as string)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(calls[2].path).toBe(`${BASE}/count?filter=${encodeURIComponent('{"status":"paid"}')}`);
    expect(n).toBe(3);
  });

  it('reads a view (a saved query) with paging', async () => {
    const { http, calls } = fakeHttp(() => ({ data: [], total: 0, hasMore: false }));
    await new DataEngineClient(http, 'p1').view('mobileFeedCard', { limit: 20, cursor: '40' });
    expect(calls[0].path).toBe('/v1/projects/p1/views/mobileFeedCard?limit=20&cursor=40');
  });
});
