jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadGatewayException, BadRequestException, HttpException } from '@nestjs/common';
import { ConcurrencyError, DocumentNotFoundError } from '@basefyio/data-engine';
import {
  DataVectorEmbedderService,
  EMBED_RECORD_JOB,
  REEMBED_ENTITY_JOB,
  embedRecordJobId,
  safeError,
} from './data-vector-embedder.service';
import { DataVectorProcessor } from './data-vector.processor';
import { buildSourceText, sourceHash } from './vector-source';
import type { PlatformVectorConfig, VectorReembedState } from './data-engine.service';

const TAG = 'openai/text-embedding-3-small';
const CONFIG: PlatformVectorConfig = {
  mode: 'platform',
  dimensions: 2,
  sourcePaths: ['title', 'body'],
  modelTag: TAG,
  updatedAt: 't',
};

interface Rec {
  data: Record<string, unknown>;
  version: number;
  vector: { dims: number; model: string; source: string; hash: string | null; updatedAt: string } | null;
  marker: { kind: 'empty' | 'failed'; model: string; hash: string | null; error?: string | null; updatedAt: string } | null;
}

/** An in-memory platform collection of one project + entity. */
function fakeCollection(records: Record<string, Rec>) {
  const col = {
    records,
    vectorSources: jest.fn(async (q: { paths: string[]; ids?: string[]; after?: string; limit?: number }) => {
      let ids = Object.keys(records).sort();
      if (q.ids) ids = ids.filter((i) => q.ids!.includes(i));
      if (q.after) ids = ids.filter((i) => i > q.after!);
      return ids.slice(0, q.limit ?? 100).map((id) => ({
        id,
        version: records[id].version,
        data: records[id].data,
        vector: records[id].vector ? { id, ...records[id].vector! } : null,
        marker: records[id].marker,
      }));
    }),
    setVector: jest.fn(async (id: string, vector: number[], opts: any) => {
      const r = records[id];
      if (!r) throw new DocumentNotFoundError('docs', id);
      if (opts?.ifVersion !== undefined && r.version !== opts.ifVersion) {
        throw new ConcurrencyError('docs', id, opts.ifVersion, r.version);
      }
      r.vector = { dims: vector.length, model: opts.model, source: opts.source, hash: opts.hash, updatedAt: 'now' };
      r.marker = null;
      return { id, ...r.vector, vector };
    }),
    setVectorMarker: jest.fn(async (id: string, marker: any, opts?: { ifVersion?: number }) => {
      const r = records[id];
      if (!r || (opts?.ifVersion !== undefined && r.version !== opts.ifVersion)) return false;
      r.marker = { ...marker, updatedAt: 'now' };
      if (marker.kind === 'empty') r.vector = null;
      return true;
    }),
    vectorStats: jest.fn(async () => ({ embedded: 0, total: Object.keys(records).length })),
  };
  return col;
}

function build(opts: {
  records?: Record<string, Rec>;
  config?: unknown;
  reembed?: VectorReembedState | null;
  embed?: jest.Mock;
  tag?: string;
  dimensions?: number;
  resolveError?: unknown;
  planError?: unknown;
} = {}) {
  const col = fakeCollection(opts.records ?? {});
  let config: any = opts.config === undefined ? CONFIG : opts.config;
  let reembed = opts.reembed ?? null;
  const states: VectorReembedState[] = [];
  const dataEngine = {
    getEntityCollection: jest.fn(async () => col),
    getVectorConfig: jest.fn(async () => config),
    getVectorSetup: jest.fn(async () => ({ config, reembed })),
    setVectorReembedState: jest.fn(async (_p: string, _e: string, s: VectorReembedState | null) => {
      if (s) states.push({ ...s });
      reembed = s;
    }),
    setVectorConfig: jest.fn(async (_p: string, _e: string, c: unknown) => {
      config = c;
    }),
  };
  const resolved = { tag: opts.tag ?? TAG, keySource: 'platform' };
  const embed =
    opts.embed ??
    jest.fn(async (_project: unknown, texts: string[]) => ({
      vectors: texts.map((t) => [t.length, 1]),
      tokenCount: texts.length,
      perItemTokens: 1,
      tag: opts.tag ?? TAG,
      nativeDimensions: 2,
    }));
  const projectEmbedding = {
    loadProject: jest.fn(async (id: string) => ({ id })),
    resolve: jest.fn(() => {
      if (opts.resolveError) throw opts.resolveError;
      return resolved;
    }),
    dimensions: jest.fn(async () => opts.dimensions ?? 2),
    assertPlatformKeyAllowed: jest.fn(async () => {
      if (opts.planError) throw opts.planError;
    }),
    embedForProject: embed,
  };
  const queue = { add: jest.fn(async () => ({})) };
  const svc = new DataVectorEmbedderService(dataEngine as any, projectEmbedding as any, queue as any);
  jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn((svc as any).logger, 'log').mockImplementation(() => undefined);
  return { svc, col, dataEngine, projectEmbedding, queue, embed, states, current: () => ({ config, reembed }) };
}

const rec = (data: Record<string, unknown>, over: Partial<Rec> = {}): Rec => ({
  data,
  version: 1,
  vector: null,
  marker: null,
  ...over,
});

const flush = () => new Promise((r) => setImmediate(r));

describe('DataVectorEmbedderService.afterWrite (enqueue)', () => {
  it('queues one delayed, deduplicated embed-record job for a platform-mode entity', async () => {
    const { svc, queue } = build();
    svc.afterWrite('p1', 'docs', 'r1', CONFIG);
    await flush();
    expect(queue.add).toHaveBeenCalledWith(
      EMBED_RECORD_JOB,
      { projectId: 'p1', entity: 'docs', id: 'r1' },
      expect.objectContaining({ jobId: embedRecordJobId('p1', 'docs', 'r1'), attempts: 1, removeOnComplete: true }),
    );
    const opts = (queue.add.mock.calls[0] as any[])[2];
    expect(opts.delay).toBeGreaterThan(0);
    expect(opts.jobId).not.toContain(':');
    // Same record, same job id: a burst collapses; another record or project gets its own.
    expect(embedRecordJobId('p1', 'docs', 'r1')).toBe(opts.jobId);
    expect(embedRecordJobId('p2', 'docs', 'r1')).not.toBe(opts.jobId);
    expect(embedRecordJobId('p1', 'notes', 'r1')).not.toBe(opts.jobId);
  });

  it('queues nothing for a client-mode entity or one without vectors', async () => {
    const { svc, queue } = build();
    svc.afterWrite('p1', 'docs', 'r1', { mode: 'client', dimensions: 3, updatedAt: 't' });
    svc.afterWrite('p1', 'docs', 'r1', null);
    svc.afterWrite('p1', 'docs', undefined, CONFIG);
    await flush();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('reads the setup itself when the caller has none (restore)', async () => {
    const { svc, queue, dataEngine } = build();
    svc.afterWrite('p1', 'docs', 'r1');
    await flush();
    expect(dataEngine.getVectorConfig).toHaveBeenCalledWith('p1', 'docs');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('a queue failure never reaches the write', async () => {
    const { svc, queue } = build();
    queue.add.mockRejectedValueOnce(new Error('redis down'));
    expect(() => svc.afterWrite('p1', 'docs', 'r1', CONFIG)).not.toThrow();
    await flush();
  });
});

describe('DataVectorEmbedderService.embedRecord (worker)', () => {
  it('embeds a changed record and stores source, model, hash at the version it read', async () => {
    const records = { r1: rec({ title: 'Red shoes', body: 'Leather', other: 'x' }, { version: 4 }) };
    const { svc, col, embed } = build({ records });
    expect(await svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).toBe('embedded');
    const text = buildSourceText(records.r1.data, CONFIG.sourcePaths);
    expect(text).toBe('Red shoes\nLeather');
    expect(embed).toHaveBeenCalledWith({ id: 'p1' }, [text], expect.objectContaining({ intent: 'document', targetDimensions: 2 }));
    expect(col.setVector).toHaveBeenCalledWith('r1', [text.length, 1], {
      dimensions: 2,
      model: TAG,
      source: 'platform',
      hash: sourceHash(text),
      ifVersion: 4,
    });
  });

  it('skips a record whose text and model are unchanged (no provider call)', async () => {
    const data = { title: 'Red shoes', body: 'Leather' };
    const hash = sourceHash(buildSourceText(data, CONFIG.sourcePaths));
    const records = { r1: rec(data, { vector: { dims: 2, model: TAG, source: 'platform', hash, updatedAt: 't' } }) };
    const { svc, embed, col } = build({ records });
    expect(await svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).toBe('unchanged');
    expect(embed).not.toHaveBeenCalled();
    expect(col.setVector).not.toHaveBeenCalled();
  });

  it('re-embeds when the stored vector is from another model', async () => {
    const data = { title: 'Red shoes' };
    const hash = sourceHash(buildSourceText(data, CONFIG.sourcePaths));
    const records = { r1: rec(data, { vector: { dims: 2, model: 'openai/old', source: 'platform', hash, updatedAt: 't' } }) };
    const { svc, embed } = build({ records });
    expect(await svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).toBe('embedded');
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('a missing record (deleted, or not in this project/entity) is skipped without embedding', async () => {
    const { svc, embed, col } = build({ records: {} });
    expect(await svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'nope' })).toBe('missing');
    expect(embed).not.toHaveBeenCalled();
    expect(col.setVector).not.toHaveBeenCalled();
  });

  it('only ever opens the collection of the job\'s own project and entity', async () => {
    const { svc, dataEngine, col } = build({ records: { r1: rec({ title: 'a' }) } });
    await svc.embedRecord({ projectId: 'p9', entity: 'notes', id: 'r1' });
    expect(dataEngine.getEntityCollection.mock.calls).toEqual([['p9', 'notes']]);
    expect(dataEngine.getVectorSetup).toHaveBeenCalledWith('p9', 'notes');
    expect(col.vectorSources).toHaveBeenCalledWith(expect.objectContaining({ ids: ['r1'] }));
  });

  it('empty source text removes the vector (empty marker), and is not embedded again', async () => {
    const records = { r1: rec({ other: 'x' }, { vector: { dims: 2, model: TAG, source: 'platform', hash: 'h', updatedAt: 't' } }) };
    const { svc, embed, col } = build({ records });
    expect(await svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).toBe('empty');
    expect(records.r1.vector).toBeNull();
    expect(records.r1.marker).toMatchObject({ kind: 'empty', model: TAG });
    expect(await svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).toBe('unchanged');
    expect(embed).not.toHaveBeenCalled();
    expect(col.setVectorMarker).toHaveBeenCalledTimes(1);
  });

  it('a provider failure is recorded on the record, not thrown', async () => {
    const embed = jest.fn().mockRejectedValue(new BadGatewayException('Could not reach the embedding provider (OpenAI).'));
    const records = { r1: rec({ title: 'a' }) };
    const { svc } = build({ records, embed });
    await expect(svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).resolves.toBe('failed');
    expect(records.r1.marker).toMatchObject({ kind: 'failed', model: TAG, error: expect.stringContaining('Could not reach') });
  });

  it('AI switched off or no key: failed, not thrown', async () => {
    const { svc } = build({ records: { r1: rec({ title: 'a' }) }, resolveError: new BadRequestException('no key') });
    await expect(svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).resolves.toBe('failed');
  });

  it('a record that changed while embedding is read again and written at its new version', async () => {
    const records = { r1: rec({ title: 'first' }) };
    const { svc, col } = build({ records });
    col.setVector.mockImplementationOnce(async (id: string) => {
      records.r1.version = 2;
      records.r1.data = { title: 'second' };
      throw new ConcurrencyError('docs', id, 1, 2);
    });
    expect(await svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).toBe('embedded');
    expect(records.r1.vector!.hash).toBe(sourceHash('second'));
  });

  it('waits (skipped) when the project switched models and no re-embed runs; follows a running re-embed', async () => {
    const records = { r1: rec({ title: 'a' }) };
    const a = build({ records, tag: 'cohere/embed-v4.0' });
    expect(await a.svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).toBe('skipped');
    expect(a.embed).not.toHaveBeenCalled();

    const running: VectorReembedState = {
      status: 'RUNNING', done: 0, total: 1, failed: 0, model: 'cohere/embed-v4.0', dimensions: 4,
      lastError: null, updatedAt: new Date().toISOString(),
    };
    const b = build({ records, tag: 'cohere/embed-v4.0', reembed: running });
    expect(await b.svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).toBe('embedded');
    expect(b.embed).toHaveBeenCalledWith(expect.anything(), ['a'], expect.objectContaining({ targetDimensions: 4 }));
  });

  it('does nothing for an entity no longer in platform mode', async () => {
    const { svc, embed } = build({ config: { mode: 'client', dimensions: 2, updatedAt: 't' } });
    expect(await svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).toBe('skipped');
    expect(embed).not.toHaveBeenCalled();
  });
});

describe('DataVectorEmbedderService.reembedEntity (worker)', () => {
  function many(n: number): Record<string, Rec> {
    const out: Record<string, Rec> = {};
    for (let i = 0; i < n; i++) out[`id-${String(i).padStart(4, '0')}`] = rec({ title: `t${i}` });
    return out;
  }

  it('pages 100 at a time, writes progress and completes', async () => {
    const records = many(250);
    const { svc, embed, states } = build({ records });
    const state = await svc.reembedEntity({ projectId: 'p1', entity: 'docs' });
    expect(state).toMatchObject({ status: 'COMPLETED', done: 250, total: 250, failed: 0, model: TAG, dimensions: 2 });
    expect(embed).toHaveBeenCalledTimes(3);
    expect((embed.mock.calls[0] as any[])[1]).toHaveLength(100);
    expect(states.map((s) => [s.status, s.done])).toEqual([
      ['RUNNING', 0],
      ['RUNNING', 100],
      ['RUNNING', 200],
      ['RUNNING', 250],
      ['COMPLETED', 250],
    ]);
    expect(Object.values(records).every((r) => r.vector?.source === 'platform')).toBe(true);
  });

  it('skips unchanged records without a provider call', async () => {
    const records = many(3);
    const { svc, embed } = build({ records });
    await svc.reembedEntity({ projectId: 'p1', entity: 'docs' });
    expect(embed).toHaveBeenCalledTimes(1);
    const again = await svc.reembedEntity({ projectId: 'p1', entity: 'docs' });
    expect(again).toMatchObject({ status: 'COMPLETED', done: 3, failed: 0 });
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('counts a failed page and goes on', async () => {
    const records = many(250);
    let call = 0;
    const embed = jest.fn(async (_p: unknown, texts: string[]) => {
      call++;
      if (call === 2) throw new BadRequestException('Embedding provider rejected the input: too long');
      return { vectors: texts.map(() => [1, 1]), tokenCount: 1, perItemTokens: 0, tag: TAG, nativeDimensions: 2 };
    });
    const { svc } = build({ records, embed });
    const state = await svc.reembedEntity({ projectId: 'p1', entity: 'docs' });
    // The rejected page is retried one record at a time; those that fail again are counted.
    expect(state.status).toBe('COMPLETED');
    expect(state.done).toBe(250);
    expect(state.failed).toBe(0);
  });

  it('a record the provider rejects is counted as failed and the run goes on', async () => {
    const records = many(250);
    const embed = jest.fn(async (_p: unknown, texts: string[]) => {
      if (texts.includes('t150')) throw new BadRequestException('Embedding provider rejected the input');
      return { vectors: texts.map(() => [1, 1]), tokenCount: 1, perItemTokens: 0, tag: TAG, nativeDimensions: 2 };
    });
    const { svc } = build({ records, embed });
    const state = await svc.reembedEntity({ projectId: 'p1', entity: 'docs' });
    expect(state).toMatchObject({ status: 'COMPLETED', done: 250, failed: 1 });
    expect(state.lastError).toContain('rejected the input');
    expect(records['id-0150'].marker).toMatchObject({ kind: 'failed' });
    expect(records['id-0249'].vector).not.toBeNull();
  });

  it('a provider failure storm stops the run as FAILED (no retry loop), with the error and no secrets', async () => {
    const records = many(250);
    const embed = jest.fn().mockRejectedValue(
      new HttpException('Embedding provider rate limit or quota exceeded. Retry later.', 429),
    );
    const { svc, current } = build({ records, embed });
    const state = await svc.reembedEntity({ projectId: 'p1', entity: 'docs' });
    expect(state).toMatchObject({ status: 'FAILED', done: 100, failed: 100 });
    expect(state.lastError).toContain('quota exceeded');
    expect(embed).toHaveBeenCalledTimes(1);
    expect(current().reembed!.status).toBe('FAILED');
    expect(safeError(new Error('Incorrect API key provided: sk-proj-abcdef123456'))).not.toContain('abcdef123456');
  });

  it('moves the entity to the new model when the project switched, and only at the end', async () => {
    const records = many(2);
    const { svc, dataEngine, current } = build({ records, tag: 'cohere/embed-v4.0', dimensions: 4 });
    const state = await svc.reembedEntity({ projectId: 'p1', entity: 'docs' });
    expect(state).toMatchObject({ status: 'COMPLETED', model: 'cohere/embed-v4.0', dimensions: 4 });
    expect(dataEngine.setVectorConfig).toHaveBeenCalledTimes(1);
    expect(current().config).toMatchObject({ modelTag: 'cohere/embed-v4.0', dimensions: 4, sourcePaths: CONFIG.sourcePaths });
  });

  it('never throws: a failure before the first page is a FAILED state', async () => {
    const { svc } = build({ records: many(1), resolveError: new BadRequestException('No OpenAI API key configured') });
    await expect(svc.reembedEntity({ projectId: 'p1', entity: 'docs' })).resolves.toMatchObject({
      status: 'FAILED',
      lastError: expect.stringContaining('No OpenAI API key'),
    });
  });
});

describe('DataVectorEmbedderService plan and budget refusals', () => {
  const planError = new HttpException(
    { statusCode: 403, code: 'EMBEDDING_PLAN_REQUIRED', message: "Computing embeddings with the platform's key is available on the Pro plan and above." },
    403,
  );

  it('a re-embed on a Free team stops before reading any page: FAILED naming the code, no provider call', async () => {
    const records = { a: rec({ title: 'x' }) };
    const { svc, embed, col } = build({ records, planError });
    const state = await svc.reembedEntity({ projectId: 'p1', entity: 'docs' });
    expect(state.status).toBe('FAILED');
    expect(state.lastError).toMatch(/^EMBEDDING_PLAN_REQUIRED: /);
    expect(embed).not.toHaveBeenCalled();
    expect(col.vectorSources).not.toHaveBeenCalled();
  });

  it('startReembed answers the 403 up front', async () => {
    const { svc, queue } = build({ planError });
    const err = await svc.startReembed('p1', 'docs').catch((e) => e);
    expect(err.getResponse().code).toBe('EMBEDDING_PLAN_REQUIRED');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('a daily-limit refusal mid-run stops the job and marks no record failed', async () => {
    const records: Record<string, Rec> = {};
    for (let i = 0; i < 150; i++) records[`id-${String(i).padStart(4, '0')}`] = rec({ title: `t${i}` });
    const embed = jest.fn().mockRejectedValue(
      new HttpException({ statusCode: 429, code: 'EMBEDDING_DAILY_LIMIT', message: 'No tokens are left for today.' }, 429),
    );
    const { svc } = build({ records, embed });
    const state = await svc.reembedEntity({ projectId: 'p1', entity: 'docs' });
    expect(state).toMatchObject({ status: 'FAILED', failed: 0 });
    expect(state.lastError).toMatch(/^EMBEDDING_DAILY_LIMIT: /);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(Object.values(records).every((r) => r.marker === null)).toBe(true);
  });

  it('an embed-record job refused by the plan leaves the record pending (no failed marker)', async () => {
    const records = { r1: rec({ title: 'a' }) };
    const embed = jest.fn().mockRejectedValue(planError);
    const { svc } = build({ records, embed });
    expect(await svc.embedRecord({ projectId: 'p1', entity: 'docs', id: 'r1' })).toBe('skipped');
    expect(records.r1.marker).toBeNull();
  });
});

describe('DataVectorEmbedderService.startReembed', () => {
  const at = (msAgo: number): VectorReembedState => ({
    status: 'RUNNING', done: 5, total: 10, failed: 0, model: TAG, dimensions: 2, lastError: null,
    updatedAt: new Date(Date.now() - msAgo).toISOString(),
  });

  it('queues the job and records QUEUED', async () => {
    const { svc, queue, current } = build({ records: { a: rec({ title: 'x' }) } });
    const out = await svc.startReembed('p1', 'docs');
    expect(out).toMatchObject({ queued: true, total: 1 });
    expect(queue.add).toHaveBeenCalledWith(REEMBED_ENTITY_JOB, { projectId: 'p1', entity: 'docs' }, expect.objectContaining({ attempts: 1 }));
    expect(current().reembed!.status).toBe('QUEUED');
  });

  it('409 while a run is alive; a RUNNING state older than 10 minutes is taken over', async () => {
    const live = build({ reembed: at(60_000) });
    const err = await live.svc.startReembed('p1', 'docs').catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse().code).toBe('VECTOR_REEMBED_RUNNING');

    const dead = build({ reembed: at(11 * 60_000) });
    await expect(dead.svc.startReembed('p1', 'docs')).resolves.toMatchObject({ queued: true });
  });

  it('409 for an entity not in platform mode', async () => {
    const { svc } = build({ config: { mode: 'client', dimensions: 2, updatedAt: 't' } });
    const err = await svc.startReembed('p1', 'docs').catch((e) => e);
    expect(err.getResponse().code).toBe('VECTOR_MODE_NOT_PLATFORM');
  });

  it('a queue outage leaves a FAILED state and answers 503', async () => {
    const { svc, queue, current } = build();
    queue.add.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const err = await svc.startReembed('p1', 'docs').catch((e) => e);
    expect(err.getStatus()).toBe(503);
    expect(current().reembed!.status).toBe('FAILED');
  });
});

describe('DataVectorProcessor', () => {
  it('dispatches by job name and ignores malformed jobs', async () => {
    const embedder = {
      embedRecord: jest.fn(async () => 'embedded'),
      reembedEntity: jest.fn(async () => ({ status: 'COMPLETED', done: 1, total: 1, failed: 0 })),
    };
    const p = new DataVectorProcessor(embedder as any);
    jest.spyOn((p as any).logger, 'log').mockImplementation(() => undefined);
    await p.process({ name: EMBED_RECORD_JOB, data: { projectId: 'p', entity: 'e', id: 'r' } } as any);
    await p.process({ name: REEMBED_ENTITY_JOB, data: { projectId: 'p', entity: 'e' } } as any);
    await p.process({ name: EMBED_RECORD_JOB, data: { projectId: 'p', entity: 'e' } } as any);
    await p.process({ name: 'other', data: { projectId: 'p', entity: 'e' } } as any);
    expect(embedder.embedRecord).toHaveBeenCalledTimes(1);
    expect(embedder.embedRecord).toHaveBeenCalledWith({ projectId: 'p', entity: 'e', id: 'r' });
    expect(embedder.reembedEntity).toHaveBeenCalledTimes(1);
  });
});
