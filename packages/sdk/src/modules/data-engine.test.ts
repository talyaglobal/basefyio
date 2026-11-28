import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BasefyioFetchClient } from '../lib/fetch';
import { DataEngineClient } from './data-engine';

/** Vector methods of the Data Engine client against a mocked fetch. */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

let calls: Call[];
let answer: { status: number; body?: unknown };

beforeEach(() => {
  calls = [];
  answer = { status: 200, body: {} };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { method: string; body: string | null }) => {
      calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      if (answer.status === 204) return new Response(null, { status: 204 });
      return new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const BASE = 'https://api.example.test/api';
const data = () => new DataEngineClient(new BasefyioFetchClient(BASE, 'service-key', {}, () => null), 'p1');

describe('EntityClient vector methods', () => {
  it('search posts a text query with filter, limit and threshold', async () => {
    answer.body = { data: [{ _id: 'a', _score: 0.9, _distance: 0.1 }], scanned: 3, strategy: 'exact' };
    const { data: out, error } = await data()
      .collection('articles')
      .search({ query: 'waterproof boots', filter: { lang: 'en' }, limit: 5, threshold: 0.4 });
    expect(error).toBeNull();
    expect(out!.data[0]._score).toBe(0.9);
    expect(calls).toEqual([
      {
        url: `${BASE}/v1/projects/p1/data/articles/search`,
        method: 'POST',
        body: { query: 'waterproof boots', filter: { lang: 'en' }, limit: 5, threshold: 0.4 },
      },
    ]);
  });

  it('search with a vector', async () => {
    answer.body = { data: [], scanned: 0, strategy: 'exact' };
    await data().collection('articles').search({ vector: [0.1, 0.2] });
    expect(calls[0].body).toEqual({ vector: [0.1, 0.2] });
  });

  it('setVector / getVector / deleteVector use the record vector route', async () => {
    const col = data().collection('articles');
    answer.body = { id: 'r 1', dims: 2 };
    await col.setVector('r 1', [3, 4]);
    answer.body = { id: 'r 1', dims: 2, vector: [0.6, 0.8] };
    const got = await col.getVector('r 1');
    answer = { status: 204 };
    const del = await col.deleteVector('r 1');
    expect(got.data!.vector).toEqual([0.6, 0.8]);
    expect(del).toEqual({ data: null, error: null });
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['PUT', `${BASE}/v1/projects/p1/data/articles/r%201/vector`, { vector: [3, 4] }],
      ['GET', `${BASE}/v1/projects/p1/data/articles/r%201/vector`, undefined],
      ['DELETE', `${BASE}/v1/projects/p1/data/articles/r%201/vector`, undefined],
    ]);
  });

  it('returns API errors with their code instead of throwing', async () => {
    answer = { status: 409, body: { code: 'VECTOR_MODEL_MISMATCH', message: 'Re-embed the entity' } };
    const res = await data().collection('articles').search({ query: 'x' });
    expect(res.data).toBeNull();
    expect(res.error).toMatchObject({ status: 409, code: 'VECTOR_MODEL_MISMATCH', message: 'Re-embed the entity' });
  });
});

describe('DataEngineClient vector setup', () => {
  it('vectorConfig get / set (platform, with purge) / delete', async () => {
    const cfg = data().vectorConfig('articles');
    answer.body = { mode: 'platform', dimensions: 1536, sourcePaths: ['title'], modelTag: 'openai/m', updatedAt: 't' };
    await cfg.get();
    await cfg.set({ mode: 'platform', sourcePaths: ['title', 'body'] });
    await cfg.set({ mode: 'client', dimensions: 768 }, { purge: true });
    answer.body = { deleted: true, cleared: 3 };
    const del = await cfg.delete({ purge: true });
    expect(del.data).toEqual({ deleted: true, cleared: 3 });
    const path = `${BASE}/v1/projects/p1/entities/articles/vector-config`;
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', path, undefined],
      ['PUT', path, { mode: 'platform', sourcePaths: ['title', 'body'] }],
      ['PUT', `${path}?purge=true`, { mode: 'client', dimensions: 768 }],
      ['DELETE', `${path}?purge=true`, undefined],
    ]);
  });

  it('vectorStatus and reembed', async () => {
    answer.body = { mode: 'platform', embedded: 2, total: 3, pending: 1, failed: 0, mismatch: false };
    const st = await data().vectorStatus('articles');
    expect(st.data).toMatchObject({ pending: 1 });
    answer = { status: 202, body: { queued: true, total: 3, reembed: { status: 'QUEUED' } } };
    const re = await data().reembed('articles');
    expect(re.data).toMatchObject({ queued: true });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `${BASE}/v1/projects/p1/entities/articles/vector-status`],
      ['POST', `${BASE}/v1/projects/p1/entities/articles/reembed`],
    ]);
  });
});
