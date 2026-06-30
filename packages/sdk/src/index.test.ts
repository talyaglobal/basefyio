import { describe, expect, it, vi } from 'vitest';
import { createClient } from './index';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('createClient', () => {
  it('validates required options', () => {
    expect(() => createClient({ url: '', projectSlug: 'p', apiKey: 'k' })).toThrow(/url/);
    expect(() => createClient({ url: 'u', projectSlug: '', apiKey: 'k' })).toThrow(/projectSlug/);
    expect(() => createClient({ url: 'u', projectSlug: 'p', apiKey: '' })).toThrow(/apiKey/);
  });

  it('calls /health with auth + project headers', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'ok' }));
    const client = createClient({
      url: 'http://localhost:4000/',
      projectSlug: 'my-app',
      apiKey: 'secret',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const res = await client.health();
    expect(res.status).toBe('ok');

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('http://localhost:4000/health');
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer secret');
    expect(headers['x-basefyio-project']).toBe('my-app');
  });

  it('posts SQL to the project-scoped endpoint and returns data', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ n: 1 }] }));
    const client = createClient({
      url: 'http://localhost:4000',
      projectSlug: 'my-app',
      apiKey: 'secret',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.sql('SELECT 1 AS n');
    expect(result.error).toBeNull();
    expect(result.data).toEqual([{ n: 1 }]);

    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('http://localhost:4000/projects/my-app/sql');
    expect((init as { method: string }).method).toBe('POST');
  });

  it('returns an error result on non-ok SQL responses', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: 'bad query' }, false, 400));
    const client = createClient({
      url: 'http://localhost:4000',
      projectSlug: 'my-app',
      apiKey: 'secret',
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.sql('NOT SQL');
    expect(result.data).toBeNull();
    expect(result.error).toBe('bad query');
  });
});
