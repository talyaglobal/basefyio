import * as crypto from 'crypto';
import { Logger } from '@nestjs/common';
import { EmbeddingService } from './embedding.service';
import { EmbeddingProviderError } from './providers/embedding-provider';

const sha = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

function build(opts: { tag?: string; platformNull?: boolean; storeType?: string | Error } = {}) {
  const tag = opts.tag ?? 'text-embedding-3-small';
  const resolved = opts.platformNull
    ? null
    : { tag, config: { provider: 'openai', model: tag }, provider: { id: 'openai', model: tag, endpoint: 'x' } };
  const providers = {
    platform: jest.fn(() => resolved),
    describePlatform: jest.fn(() => ({ tag, config: { provider: 'openai', model: tag }, keySource: 'none' })),
    embed: jest.fn(),
  };
  const prisma = {
    embeddingRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      upsert: jest.fn().mockResolvedValue({ id: 'rec-1' }),
    },
    $queryRawUnsafe: jest.fn().mockImplementation(async () => {
      if (opts.storeType instanceof Error) throw opts.storeType;
      return [{ type: opts.storeType ?? 'vector(1536)' }];
    }),
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    incrby: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  };
  const vectorStore = { upsertVector: jest.fn().mockResolvedValue(undefined) };
  const queue = { add: jest.fn().mockResolvedValue({}) };
  const config = { get: (k: string) => (k === 'embedding.maxDailyTokens' ? 1000 : undefined) };
  const svc = new EmbeddingService(
    config as any,
    prisma as any,
    redis as any,
    vectorStore as any,
    queue as any,
    providers as any,
  );
  const logger = (svc as any).logger;
  jest.spyOn(logger, 'error').mockImplementation(() => undefined);
  jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  return { svc, providers, prisma, redis, vectorStore, logger };
}

const outcome = (vectors: number[][], extra: Partial<Record<string, unknown>> = {}) => ({
  vectors,
  tokenCount: 5,
  model: 'text-embedding-3-small',
  dimensions: vectors[0]?.length ?? 0,
  usedFallback: false,
  padded: false,
  nativeDimensions: vectors[0]?.length ?? 0,
  tag: 'text-embedding-3-small',
  ...extra,
});

describe('EmbeddingService.generateEmbedding', () => {
  it('caches under a key that carries provider/model and intent', async () => {
    const { svc, providers, redis } = build();
    providers.embed.mockResolvedValue(outcome([[1, 2]]));

    const vec = await svc.generateEmbedding('hello');

    expect(vec).toEqual([1, 2]);
    expect(redis.set).toHaveBeenCalledWith(
      `emb:v2:text-embedding-3-small/query:${sha('hello')}`,
      JSON.stringify([1, 2]),
      86_400,
    );
    expect(providers.embed.mock.calls[0][2]).toMatchObject({ intent: 'query', targetDimensions: 1536 });
  });

  it('changes the cache key with the model', async () => {
    const { svc, providers, redis } = build({ tag: 'ollama/nomic-embed-text' });
    providers.embed.mockResolvedValue(outcome([[1]], { tag: 'ollama/nomic-embed-text' }));
    await svc.generateEmbedding('hello', 'document');
    expect(redis.set.mock.calls[0][0]).toBe(`emb:v2:ollama/nomic-embed-text/document:${sha('hello')}`);
  });

  it('serves a cached vector without calling the provider', async () => {
    const { svc, providers, redis } = build();
    redis.get.mockResolvedValue(JSON.stringify([7, 7]));
    expect(await svc.generateEmbedding('hello')).toEqual([7, 7]);
    expect(providers.embed).not.toHaveBeenCalled();
  });

  it('does not cache a vector produced by the fallback', async () => {
    const { svc, providers, redis } = build();
    providers.embed.mockResolvedValue(outcome([[1]], { usedFallback: true, tag: 'ollama/nomic-embed-text' }));
    expect(await svc.generateEmbedding('hello')).toEqual([1]);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('returns null when the provider fails, and when the budget is spent', async () => {
    const { svc, providers, redis } = build();
    providers.embed.mockRejectedValue(new EmbeddingProviderError('openai', 500, 'unknown', 'boom'));
    expect(await svc.generateEmbedding('hello')).toBeNull();

    providers.embed.mockClear();
    redis.get.mockImplementation(async (key: string) => (key.startsWith('emb:usage:') ? '5000' : null));
    expect(await svc.generateEmbedding('hello')).toBeNull();
    expect(providers.embed).not.toHaveBeenCalled();
  });

  it('is disabled when the platform provider has no key', async () => {
    // The warning is emitted by the constructor, so the spy has to exist before build().
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc, providers } = build({ platformNull: true });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('OPENAI_API_KEY not set'));
    warnSpy.mockRestore();
    expect(await svc.generateEmbedding('hello')).toBeNull();
    expect(await svc.embedContent('hello', 'feedback', 'f1')).toBeNull();
    expect(providers.embed).not.toHaveBeenCalled();
  });

  it('reads the store width from the catalog and falls back to 1536 when the query fails', async () => {
    const good = build({ storeType: 'vector(768)' });
    good.providers.embed.mockResolvedValue(outcome([[1]]));
    await good.svc.generateEmbedding('a');
    expect(good.providers.embed.mock.calls[0][2].targetDimensions).toBe(768);

    const bad = build({ storeType: new Error('no table') });
    bad.providers.embed.mockResolvedValue(outcome([[1]]));
    await bad.svc.generateEmbedding('a');
    expect(bad.providers.embed.mock.calls[0][2].targetDimensions).toBe(1536);
  });
});

describe('EmbeddingService dedup is model-aware', () => {
  it('returns the existing record when it was made with the current model', async () => {
    const { svc, providers, prisma } = build();
    prisma.embeddingRecord.findUnique.mockResolvedValue({ id: 'rec-old', embeddingModel: 'text-embedding-3-small' });

    expect(await svc.embedContent('text', 'feedback', 'f1')).toBe('rec-old');
    expect(providers.embed).not.toHaveBeenCalled();
  });

  it('re-embeds and overwrites a record made with another model', async () => {
    const { svc, providers, prisma, vectorStore } = build();
    prisma.embeddingRecord.findUnique.mockResolvedValue({ id: 'rec-old', embeddingModel: 'ollama/nomic-embed-text' });
    providers.embed.mockResolvedValue(outcome([[3, 3]]));

    expect(await svc.embedContent('text', 'feedback', 'f1', { projectId: 'p1' })).toBe('rec-1');

    expect(providers.embed.mock.calls[0][2]).toMatchObject({ intent: 'document' });
    const upsert = prisma.embeddingRecord.upsert.mock.calls[0][0];
    expect(upsert.create.embeddingModel).toBe('text-embedding-3-small');
    expect(upsert.update.embeddingModel).toBe('text-embedding-3-small');
    expect(vectorStore.upsertVector).toHaveBeenCalledWith('rec-1', [3, 3]);
  });

  it('embedBatch treats records of another model as missing', async () => {
    const { svc, providers, prisma } = build();
    prisma.embeddingRecord.findMany.mockResolvedValue([
      { id: 'keep', contentHash: sha('a'), entityId: 'e1', embeddingModel: 'text-embedding-3-small' },
      { id: 'stale', contentHash: sha('b'), entityId: 'e2', embeddingModel: 'other/model' },
    ]);
    providers.embed.mockResolvedValue(outcome([[1]]));

    const out = await svc.embedBatch([
      { entityType: 'feedback', entityId: 'e1', content: 'a' },
      { entityType: 'feedback', entityId: 'e2', content: 'b' },
    ]);

    expect(out.get('e1')).toBe('keep');
    expect(out.get('e2')).toBe('rec-1');
    expect(providers.embed).toHaveBeenCalledTimes(1);
    expect(providers.embed.mock.calls[0][1]).toEqual(['b']);
  });
});
