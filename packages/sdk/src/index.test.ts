import { describe, expect, it, vi } from 'vitest';
import { createClient, createPlatformClient, ApiError, NetworkError } from './index';

// ── Helpers ───────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
    text: async () => (body == null ? '' : JSON.stringify(body)),
  } as unknown as Response);
}

function fetchErr(message: string) {
  return vi.fn().mockRejectedValue(new Error(message));
}

// ── createClient ──────────────────────────────────────────────────────────────

describe('createClient', () => {
  it('requires url', () => {
    expect(() => createClient({ url: '', projectId: 'p', apiKey: 'k' })).toThrow(/url/);
  });
  it('requires projectId', () => {
    expect(() => createClient({ url: 'http://localhost', projectId: '', apiKey: 'k' })).toThrow(/projectId/);
  });
  it('requires apiKey', () => {
    expect(() => createClient({ url: 'http://localhost', projectId: 'p', apiKey: '' })).toThrow(/apiKey/);
  });

  it('health() calls GET /health with x-api-key header', async () => {
    const fetch = mockFetch({ status: 'ok' });
    const client = createClient({
      url: 'http://localhost:4000/',
      projectId: 'proj-uuid',
      apiKey: 'secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const res = await client.health();
    expect(res.status).toBe('ok');

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('http://localhost:4000/health');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('secret');
  });

  it('sql.execute() posts to POST /sql/execute with projectId in body', async () => {
    const payload = { rows: [{ n: 1 }], fields: [], rowCount: 1, duration: 5, page: 1, limit: 100, paginated: false, total: null, totalIsApprox: false, resultSets: [] };
    const fetch = mockFetch(payload);
    const client = createClient({
      url: 'http://localhost:4000',
      projectId: 'proj-uuid',
      apiKey: 'secret',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const result = await client.sql.execute('SELECT 1 AS n');
    expect(result.rows).toEqual([{ n: 1 }]);
    expect(result.rowCount).toBe(1);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/sql/execute');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ projectId: 'proj-uuid', query: 'SELECT 1 AS n' });
  });

  it('sql.execute() passes pagination options in body', async () => {
    const payload = { rows: [], fields: [], rowCount: 0, duration: 2, page: 2, limit: 50, paginated: true, total: 120, totalIsApprox: false, resultSets: [] };
    const fetch = mockFetch(payload);
    const client = createClient({
      url: 'http://localhost:4000',
      projectId: 'proj-uuid',
      apiKey: 'key',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await client.sql.execute('SELECT * FROM t', { page: 2, limit: 50, countTotal: true });
    const body = JSON.parse((fetch.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ page: 2, limit: 50, countTotal: true });
  });

  it('sql.execute() throws ApiError on non-2xx', async () => {
    const fetch = mockFetch({ message: 'bad query' }, false, 400);
    const client = createClient({
      url: 'http://localhost:4000',
      projectId: 'proj-uuid',
      apiKey: 'key',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    await expect(client.sql.execute('NOT SQL')).rejects.toBeInstanceOf(ApiError);
  });

  it('sql.execute() throws NetworkError on fetch failure', async () => {
    const client = createClient({
      url: 'http://localhost:4000',
      projectId: 'proj-uuid',
      apiKey: 'key',
      fetch: fetchErr('ECONNREFUSED') as unknown as typeof globalThis.fetch,
    });
    await expect(client.sql.execute('SELECT 1')).rejects.toBeInstanceOf(NetworkError);
  });

  it('storage.listBuckets() calls GET /projects/:id/storage/buckets', async () => {
    const fetch = mockFetch([{ name: 'uploads', public: false }]);
    const client = createClient({
      url: 'http://localhost:4000',
      projectId: 'proj-uuid',
      apiKey: 'key',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const buckets = await client.storage.listBuckets();
    expect(buckets).toHaveLength(1);
    expect(buckets[0].name).toBe('uploads');

    const [url] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/projects/proj-uuid/storage/buckets');
  });

  it('storage.createBucket() posts to /projects/:id/storage/buckets', async () => {
    const fetch = mockFetch({ name: 'images', public: true });
    const client = createClient({
      url: 'http://localhost:4000',
      projectId: 'proj-uuid',
      apiKey: 'key',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const bucket = await client.storage.createBucket({ name: 'images', public: true });
    expect(bucket.name).toBe('images');

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/projects/proj-uuid/storage/buckets');
    expect(init.method).toBe('POST');
  });

  it('storage.getObjectUrl() builds correct URL with query params', async () => {
    const fetch = mockFetch({ url: 'https://cdn.example.com/file.pdf?token=x' });
    const client = createClient({
      url: 'http://localhost:4000',
      projectId: 'proj-uuid',
      apiKey: 'key',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await client.storage.getObjectUrl('docs', 'reports/q1.pdf', { expiresIn: 3600 });

    const [url] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/projects/proj-uuid/storage/buckets/docs/objects/url');
    expect(url).toContain('key=reports%2Fq1.pdf');
    expect(url).toContain('expiresIn=3600');
  });
});

// ── createPlatformClient ──────────────────────────────────────────────────────

describe('createPlatformClient', () => {
  it('requires url', () => {
    expect(() => createPlatformClient({ url: '' })).toThrow(/url/);
  });

  it('health() calls GET /health', async () => {
    const fetch = mockFetch({ status: 'ok' });
    const platform = createPlatformClient({
      url: 'http://localhost:4000',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const res = await platform.health();
    expect(res.status).toBe('ok');
    const [url] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/health');
  });

  it('auth.signIn() posts credentials, sets token, returns session', async () => {
    const session = { accessToken: 'tok123', refreshToken: 'ref456' };
    const fetch = mockFetch(session);
    const platform = createPlatformClient({
      url: 'http://localhost:4000',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    expect(platform.getToken()).toBeNull();
    const result = await platform.auth.signIn({ email: 'u@example.com', password: 'pass' });

    expect(result.accessToken).toBe('tok123');
    expect(platform.getToken()).toBe('tok123');

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/auth/login');
    expect(JSON.parse(init.body as string)).toMatchObject({ email: 'u@example.com', password: 'pass' });
  });

  it('auth.signOut() clears stored token', async () => {
    const fetch = mockFetch({});
    const platform = createPlatformClient({
      url: 'http://localhost:4000',
      initialToken: 'existing-token',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    expect(platform.getToken()).toBe('existing-token');
    await platform.auth.signOut();
    expect(platform.getToken()).toBeNull();
  });

  it('projects.list() sends Authorization header', async () => {
    const fetch = mockFetch([{ id: '1', name: 'demo' }]);
    const platform = createPlatformClient({
      url: 'http://localhost:4000',
      initialToken: 'jwt-token',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const projects = await platform.projects.list();
    expect(projects[0].name).toBe('demo');

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('http://localhost:4000/api/projects');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer jwt-token');
  });

  it('projects.create() posts to /projects', async () => {
    const fetch = mockFetch({ id: 'new-id', name: 'my-project' });
    const platform = createPlatformClient({
      url: 'http://localhost:4000',
      initialToken: 'jwt-token',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    const project = await platform.projects.create({ name: 'my-project', teamId: 'tid' });
    expect(project.id).toBe('new-id');

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/projects');
    expect(init.method).toBe('POST');
  });

  it('projects.delete() calls DELETE /projects/:id', async () => {
    const fetch = mockFetch(null);
    const platform = createPlatformClient({
      url: 'http://localhost:4000',
      initialToken: 'jwt-token',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await platform.projects.delete('proj-id');

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:4000/api/projects/proj-id');
    expect(init.method).toBe('DELETE');
  });

  it('setToken() / getToken() work manually', () => {
    const platform = createPlatformClient({
      url: 'http://localhost:4000',
      fetch: mockFetch({}) as unknown as typeof globalThis.fetch,
    });

    platform.setToken('manual-jwt');
    expect(platform.getToken()).toBe('manual-jwt');
    platform.setToken(null);
    expect(platform.getToken()).toBeNull();
  });

  it('initialToken is used immediately for requests', async () => {
    const fetch = mockFetch({ id: 'p1' });
    const platform = createPlatformClient({
      url: 'http://localhost:4000',
      initialToken: 'pre-loaded-token',
      fetch: fetch as unknown as typeof globalThis.fetch,
    });

    await platform.projects.get('p1');

    const [, init] = fetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer pre-loaded-token');
  });
});

// ── Error types ───────────────────────────────────────────────────────────────

describe('ApiError', () => {
  it('carries status, body, and code', () => {
    const err = new ApiError('not found', 404, { reason: 'missing' });
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ reason: 'missing' });
    expect(err.code).toBe('API_ERROR');
    expect(err.name).toBe('ApiError');
    expect(err instanceof Error).toBe(true);
  });
});

describe('NetworkError', () => {
  it('carries cause and code', () => {
    const cause = new Error('timeout');
    const err = new NetworkError('request failed', cause);
    expect(err.cause).toBe(cause);
    expect(err.code).toBe('NETWORK_ERROR');
    expect(err.name).toBe('NetworkError');
    expect(err instanceof Error).toBe(true);
  });
});
