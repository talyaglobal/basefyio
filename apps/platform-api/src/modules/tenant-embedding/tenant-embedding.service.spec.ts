const embeddingsCreate = jest.fn();

jest.mock('openai', () => {
  class APIError extends Error {
    constructor(
      readonly status: number | undefined,
      message: string,
    ) {
      super(message);
    }
  }
  const OpenAI = jest.fn().mockImplementation(() => ({
    embeddings: { create: embeddingsCreate },
  }));
  (OpenAI as any).APIError = APIError;
  return { __esModule: true, default: OpenAI };
});

const poolQuery = jest.fn();
const clientQuery = jest.fn();
jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    query: poolQuery,
    connect: async () => ({ query: clientQuery, release: jest.fn() }),
    end: jest.fn(),
  })),
}));

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import OpenAI from 'openai';
import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantEmbeddingService } from './tenant-embedding.service';
import { EmbeddingProviderService } from '../embedding/providers/embedding-provider.service';

const fetchMock = jest.fn();

interface ProjectFixture {
  id: string;
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  pgvectorEnabled: boolean;
  pgvectorEnabledAt: Date | null;
  embeddingApiKey: string | null;
  embeddingProvider: string | null;
  embeddingModel: string | null;
  embeddingBaseUrl: string | null;
  embeddingReembedState: unknown;
  teamId: string;
}

const project: ProjectFixture = {
  id: 'p1',
  dbHost: 'h',
  dbPort: 5432,
  dbUser: 'u',
  dbPassword: 'pw',
  dbName: 'kb_p1',
  pgvectorEnabled: true,
  pgvectorEnabledAt: new Date(0),
  embeddingApiKey: null,
  embeddingProvider: null,
  embeddingModel: null,
  embeddingBaseUrl: null,
  embeddingReembedState: null,
  teamId: 't1',
};

function service(
  overrides: Partial<ProjectFixture> = {},
  opts: { config?: Record<string, unknown> } = {},
) {
  const prisma = {
    project: {
      findFirst: jest.fn().mockResolvedValue({ ...project, ...overrides }),
      update: jest.fn().mockResolvedValue({}),
    },
  };
  const values: Record<string, unknown> = { 'openai.apiKey': 'sk-platform', ...(opts.config ?? {}) };
  const config = { get: (k: string) => values[k] };
  const providers = new EmbeddingProviderService(config as any);
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const svc = new TenantEmbeddingService(prisma as any, config as any, providers, queue as any);
  const logger = (svc as any).logger;
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  return Object.assign(svc, { prismaMock: prisma, queueMock: queue, providersMock: providers });
}

function embedResponse(n: number, dims = 2) {
  return {
    data: Array.from({ length: n }, (_, i) => ({
      index: i,
      embedding: Array.from({ length: dims }, () => i),
    })),
    usage: { total_tokens: n * 10 },
  };
}

function ollamaResponse(n: number, dims: number) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        embeddings: Array.from({ length: n }, () => Array.from({ length: dims }, (_, i) => i)),
        prompt_eval_count: n * 3,
      }),
  } as unknown as Response;
}

/** Answers the catalog, count and page queries the service runs; everything else returns no rows. */
function storeWith(opts: { vectors: number; tokens?: number; dims?: number }) {
  const ids = Array.from({ length: opts.vectors }, (_, i) => `id-${String(i).padStart(5, '0')}`);
  return async (sql: string, params?: unknown[]) => {
    if (sql.includes('format_type')) return { rows: [{ type: `vector(${opts.dims ?? 1536})` }] };
    if (sql.includes('SELECT (SELECT COUNT(*)')) {
      return { rows: [{ n: String(opts.vectors), tokens: String(opts.tokens ?? opts.vectors * 10) }] };
    }
    if (sql.includes('COUNT(*) AS count FROM kb_embeddings_store')) return { rows: [{ count: String(opts.vectors) }] };
    if (sql.includes('COUNT(*) AS count FROM kb_embeddings')) return { rows: [{ count: String(opts.vectors) }] };
    if (sql.includes('SELECT e.id, e.content')) {
      const limit = Number(params![params!.length - 1]);
      const cursor = params!.length === 2 ? String(params![0]) : null;
      const rows = ids
        .filter((id) => (cursor ? id > cursor : true))
        .slice(0, limit)
        .map((id) => ({ id, content: `content of ${id}` }));
      return { rows };
    }
    return { rows: [] };
  };
}

const responseCode = (err: any) => (err instanceof HttpException ? (err.getResponse() as any).code : undefined);

beforeEach(() => {
  embeddingsCreate.mockReset();
  poolQuery.mockReset();
  clientQuery.mockReset();
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
  // INSERT ... RETURNING echoes the row back; other statements return nothing.
  clientQuery.mockImplementation(async (sql: string, params?: unknown[]) =>
    sql.includes('INSERT INTO kb_embeddings (')
      ? {
          rows: [
            {
              id: `id-${params![0]}`,
              content_hash: params![0],
              namespace: params![1],
              content: params![2],
              metadata: params![3],
              token_count: params![4],
              created_at: new Date(0),
            },
          ],
        }
      : { rows: [] },
  );
});

describe('TenantEmbeddingService.storeBatch', () => {
  it('embeds only new items, once per duplicate, and returns results in input order', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    embeddingsCreate.mockResolvedValue(embedResponse(2));

    const out = await service().storeBatch('p1', [
      { content: 'a', namespace: 'ns' },
      { content: 'b', namespace: 'ns' },
      { content: 'a', namespace: 'ns' },
    ]);

    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
    expect(embeddingsCreate.mock.calls[0][0].input).toEqual(['a', 'b']);
    expect(out.map((r) => r.content)).toEqual(['a', 'b', 'a']);
    expect(out[0].id).toBe(out[2].id);
    expect(clientQuery.mock.calls.filter(([sql]) => sql === 'COMMIT')).toHaveLength(2);
  });

  it('returns stored items without calling the provider', async () => {
    poolQuery.mockImplementation(async (_sql: string, params: string[][]) => ({
      rows: [
        {
          id: 'existing',
          content_hash: params[0][0],
          namespace: 'ns',
          content: 'a',
          metadata: null,
          token_count: 3,
          created_at: new Date(0),
        },
      ],
    }));

    const [rec] = await service().storeBatch('p1', [{ content: 'a', namespace: 'ns' }]);

    expect(rec.id).toBe('existing');
    expect(embeddingsCreate).not.toHaveBeenCalled();
  });

  it('batches provider calls at 100 inputs', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    embeddingsCreate.mockImplementation(async ({ input }: { input: string[] }) =>
      embedResponse(input.length),
    );

    await service().storeBatch(
      'p1',
      Array.from({ length: 250 }, (_, i) => ({ content: `c${i}` })),
    );

    expect(embeddingsCreate.mock.calls.map(([arg]) => arg.input.length)).toEqual([100, 100, 50]);
  });

  it('rolls back when the vector insert fails', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    embeddingsCreate.mockResolvedValue(embedResponse(1));
    const base = clientQuery.getMockImplementation()!;
    clientQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('kb_embeddings_store')) throw new Error('vector dim mismatch');
      return base(sql, params);
    });

    await expect(service().storeBatch('p1', [{ content: 'a' }])).rejects.toThrow('vector dim mismatch');
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
  });

  it('rejects items without content', async () => {
    await expect(service().storeBatch('p1', [{ content: '' }])).rejects.toBeInstanceOf(BadRequestException);
    await expect(service().storeBatch('p1', undefined as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores documents zero-padded to the store width and searches with the query intent', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 0, dims: 4 }));
    embeddingsCreate.mockResolvedValue(embedResponse(1, 2));
    const svc = service();
    const embedSpy = jest.spyOn(svc.providersMock, 'embed');

    await svc.storeBatch('p1', [{ content: 'a' }]);
    await svc.search('p1', { query: 'q' });

    expect(embedSpy.mock.calls[0][2]).toMatchObject({ intent: 'document', targetDimensions: 4 });
    expect(embedSpy.mock.calls[1][2]).toMatchObject({ intent: 'query', targetDimensions: 4 });
    const storeInsert = clientQuery.mock.calls.find(([sql]) => sql.includes('kb_embeddings_store'));
    expect(storeInsert![1][1]).toBe('[0,0,0,0]'); // 2 native dims padded to 4
  });

  it('refuses writes when no key is configured, naming the env var', async () => {
    const svc = service({}, { config: { 'openai.apiKey': '' } });
    await expect(svc.storeBatch('p1', [{ content: 'a' }])).rejects.toThrow(
      'No OpenAI API key configured. Set a per-project key or the platform OPENAI_API_KEY.',
    );
  });
});

describe('provider errors', () => {
  const APIError = (OpenAI as any).APIError;

  beforeEach(() => poolQuery.mockResolvedValue({ rows: [] }));

  it.each([
    [401, BadGatewayException, 'rejected the API key'],
    [429, HttpException, 'quota'],
    [400, BadRequestException, 'rejected the input'],
    [500, BadGatewayException, 'HTTP 500'],
    [undefined, BadGatewayException, 'Could not reach'],
  ])('maps OpenAI %s to a descriptive HTTP error', async (status, type, message) => {
    embeddingsCreate.mockRejectedValue(new APIError(status, 'upstream'));
    const svc = service();

    const err = await svc.search('p1', { query: 'q' }).catch((e) => e);

    expect(err).toBeInstanceOf(type);
    expect(err.message).toContain(message);
  });

  it('search rejects an empty query before calling the provider', async () => {
    await expect(service().search('p1', { query: '' })).rejects.toBeInstanceOf(BadRequestException);
    expect(embeddingsCreate).not.toHaveBeenCalled();
  });
});

describe('TenantEmbeddingService.setProvider', () => {
  it('refuses a model wider than the store', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 5 }));
    embeddingsCreate.mockResolvedValue(embedResponse(1, 2048));

    const err = await service()
      .setProvider('p1', { provider: 'openai', model: 'text-embedding-3-large' })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(responseCode(err)).toBe('EMBEDDING_DIMENSION_TOO_LARGE');
    expect(err.message).toContain('2048');
    expect(err.message).toContain('1536');
  });

  it('refuses a model change while vectors exist unless the re-embed is confirmed', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 5, tokens: 500 }));
    embeddingsCreate.mockResolvedValue(embedResponse(1, 1536));
    const svc = service();

    const err = await svc.setProvider('p1', { provider: 'openai', model: 'text-embedding-3-large' }).catch((e) => e);

    expect(responseCode(err)).toBe('EMBEDDING_MODEL_CHANGE_REQUIRES_REEMBED');
    expect(err.message).toContain('5 vector(s)');
    expect(err.message).toContain('500 tokens');
    expect(err.message).toContain('text-embedding-3-small');
    expect(err.message).toContain('text-embedding-3-large');
    expect(svc.prismaMock.project.update).not.toHaveBeenCalled();
  });

  it('switches and queues the re-embed when confirmed', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 5 }));
    embeddingsCreate.mockResolvedValue(embedResponse(1, 1536));
    const svc = service();

    const res = await svc.setProvider('p1', { provider: 'openai', model: 'text-embedding-3-large', reembed: true });

    expect(svc.prismaMock.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-large', embeddingBaseUrl: null },
      }),
    );
    expect(svc.queueMock.add).toHaveBeenCalledWith(
      'reembed',
      { projectId: 'p1' },
      expect.objectContaining({ jobId: 'reembed-p1', attempts: 1 }),
    );
    expect(res).toMatchObject({ provider: 'openai', model: 'text-embedding-3-large', dimensions: 1536, storedDimensions: 1536, padded: false });
    expect(res.reembed).toEqual({ queued: true, total: 5 });
  });

  it('switches an empty store without a job, and clears the override on null', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 0 }));
    embeddingsCreate.mockResolvedValue(embedResponse(1, 1536));
    const svc = service();

    const res = await svc.setProvider('p1', { provider: 'openai', model: 'text-embedding-3-large' });
    expect(res.reembed).toEqual({ queued: false, total: 0 });
    expect(svc.queueMock.add).not.toHaveBeenCalled();

    const back = service({ embeddingProvider: 'openai', embeddingModel: 'text-embedding-3-large' });
    await back.setProvider('p1', { provider: null });
    expect(back.prismaMock.project.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { embeddingProvider: null, embeddingModel: null, embeddingBaseUrl: null } }),
    );
  });

  it('refuses the re-embed above EMBEDDING_REEMBED_MAX_ROWS', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 11 }));
    embeddingsCreate.mockResolvedValue(embedResponse(1, 1536));
    const svc = service({}, { config: { 'embedding.reembedMaxRows': '10' } });

    const err = await svc
      .setProvider('p1', { provider: 'openai', model: 'text-embedding-3-large', reembed: true })
      .catch((e) => e);

    expect(responseCode(err)).toBe('EMBEDDING_REEMBED_TOO_LARGE');
    expect(err.message).toContain('re-embed limit');
    expect(err.message).not.toContain('EMBEDDING_REEMBED_MAX_ROWS');
    expect(svc.prismaMock.project.update).not.toHaveBeenCalled();
  });

  it('blocks private or plain-http project endpoints unless the operator allows them', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 0 }));
    const svc = service();

    for (const baseUrl of ['http://10.0.0.5:11434', 'https://keycloak:8080', 'http://ollama.example.com']) {
      const err = await svc.setProvider('p1', { provider: 'ollama', baseUrl }).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toContain('public https');
      expect(err.message).not.toContain('EMBEDDING_ALLOW_PRIVATE_BASE_URL');
    }
    await expect(
      svc.setProvider('p1', { provider: 'ollama', baseUrl: 'https://user:pw@ollama.example.com' }),
    ).rejects.toThrow(/credentials/);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(ollamaResponse(1, 768));
    const allowed = service({}, { config: { 'embedding.allowPrivateBaseUrl': true } });
    const res = await allowed.setProvider('p1', { provider: 'ollama', baseUrl: 'http://10.0.0.5:11434' });

    expect(fetchMock.mock.calls[0][0]).toBe('http://10.0.0.5:11434/api/embed');
    expect(res).toMatchObject({ provider: 'ollama', model: 'nomic-embed-text', dimensions: 768, storedDimensions: 1536, padded: true });
    expect(allowed.prismaMock.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { embeddingProvider: 'ollama', embeddingModel: null, embeddingBaseUrl: 'http://10.0.0.5:11434' },
      }),
    );
  });

  it('turns a failed probe (bad key) into a 400 with the provider message', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 0 }));
    embeddingsCreate.mockRejectedValue(new (OpenAI as any).APIError(401, 'Incorrect API key'));

    const err = await service().setProvider('p1', { provider: 'openai', model: 'text-embedding-3-large' }).catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toContain('OpenAI did not accept this configuration');
    expect(err.message).toContain('Incorrect API key');
  });

  it('never runs DDL on the vector store', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 3 }));
    embeddingsCreate.mockResolvedValue(embedResponse(1, 1536));
    await service().setProvider('p1', { provider: 'openai', model: 'text-embedding-3-large', reembed: true });
    const sqls = [...poolQuery.mock.calls, ...clientQuery.mock.calls].map(([sql]) => String(sql));
    expect(sqls.some((s) => /ALTER\s|CREATE INDEX|DROP\s/i.test(s))).toBe(false);
  });

  it('validates the inputs before touching anything', async () => {
    const svc = service();
    await expect(svc.setProvider('p1', { provider: 'acme' as any })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setProvider('p1', { provider: 'openai', model: 'bad model name!' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.setProvider('p1', { provider: null, model: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(embeddingsCreate).not.toHaveBeenCalled();
    expect(poolQuery).not.toHaveBeenCalled();
  });
});

describe('TenantEmbeddingService disclosure and status', () => {
  it('discloses OpenAI in the US by default and never leaks the key', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 2 }));
    embeddingsCreate.mockResolvedValue(embedResponse(1, 1536));

    const d = await service().getDisclosure('p1');

    expect(d.provider).toMatchObject({
      id: 'openai',
      model: 'text-embedding-3-small',
      dimensions: 1536,
      storedDimensions: 1536,
      padded: false,
      keySource: 'platform',
      endpointHost: 'api.openai.com',
    });
    expect(d.dataRegion).toEqual({ code: 'US', label: 'United States' });
    expect(d.storage.region).toEqual({ code: null, label: 'not specified' });
    expect(d.configSource).toBe('platform');
    expect(d.status).toBe('ok');
    expect(d.processing.policyUrl).toMatch(/^https:\/\//);
    expect(JSON.stringify(d)).not.toContain('sk-platform');
  });

  it('discloses a self-hosted Ollama with the operator region and padding', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 2 }));
    fetchMock.mockResolvedValue(ollamaResponse(1, 768));

    const d = await service(
      { embeddingProvider: 'ollama' },
      { config: { 'embedding.hostRegion': 'DE', 'embedding.ollama.baseUrl': 'http://ollama:11434' } },
    ).getDisclosure('p1');

    expect(d.provider).toMatchObject({ id: 'ollama', dimensions: 768, storedDimensions: 1536, padded: true, selfHosted: true, requiresApiKey: false });
    expect(d.dataRegion.code).toBe('DE');
    expect(d.dataRegion.label).toContain('Self-hosted on this server');
    expect(d.dataRegion.label).toContain('Germany');
    expect(d.storage.region).toEqual({ code: 'DE', label: 'Germany' });
    expect(d.configSource).toBe('project');
  });

  it('names the customer endpoint for a remote Ollama and reports a missing key', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 0 }));
    fetchMock.mockResolvedValue(ollamaResponse(1, 768));

    const remote = await service({ embeddingProvider: 'ollama', embeddingBaseUrl: 'https://ollama.customer.example' }).getDisclosure('p1');
    expect(remote.dataRegion.code).toBeNull();
    expect(remote.dataRegion.label).toContain('ollama.customer.example');

    const noKey = await service({ embeddingProvider: 'cohere' }).getDisclosure('p1');
    expect(noKey.status).toBe('no_api_key');
    expect(noKey.statusMessage).toContain('COHERE_API_KEY');
    expect(noKey.provider.keySource).toBe('none');
    expect(noKey.provider.dimensions).toBeNull();
  });

  it('extends the status with provider, model, region and re-embed state', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 2 }));
    embeddingsCreate.mockResolvedValue(embedResponse(1, 1536));
    const state = { status: 'RUNNING', done: 1, total: 2, model: 'x', updatedAt: new Date().toISOString() };

    const s = await service({ embeddingReembedState: state }).getStatus('p1');

    expect(s).toMatchObject({
      pgvectorEnabled: true,
      hasApiKey: true,
      embeddingCount: 2,
      provider: 'openai',
      providerName: 'OpenAI',
      model: 'text-embedding-3-small',
      modelTag: 'text-embedding-3-small',
      configSource: 'platform',
      keySource: 'platform',
      requiresApiKey: true,
      dimensions: 1536,
      storedDimensions: 1536,
      padded: false,
      dataRegion: { code: 'US', label: 'United States' },
    });
    expect(s.reembed).toEqual(state);

    const ollama = await service({ embeddingProvider: 'ollama' }).getStatus('p1');
    expect(ollama.requiresApiKey).toBe(false);
    expect(ollama.hasApiKey).toBe(true);
  });

  it('lists the catalogue with platform key availability and no key values', () => {
    const cat = service({}, { config: { 'embedding.cohere.apiKey': 'co', 'embedding.hostRegion': 'DE' } }).getProviderCatalogue();
    expect(cat.platformProvider).toBe('openai');
    expect(cat.platformModel).toBe('text-embedding-3-small');
    expect(cat.hostRegion).toEqual({ code: 'DE', label: 'Germany' });
    expect(cat.providers.map((p) => p.id)).toEqual(['openai', 'ollama', 'cohere', 'gemini']);
    expect(cat.providers.find((p) => p.id === 'cohere')).toMatchObject({ platformKeyAvailable: true, requiresApiKey: true });
    expect(cat.providers.find((p) => p.id === 'ollama')).toMatchObject({ platformKeyAvailable: false, requiresApiKey: false, selfHosted: true, dataRegion: { code: 'DE' } });
    expect(JSON.stringify(cat)).not.toContain('sk-platform');
    expect(JSON.stringify(cat)).not.toContain('"co"');
  });
});

describe('TenantEmbeddingService re-embed', () => {
  it('rewrites every vector page by page and records progress', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 250 }));
    embeddingsCreate.mockImplementation(async ({ input }: { input: string[] }) => embedResponse(input.length, 1536));
    const svc = service();

    const state = await svc.reembedProject('p1');

    expect(embeddingsCreate.mock.calls.map(([arg]) => arg.input.length)).toEqual([100, 100, 50]);
    const updates = poolQuery.mock.calls.filter(([sql]) => String(sql).includes('UPDATE kb_embeddings_store'));
    expect(updates).toHaveLength(250);
    expect(updates[0][1][0]).toBe('id-00000');
    expect(updates[249][1][0]).toBe('id-00249');
    expect(state).toMatchObject({ status: 'COMPLETED', done: 250, total: 250, model: 'text-embedding-3-small' });

    const persisted = svc.prismaMock.project.update.mock.calls.map((c: any[]) => c[0].data.embeddingReembedState);
    expect(persisted[0]).toMatchObject({ status: 'RUNNING', done: 0, total: 250 });
    expect(persisted.filter((s: any) => s.status === 'RUNNING' && s.done > 0).map((s: any) => s.done)).toEqual([100, 200, 250]);
    expect(persisted[persisted.length - 1].status).toBe('COMPLETED');
  });

  it('records FAILED with the rows done when the provider breaks mid-way, without throwing', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 250 }));
    embeddingsCreate
      .mockImplementationOnce(async ({ input }: { input: string[] }) => embedResponse(input.length, 1536))
      .mockRejectedValueOnce(new (OpenAI as any).APIError(429, 'rate limited'));

    const state = await service().reembedProject('p1');

    expect(state.status).toBe('FAILED');
    expect(state.done).toBe(100);
    expect(state.total).toBe(250);
    expect(state.error).toContain('rate limited');
  });

  it('completes immediately on an empty store', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 0 }));
    const state = await service().reembedProject('p1');
    expect(state).toMatchObject({ status: 'COMPLETED', done: 0, total: 0 });
    expect(embeddingsCreate).not.toHaveBeenCalled();
  });

  it('startReembed refuses while a recent run is active, and above the row limit', async () => {
    poolQuery.mockImplementation(storeWith({ vectors: 3 }));
    const running = { status: 'RUNNING', done: 1, total: 3, model: 'x', updatedAt: new Date().toISOString() };
    const busy = await service({ embeddingReembedState: running }).startReembed('p1').catch((e) => e);
    expect(responseCode(busy)).toBe('EMBEDDING_REEMBED_RUNNING');

    const stale = { ...running, updatedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
    const restarted = service({ embeddingReembedState: stale });
    expect(await restarted.startReembed('p1')).toEqual({ queued: true, total: 3 });
    expect(restarted.queueMock.add).toHaveBeenCalledTimes(1);

    const tooBig = await service({}, { config: { 'embedding.reembedMaxRows': '2' } }).startReembed('p1').catch((e) => e);
    expect(responseCode(tooBig)).toBe('EMBEDDING_REEMBED_TOO_LARGE');
  });
});

describe('TenantEmbeddingService.setEmbeddingApiKey', () => {
  const apiError = (status: number | undefined, message: string) =>
    new (OpenAI as any).APIError(status, message);

  it('tests the key with one embedding request before storing it', async () => {
    embeddingsCreate.mockResolvedValue(embedResponse(1));
    const svc = service();

    const out = await svc.setEmbeddingApiKey('p1', '  sk-project  ');

    expect(out).toEqual({ verified: true, warning: null });
    expect(embeddingsCreate).toHaveBeenCalledTimes(1);
    const ctorCalls = (OpenAI as unknown as jest.Mock).mock.calls;
    expect(ctorCalls[ctorCalls.length - 1][0].apiKey).toBe('sk-project');
    expect(svc.prismaMock.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { embeddingApiKey: 'sk-project' },
    });
  });

  it('refuses a key the provider rejects and stores nothing', async () => {
    embeddingsCreate.mockRejectedValue(apiError(401, 'Incorrect API key provided: fake'));
    const svc = service();

    const err = await svc.setEmbeddingApiKey('p1', 'fake').catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(responseCode(err)).toBe('EMBEDDING_API_KEY_REJECTED');
    expect((err.getResponse() as any).message).toContain('OpenAI rejected this API key');
    expect(svc.prismaMock.project.update).not.toHaveBeenCalled();
  });

  it('reports an unreachable provider separately and lets the caller skip the check', async () => {
    embeddingsCreate.mockRejectedValue(apiError(undefined, 'Connection error.'));
    const svc = service();

    const err = await svc.setEmbeddingApiKey('p1', 'sk-x').catch((e) => e);
    expect(err).toBeInstanceOf(BadGatewayException);
    expect(responseCode(err)).toBe('EMBEDDING_PROVIDER_UNREACHABLE');
    expect(svc.prismaMock.project.update).not.toHaveBeenCalled();

    embeddingsCreate.mockClear();
    const skipped = await svc.setEmbeddingApiKey('p1', 'sk-x', { skipValidation: true });
    expect(skipped).toEqual({ verified: false, warning: null });
    expect(embeddingsCreate).not.toHaveBeenCalled();
    expect(svc.prismaMock.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { embeddingApiKey: 'sk-x' },
    });
  });

  it('stores a key that authenticated but hit a quota, with a warning', async () => {
    embeddingsCreate.mockRejectedValue(apiError(429, 'You exceeded your current quota'));
    const out = await service().setEmbeddingApiKey('p1', 'sk-x');
    expect(out.verified).toBe(true);
    expect(out.warning).toContain('quota');
  });

  it('clears the key without calling the provider', async () => {
    const svc = service({ embeddingApiKey: 'sk-old' });
    for (const empty of [null, '', '   ']) {
      expect(await svc.setEmbeddingApiKey('p1', empty)).toEqual({ verified: false, warning: null });
    }
    expect(embeddingsCreate).not.toHaveBeenCalled();
    expect(svc.prismaMock.project.update).toHaveBeenLastCalledWith({
      where: { id: 'p1' },
      data: { embeddingApiKey: null },
    });
  });

  it('refuses a key with whitespace inside before any request', async () => {
    const err = await service().setEmbeddingApiKey('p1', 'sk-a b').catch((e) => e);
    expect(responseCode(err)).toBe('EMBEDDING_API_KEY_INVALID_FORMAT');
    expect(embeddingsCreate).not.toHaveBeenCalled();
  });

  it('tests against the provider the dashboard is switching to, not the saved one', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ embeddings: { float: [[0.1, 0.2]] } }),
    } as unknown as Response);

    const out = await service().setEmbeddingApiKey('p1', 'co-key', { provider: 'cohere' });

    expect(out.verified).toBe(true);
    expect(embeddingsCreate).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.cohere.com/v2/embed');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer co-key');
  });

  it("treats Gemini's 400 API_KEY_INVALID as a rejected key", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
          },
        }),
    } as unknown as Response);

    const err = await service()
      .setEmbeddingApiKey('p1', 'AIza-fake', { provider: 'gemini' })
      .catch((e) => e);

    expect(responseCode(err)).toBe('EMBEDDING_API_KEY_REJECTED');
    expect((err.getResponse() as any).message).toContain('Google Gemini rejected this API key');
  });
});

describe('TenantEmbeddingService.disablePgvector', () => {
  it('keeps the tables by default', async () => {
    const svc = service();
    expect(await svc.disablePgvector('p1')).toEqual({ dataDropped: false });
    expect(clientQuery).not.toHaveBeenCalled();
    expect(svc.prismaMock.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { pgvectorEnabled: false },
    });
  });

  it('drops the platform tables in one transaction before turning the flag off', async () => {
    const done = { status: 'COMPLETED', done: 3, total: 3, model: 'x', updatedAt: new Date().toISOString() };
    const svc = service({ embeddingReembedState: done });

    expect(await svc.disablePgvector('p1', { dropData: true })).toEqual({ dataDropped: true });

    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'DROP TABLE IF EXISTS "kb_embeddings_store"',
      'DROP TABLE IF EXISTS "kb_embeddings"',
      'COMMIT',
    ]);
    // Never the extension: the project's own tables may use it.
    expect(clientQuery.mock.calls.some(([sql]) => /DROP EXTENSION/i.test(sql))).toBe(false);
    expect(svc.prismaMock.project.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { pgvectorEnabled: false, embeddingReembedState: Prisma.DbNull },
    });
  });

  it('leaves everything as it was when customer objects depend on the tables', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'DROP TABLE IF EXISTS "kb_embeddings"') {
        throw Object.assign(
          new Error('cannot drop table kb_embeddings because other objects depend on it'),
          { code: '2BP01', detail: 'view my_search depends on table kb_embeddings' },
        );
      }
      return { rows: [] };
    });
    const svc = service();

    const err = await svc.disablePgvector('p1', { dropData: true }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(responseCode(err)).toBe('EMBEDDING_TABLES_IN_USE');
    expect((err.getResponse() as any).message).toContain('view my_search depends on table kb_embeddings');
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK');
    expect(svc.prismaMock.project.update).not.toHaveBeenCalled();
  });

  it('refuses to drop data while a re-embed is running', async () => {
    const running = { status: 'RUNNING', done: 1, total: 3, model: 'x', updatedAt: new Date().toISOString() };
    const svc = service({ embeddingReembedState: running });
    const err = await svc.disablePgvector('p1', { dropData: true }).catch((e) => e);
    expect(responseCode(err)).toBe('EMBEDDING_REEMBED_RUNNING');
    expect(clientQuery).not.toHaveBeenCalled();
    expect(svc.prismaMock.project.update).not.toHaveBeenCalled();
  });
});
