jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { HttpException } from '@nestjs/common';
import {
  EmbeddingBudgetService,
  nextUtcMidnight,
  projectUsageKey,
} from './embedding-budget.service';
import { ProjectEmbeddingService } from './project-embedding.service';
import { embeddingPlanRequiredError } from '../entitlement/entitlement.service';

function redisMock(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial };
  return {
    store,
    get: jest.fn(async (k: string) => store[k] ?? null),
    incrby: jest.fn(async (k: string, n: number) => {
      store[k] = String(parseInt(store[k] ?? '0', 10) + n);
      return parseInt(store[k], 10);
    }),
    expire: jest.fn(async () => undefined),
  };
}

function budget(redis: any, limit: number | undefined = 1000) {
  const config = { get: (k: string) => (k === 'embedding.projectMaxDailyTokens' ? limit : undefined) };
  const svc = new EmbeddingBudgetService(config as any, redis);
  const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
  return { svc, warn };
}

const caught = async (p: Promise<unknown>) => p.then(() => undefined, (e) => e);

describe('EmbeddingBudgetService', () => {
  it('keys the counter per project and UTC day', () => {
    expect(projectUsageKey('p1', new Date('2026-11-28T23:59:59Z'))).toBe('emb:usage:project:p1:2026-11-28');
    expect(nextUtcMidnight(new Date('2026-11-28T10:00:00Z')).toISOString()).toBe('2026-11-29T00:00:00.000Z');
  });

  it('limits a project on the platform key: 429 EMBEDDING_DAILY_LIMIT with limit, remaining and reset time', async () => {
    const redis = redisMock({ [projectUsageKey('p1')]: '1000' });
    const { svc } = budget(redis, 1000);
    const err = await caught(svc.assertWithinBudget('p1', 'platform'));
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    const body = (err as HttpException).getResponse() as any;
    expect(body).toMatchObject({ statusCode: 429, code: 'EMBEDDING_DAILY_LIMIT', limit: 1000, used: 1000, remaining: 0 });
    expect(body.resetsAt).toBe(nextUtcMidnight().toISOString());
    expect(body.message).toContain('1,000');
    expect(body.message).toContain(body.resetsAt);
    expect(body.message).toMatch(/own provider key/);
  });

  it('refuses a request whose estimate would go past what is left, and says how much is left', async () => {
    const redis = redisMock({ [projectUsageKey('p1')]: '900' });
    const { svc } = budget(redis, 1000);
    await expect(svc.assertWithinBudget('p1', 'platform', 100)).resolves.toBeUndefined();
    const err = await caught(svc.assertWithinBudget('p1', 'platform', 101));
    const body = (err as HttpException).getResponse() as any;
    expect(body).toMatchObject({ code: 'EMBEDDING_DAILY_LIMIT', remaining: 100 });
    expect(body.message).toContain('100 are left');
  });

  it('never limits a project on its own key (and does not count it)', async () => {
    const redis = redisMock({ [projectUsageKey('p1')]: '999999' });
    const { svc } = budget(redis, 1000);
    await expect(svc.assertWithinBudget('p1', 'project', 10_000)).resolves.toBeUndefined();
    await expect(svc.assertWithinBudget('p1', 'none')).resolves.toBeUndefined();
    await svc.record('p1', 50, 'project');
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.incrby).not.toHaveBeenCalled();
  });

  it('0 or a negative limit means unlimited', async () => {
    for (const limit of [0, -1]) {
      const redis = redisMock({ [projectUsageKey('p1')]: '5000000' });
      const { svc } = budget(redis, limit);
      expect(svc.limit()).toBeNull();
      await expect(svc.assertWithinBudget('p1', 'platform', 1000)).resolves.toBeUndefined();
    }
  });

  it('defaults to 1 000 000 tokens when the setting is absent', () => {
    const svc = new EmbeddingBudgetService({ get: () => undefined } as any, redisMock() as any);
    expect(svc.limit()).toBe(1_000_000);
  });

  it('fails open with one warning when Redis is unreachable', async () => {
    const redis = {
      get: jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      incrby: jest.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      expire: jest.fn(async () => undefined),
    };
    const { svc, warn } = budget(redis, 1);
    await expect(svc.assertWithinBudget('p1', 'platform', 1_000_000)).resolves.toBeUndefined();
    await expect(svc.assertWithinBudget('p1', 'platform', 1_000_000)).resolves.toBeUndefined();
    await expect(svc.record('p1', 10)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('fails open when Redis hangs (no answer within the timeout)', async () => {
    const redis = { get: jest.fn(() => new Promise<string>(() => undefined)), incrby: jest.fn(), expire: jest.fn() };
    const { svc } = budget(redis, 1);
    const started = Date.now();
    await expect(svc.assertWithinBudget('p1', 'platform', 10)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('record adds the token count to today\'s counter with a ~48 h expiry', async () => {
    const redis = redisMock();
    const { svc } = budget(redis);
    await svc.record('p1', 120);
    await svc.record('p1', 30);
    expect(redis.store[projectUsageKey('p1')]).toBe('150');
    expect(redis.expire).toHaveBeenCalledWith(projectUsageKey('p1'), 172_800);
  });
});

describe('ProjectEmbeddingService.embedForProject', () => {
  function build(keySource: 'platform' | 'project', tokenCount: number | null, used = 0, limit = 1000, planAllowed = true) {
    const redis = redisMock({ [projectUsageKey('p1')]: String(used) });
    const { svc: budgetSvc } = budget(redis, limit);
    const resolved = { tag: 'openai/m', keySource, config: { provider: 'openai' } } as any;
    const providers = {
      forProject: jest.fn(() => resolved),
      embed: jest.fn(async (_r: unknown, texts: string[]) => ({
        vectors: texts.map(() => [1, 0]),
        tokenCount,
        model: 'm',
        dimensions: 2,
        nativeDimensions: 2,
        usedFallback: false,
        padded: false,
        tag: 'openai/m',
      })),
    };
    const entitlements = {
      assertTeamCanUsePlatformEmbeddings: jest.fn(async () => {
        if (!planAllowed) throw embeddingPlanRequiredError();
      }),
      teamCanUsePlatformEmbeddings: jest.fn(async () => planAllowed),
    };
    const svc = new ProjectEmbeddingService(providers as any, budgetSvc, {} as any, entitlements as any);
    jest.spyOn((svc as any).logger, 'error').mockImplementation(() => undefined);
    return { svc, providers, redis, entitlements };
  }

  it('a Free team on the platform key gets 403 EMBEDDING_PLAN_REQUIRED before the budget or the provider', async () => {
    const { svc, providers, redis, entitlements } = build('platform', 10, 0, 1000, false);
    const err: any = await caught(svc.embedForProject({ id: 'p1', teamId: 't1' }, ['a'], { intent: 'document' }));
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse().code).toBe('EMBEDDING_PLAN_REQUIRED');
    expect(entitlements.assertTeamCanUsePlatformEmbeddings).toHaveBeenCalledWith('t1');
    expect(redis.get).not.toHaveBeenCalled();
    expect(providers.embed).not.toHaveBeenCalled();
  });

  it('a Free team on its own key is neither gated nor limited', async () => {
    const { svc, providers, entitlements } = build('project', 10, 5000, 1000, false);
    await svc.embedForProject({ id: 'p1', teamId: 't1' }, ['a'], { intent: 'document' });
    expect(providers.embed).toHaveBeenCalled();
    expect(entitlements.assertTeamCanUsePlatformEmbeddings).not.toHaveBeenCalled();
  });

  it('platformKeyUsage reports plan, limit, used and reset time on the platform key only', async () => {
    const a = build('platform', 10, 300, 1000, false);
    (a.providers as any).describeProject = () => ({ keySource: 'platform', endpointIsPlatformHost: true });
    expect(await a.svc.platformKeyUsage({ id: 'p1', teamId: 't1' })).toEqual({
      platformKey: true, platformKeyAllowed: false, limit: 1000, used: 300, resetsAt: nextUtcMidnight().toISOString(),
    });
    const b = build('project', 10);
    (b.providers as any).describeProject = () => ({ keySource: 'project', endpointIsPlatformHost: true });
    expect(await b.svc.platformKeyUsage({ id: 'p1', teamId: 't1' })).toMatchObject({ platformKey: false, platformKeyAllowed: true, limit: null });
  });

  it('counts the provider token count against the project on the platform key', async () => {
    const { svc, redis } = build('platform', 42);
    const out = await svc.embedForProject({ id: 'p1', teamId: 't1' }, ['a', 'b'], { intent: 'document' });
    expect(out.vectors).toHaveLength(2);
    expect(out.perItemTokens).toBe(21);
    expect(redis.store[projectUsageKey('p1')]).toBe('42');
  });

  it('does not call the provider once the platform-key budget is used up', async () => {
    const { svc, providers } = build('platform', 10, 1000, 1000);
    const err = await caught(svc.embedForProject({ id: 'p1', teamId: 't1' }, ['a'], { intent: 'query' }));
    expect((err as HttpException).getStatus()).toBe(429);
    expect(providers.embed).not.toHaveBeenCalled();
  });

  it('a project on its own key embeds past the limit and is not counted', async () => {
    const { svc, providers, redis } = build('project', 10, 1000, 1000);
    await svc.embedForProject({ id: 'p1', teamId: 't1' }, ['a'], { intent: 'query' });
    expect(providers.embed).toHaveBeenCalled();
    expect(redis.store[projectUsageKey('p1')]).toBe('1000');
  });

  it('estimates the tokens when the provider reports none', async () => {
    const { svc, redis } = build('platform', null);
    await svc.embedForProject({ id: 'p1', teamId: 't1' }, ['abcdefgh'], { intent: 'document' });
    expect(redis.store[projectUsageKey('p1')]).toBe('2');
  });
});
