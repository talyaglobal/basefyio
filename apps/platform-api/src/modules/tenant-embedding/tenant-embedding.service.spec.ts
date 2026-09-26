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
import { BadGatewayException, BadRequestException, HttpException } from '@nestjs/common';
import { TenantEmbeddingService } from './tenant-embedding.service';

const project = {
  id: 'p1',
  dbHost: 'h',
  dbPort: 5432,
  dbUser: 'u',
  dbPassword: 'pw',
  dbName: 'kb_p1',
  pgvectorEnabled: true,
  embeddingApiKey: null,
  teamId: 't1',
};

function service() {
  const prisma = { project: { findFirst: jest.fn().mockResolvedValue(project) } };
  const config = { get: (k: string) => (k === 'openai.apiKey' ? 'sk-platform' : undefined) };
  return new TenantEmbeddingService(prisma as any, config as any);
}

function embedResponse(n: number) {
  return {
    data: Array.from({ length: n }, (_, i) => ({ index: i, embedding: [i, i] })),
    usage: { total_tokens: n * 10 },
  };
}

beforeEach(() => {
  embeddingsCreate.mockReset();
  poolQuery.mockReset();
  clientQuery.mockReset();
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
    jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);

    const err = await svc.search('p1', { query: 'q' }).catch((e) => e);

    expect(err).toBeInstanceOf(type);
    expect(err.message).toContain(message);
  });

  it('search rejects an empty query before calling the provider', async () => {
    await expect(service().search('p1', { query: '' })).rejects.toBeInstanceOf(BadRequestException);
    expect(embeddingsCreate).not.toHaveBeenCalled();
  });
});
