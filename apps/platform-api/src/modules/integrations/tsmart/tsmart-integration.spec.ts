/**
 * tsmart.ai billing feed: GET /api/integrations/tsmart/projects.
 *
 *  - Guard: feature off → 404 whatever the request carries; missing, non-bearer,
 *    oversized or wrong token → 401 (one generic message); right token → allowed;
 *    the token never reaches a log line.
 *  - Mapping: BigInt → number, owner fallback to the team OWNER, missing usage →
 *    zeros/nulls, exact output key set, no secret field even when the row has one.
 *  - Service: selects no secret column, keeps DELETED/DEACTIVATED rows, caps at 5000.
 *  - HTTP: reachable without a JWT under the global /api prefix, the global
 *    throttler still applies, and "off" looks like a route that does not exist.
 *  - Usage tracking never counts the feed against a project.
 *
 * Tokens are random per run; nothing here is shaped like a real credential.
 */
import {
  ExecutionContext,
  Global,
  INestApplication,
  Logger,
  Module,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { createHash, randomBytes } from 'crypto';
import request from 'supertest';

import { PrismaService } from '../../../prisma/prisma.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ProxyThrottlerGuard } from '../../../common/guards/proxy-throttler.guard';
import { FrozenAccountInterceptor } from '../../../common/interceptors/frozen-account.interceptor';
import { UsageTrackingMiddleware } from '../../../common/middleware/usage-tracking.middleware';
import {
  TSMART_MAX_TOKEN_LENGTH,
  TSMART_TOKEN_HASH_ENV,
  TsmartIntegrationGuard,
  tsmartIntegrationState,
} from './tsmart-integration.guard';
import {
  TSMART_PROJECT_LIMIT,
  TsmartIntegrationService,
  TsmartProjectRow,
  toTsmartProject,
  tsmartProjectSelect,
} from './tsmart-integration.service';
import { TsmartIntegrationModule } from './tsmart-integration.module';

// ── helpers ──────────────────────────────────────────────────────────────────

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

const ROUTE = '/api/integrations/tsmart/projects';

function ctxFor(headers: Record<string, unknown>, method = 'GET', url = ROUTE): ExecutionContext {
  const req = { headers, method, originalUrl: url, url };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

const LOG_METHODS = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;

/** Silences Nest's Logger and records every argument it was given. */
function captureLogs() {
  const spies = LOG_METHODS.map((m) =>
    jest.spyOn(Logger.prototype as any, m).mockImplementation(() => undefined),
  );
  const staticSpies = LOG_METHODS.map((m) =>
    jest.spyOn(Logger as any, m).mockImplementation(() => undefined),
  );
  return {
    text: () =>
      [...spies, ...staticSpies]
        .flatMap((s) => s.mock.calls)
        .map((args) => args.map((a: unknown) => String(a)).join(' '))
        .join('\n'),
    restore: () => [...spies, ...staticSpies].forEach((s) => s.mockRestore()),
  };
}

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[TSMART_TOKEN_HASH_ENV];
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env[TSMART_TOKEN_HASH_ENV];
  else process.env[TSMART_TOKEN_HASH_ENV] = savedEnv;
  jest.restoreAllMocks();
});

// ── guard ────────────────────────────────────────────────────────────────────

describe('TsmartIntegrationGuard', () => {
  const guard = new TsmartIntegrationGuard();
  let logs: ReturnType<typeof captureLogs>;
  beforeEach(() => {
    logs = captureLogs();
  });
  afterEach(() => logs.restore());

  describe('feature off → 404 for every request', () => {
    const token = newToken();

    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['63 hex chars', sha256Hex(token).slice(0, 63)],
      ['65 hex chars', sha256Hex(token) + 'a'],
      ['non-hex', 'z'.repeat(64)],
      ['trailing newline', sha256Hex(token) + '\n'],
      ['surrounding spaces', ` ${sha256Hex(token)} `],
    ])('%s', (_label, value) => {
      if (value === undefined) delete process.env[TSMART_TOKEN_HASH_ENV];
      else process.env[TSMART_TOKEN_HASH_ENV] = value;

      expect(tsmartIntegrationState().enabled).toBe(false);
      // Even the right token, and even no token at all, gets the 404.
      for (const headers of [{ authorization: `Bearer ${token}` }, {}]) {
        let thrown: unknown;
        try {
          guard.canActivate(ctxFor(headers));
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(NotFoundException);
        // Same message Nest gives for an unknown route.
        expect((thrown as NotFoundException).message).toBe(`Cannot GET ${ROUTE}`);
      }
    });
  });

  describe('feature on', () => {
    const token = newToken();
    beforeEach(() => {
      process.env[TSMART_TOKEN_HASH_ENV] = sha256Hex(token);
    });

    const expect401 = (headers: Record<string, unknown>) => {
      let thrown: unknown;
      try {
        guard.canActivate(ctxFor(headers));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(UnauthorizedException);
      // One generic message for every failure: nothing says which check failed.
      expect((thrown as UnauthorizedException).getResponse()).toMatchObject({
        statusCode: 401,
        message: 'Unauthorized',
      });
    };

    it('allows the right token', () => {
      expect(guard.canActivate(ctxFor({ authorization: `Bearer ${token}` }))).toBe(true);
    });

    it('accepts the scheme case-insensitively and the hash in upper case', () => {
      process.env[TSMART_TOKEN_HASH_ENV] = sha256Hex(token).toUpperCase();
      expect(guard.canActivate(ctxFor({ authorization: `bearer ${token}` }))).toBe(true);
    });

    it('rejects a missing Authorization header', () => expect401({}));
    it('rejects an empty bearer', () => expect401({ authorization: 'Bearer ' }));
    it('rejects a non-bearer scheme', () => expect401({ authorization: `Basic ${token}` }));
    it('rejects the bare token without a scheme', () => expect401({ authorization: token }));
    it('rejects a non-string header', () => expect401({ authorization: [`Bearer ${token}`] }));
    it('rejects a wrong token', () => expect401({ authorization: `Bearer ${newToken()}` }));
    it('rejects the token with one character changed', () =>
      expect401({ authorization: `Bearer ${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}` }));
    it('rejects the hash itself presented as the token', () =>
      expect401({ authorization: `Bearer ${sha256Hex(token)}` }));

    it('rejects a token longer than 256 characters, even one whose hash matches', () => {
      const long = 'x'.repeat(TSMART_MAX_TOKEN_LENGTH + 1);
      process.env[TSMART_TOKEN_HASH_ENV] = sha256Hex(long);
      expect401({ authorization: `Bearer ${long}` });
      // 256 exactly is still accepted.
      const max = 'y'.repeat(TSMART_MAX_TOKEN_LENGTH);
      process.env[TSMART_TOKEN_HASH_ENV] = sha256Hex(max);
      expect(guard.canActivate(ctxFor({ authorization: `Bearer ${max}` }))).toBe(true);
    });

    it('rejects a huge header without hashing it', () => {
      const hash = jest.spyOn(require('crypto'), 'createHash');
      expect401({ authorization: `Bearer ${'a'.repeat(100_000)}` });
      expect(hash).not.toHaveBeenCalled();
      // Control: the spy does see the guard hash a normal-sized token.
      expect401({ authorization: `Bearer ${newToken()}` });
      expect(hash).toHaveBeenCalled();
    });

    it('never logs the token, right or wrong', () => {
      const wrong = newToken();
      guard.canActivate(ctxFor({ authorization: `Bearer ${token}` }));
      try {
        guard.canActivate(ctxFor({ authorization: `Bearer ${wrong}` }));
      } catch {
        /* expected */
      }
      const text = logs.text();
      // Control: the capture does see the guard's own log line.
      expect(text).toMatch(/wrong token/);
      expect(text).not.toContain(token);
      expect(text).not.toContain(wrong);
      expect(text).not.toContain(sha256Hex(token));
    });
  });
});

// ── mapping ──────────────────────────────────────────────────────────────────

const EXPECTED_KEYS = [
  'created_at',
  'database_type',
  'deactivated_at',
  'deleted_at',
  'id',
  'name',
  'owner_email',
  'status',
  'team',
  'usage',
];
const EXPECTED_TEAM_KEYS = ['id', 'name', 'slug'];
const EXPECTED_USAGE_KEYS = [
  'api_requests_month',
  'bandwidth_month',
  'db_size_bytes',
  'db_size_measured_at',
  'storage_bytes',
  'storage_measured_at',
];

const SECRETISH = /pass|secret|token|key|conn|dsn|jwt|encrypt|cred|anon|service|realm|db_user|db_host/i;

function allKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
    prefix + k,
    ...allKeys(v, `${prefix}${k}.`),
  ]);
}

function row(overrides: Partial<Record<string, unknown>> = {}): TsmartProjectRow {
  return {
    id: 'proj-1',
    name: 'Demo project',
    status: 'ACTIVE',
    databaseType: 'RELATIONAL',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    deletedAt: null,
    deactivatedAt: null,
    createdBy: 'user-1',
    team: {
      id: 'team-1',
      name: 'Demo team',
      slug: 'demo-team',
      members: [{ user: { email: 'owner@example.com' } }],
    },
    usage: {
      dbSizeBytes: BigInt(52_428_800),
      storageBytes: BigInt('6442450944'), // 6 GiB, above 2^32
      apiRequestsMonth: 1234,
      bandwidthMonth: BigInt('9007199254740'),
      dbSizeCalculatedAt: new Date('2026-10-14T06:00:00.000Z'),
      storageCalculatedAt: new Date('2026-10-14T00:00:00.000Z'),
    },
    ...overrides,
  } as unknown as TsmartProjectRow;
}

describe('toTsmartProject', () => {
  it('converts every BigInt to a number and every date to an ISO string', () => {
    const out = toTsmartProject(row(), 'creator@example.com');
    expect(out.usage).toEqual({
      db_size_bytes: 52_428_800,
      storage_bytes: 6_442_450_944,
      api_requests_month: 1234,
      bandwidth_month: 9_007_199_254_740,
      db_size_measured_at: '2026-10-14T06:00:00.000Z',
      storage_measured_at: '2026-10-14T00:00:00.000Z',
    });
    for (const v of Object.values(out.usage)) expect(typeof v).not.toBe('bigint');
    expect(out.created_at).toBe('2026-01-02T03:04:05.000Z');
    // Would throw on a BigInt.
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('prefers the creator, falls back to the team OWNER, else null', () => {
    expect(toTsmartProject(row(), 'creator@example.com').owner_email).toBe('creator@example.com');
    expect(toTsmartProject(row(), null).owner_email).toBe('owner@example.com');
    const noOwner = row({ team: { id: 't', name: 'n', slug: 's', members: [] } });
    expect(toTsmartProject(noOwner, null).owner_email).toBeNull();
  });

  it('reports zeros and nulls when the project has no usage row yet', () => {
    expect(toTsmartProject(row({ usage: null }), null).usage).toEqual({
      db_size_bytes: 0,
      storage_bytes: 0,
      api_requests_month: 0,
      bandwidth_month: 0,
      db_size_measured_at: null,
      storage_measured_at: null,
    });
  });

  it('keeps deleted and deactivated timestamps', () => {
    const out = toTsmartProject(
      row({
        status: 'DELETED',
        deletedAt: new Date('2026-10-13T10:00:00.000Z'),
        deactivatedAt: new Date('2026-10-01T10:00:00.000Z'),
      }),
      null,
    );
    expect(out.status).toBe('DELETED');
    expect(out.deleted_at).toBe('2026-10-13T10:00:00.000Z');
    expect(out.deactivated_at).toBe('2026-10-01T10:00:00.000Z');
  });

  it('emits exactly the documented keys, nothing secret even if the row carries it', () => {
    // A careless select would bring these along; the mapping must still drop them.
    const leaky = row({
      dbPassword: 'pw-should-not-leak',
      dbUser: 'u',
      dbHost: 'h',
      anonKey: 'anon-should-not-leak',
      serviceKey: 'svc-should-not-leak',
      keycloakRealm: 'realm',
      githubToken: 'gh-should-not-leak',
      vercelToken: 'vc-should-not-leak',
      embeddingApiKey: 'emb-should-not-leak',
    });
    const out = toTsmartProject(leaky, null);

    expect(Object.keys(out).sort()).toEqual(EXPECTED_KEYS);
    expect(Object.keys(out.team).sort()).toEqual(EXPECTED_TEAM_KEYS);
    expect(Object.keys(out.usage).sort()).toEqual(EXPECTED_USAGE_KEYS);
    expect(allKeys(out).filter((k) => SECRETISH.test(k))).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/should-not-leak/);
  });
});

// ── service ──────────────────────────────────────────────────────────────────

function prismaWith(rows: TsmartProjectRow[], users: Array<{ id: string; email: string }> = []) {
  return {
    project: { findMany: jest.fn().mockResolvedValue(rows) },
    user: { findMany: jest.fn().mockResolvedValue(users) },
  } as any;
}

describe('TsmartIntegrationService.listProjects', () => {
  it('selects no secret column', () => {
    const selected = allKeys(tsmartProjectSelect);
    const forbidden = [
      'dbPassword',
      'dbUser',
      'dbHost',
      'dbPort',
      'dbName',
      'anonKey',
      'serviceKey',
      'keycloakRealm',
      'githubToken',
      'vercelToken',
      'embeddingApiKey',
      'githubOAuthToken',
      'vercelOAuthToken',
      'supabaseImportLog',
      'modules',
    ];
    for (const f of forbidden) {
      expect(selected.some((k) => k === f || k.endsWith(`.${f}`))).toBe(false);
    }
  });

  it('reads every project (no status filter), oldest first, one past the cap', async () => {
    const prisma = prismaWith([]);
    await new TsmartIntegrationService(prisma).listProjects();
    const args = prisma.project.findMany.mock.calls[0][0];
    expect(args.where).toBeUndefined();
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(args.take).toBe(TSMART_PROJECT_LIMIT + 1);
    // No creators to look up → no user query.
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('resolves creators in one query and falls back to the team OWNER', async () => {
    const rows = [
      row({ id: 'a', createdBy: 'user-1' }),
      row({ id: 'b', createdBy: 'user-1' }),
      row({ id: 'c', createdBy: 'gone-user' }), // creator deleted → OWNER
      row({ id: 'd', createdBy: null }), // no creator → OWNER
      row({ id: 'e', createdBy: null, team: { id: 't', name: 'n', slug: 's', members: [] } }),
    ];
    const prisma = prismaWith(rows, [{ id: 'user-1', email: 'creator@example.com' }]);
    const now = new Date('2026-10-14T12:00:00.000Z');
    const out = await new TsmartIntegrationService(prisma).listProjects(now);

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ['user-1', 'gone-user'] } },
      select: { id: true, email: true },
    });
    expect(out.object).toBe('list');
    expect(out.generated_at).toBe('2026-10-14T12:00:00.000Z');
    expect(Object.keys(out).sort()).toEqual(['data', 'generated_at', 'has_more', 'object']);
    expect(out.has_more).toBe(false);
    expect(out.data.map((p) => [p.id, p.owner_email])).toEqual([
      ['a', 'creator@example.com'],
      ['b', 'creator@example.com'],
      ['c', 'owner@example.com'],
      ['d', 'owner@example.com'],
      ['e', null],
    ]);
  });

  it('caps the list at 5000 rows and logs that it did', async () => {
    const logs = captureLogs();
    const many = Array.from({ length: TSMART_PROJECT_LIMIT + 1 }, (_, i) =>
      row({ id: `p${i}`, createdBy: null }),
    );
    const out = await new TsmartIntegrationService(prismaWith(many)).listProjects();
    expect(out.data).toHaveLength(TSMART_PROJECT_LIMIT);
    expect(out.data[TSMART_PROJECT_LIMIT - 1].id).toBe(`p${TSMART_PROJECT_LIMIT - 1}`);
    expect(logs.text()).toMatch(/cap of 5000/);
    logs.restore();
  });
});

// ── HTTP ─────────────────────────────────────────────────────────────────────

describe('GET /api/integrations/tsmart/projects (HTTP)', () => {
  const token = newToken();
  let app: INestApplication;
  let prisma: any;
  let logs: ReturnType<typeof captureLogs>;

  async function boot(throttleLimit = 100) {
    prisma = prismaWith([row()], [{ id: 'user-1', email: 'creator@example.com' }]);

    @Global()
    @Module({ providers: [{ provide: PrismaService, useValue: prisma }], exports: [PrismaService] })
    class FakePrismaModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        FakePrismaModule,
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: throttleLimit }]),
        TsmartIntegrationModule,
      ],
      // The two guards the real app registers globally.
      providers: [
        { provide: APP_GUARD, useClass: ProxyThrottlerGuard },
        { provide: APP_INTERCEPTOR, useClass: FrozenAccountInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  }

  beforeEach(() => {
    logs = captureLogs();
  });
  afterEach(async () => {
    await app?.close();
    logs.restore();
  });

  it('answers the right token without any JWT', async () => {
    process.env[TSMART_TOKEN_HASH_ENV] = sha256Hex(token);
    await boot();
    const res = await request(app.getHttpServer())
      .get(ROUTE)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.object).toBe('list');
    expect(res.body.data).toHaveLength(1);
    expect(Object.keys(res.body.data[0]).sort()).toEqual(EXPECTED_KEYS);
    expect(res.body.data[0].usage.storage_bytes).toBe(6_442_450_944);
    expect(res.body.data[0].owner_email).toBe('creator@example.com');
    expect(logs.text()).not.toContain(token);
  });

  it('refuses a wrong or missing token with 401', async () => {
    process.env[TSMART_TOKEN_HASH_ENV] = sha256Hex(token);
    await boot();
    const server = app.getHttpServer();
    const wrong = await request(server).get(ROUTE).set('Authorization', `Bearer ${newToken()}`).expect(401);
    const missing = await request(server).get(ROUTE).expect(401);
    expect(wrong.body.message).toBe('Unauthorized');
    expect(missing.body.message).toBe('Unauthorized');
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  // Express matches routes case-insensitively: another spelling of the path
  // reaches the same handler, so it must meet the same guard.
  it('guards a differently-cased spelling of the path the same way', async () => {
    process.env[TSMART_TOKEN_HASH_ENV] = sha256Hex(token);
    await boot();
    const server = app.getHttpServer();
    const upper = ROUTE.toUpperCase();
    await request(server).get(upper).expect(401);
    await request(server).get(upper).set('Authorization', `Bearer ${newToken()}`).expect(401);
    await request(server).get(upper).set('Authorization', `Bearer ${token}`).expect(200);
  });

  it('looks like a missing route when the feature is off', async () => {
    delete process.env[TSMART_TOKEN_HASH_ENV];
    await boot();
    const server = app.getHttpServer();
    const off = await request(server).get(ROUTE).set('Authorization', `Bearer ${token}`).expect(404);
    const unknown = await request(server).get('/api/integrations/tsmart/nothing-here').expect(404);

    expect(off.body.message).toBe(`Cannot GET ${ROUTE}`);
    expect(unknown.body.message).toBe('Cannot GET /api/integrations/tsmart/nothing-here');
    expect(Object.keys(off.body).sort()).toEqual(Object.keys(unknown.body).sort());
    expect(prisma.project.findMany).not.toHaveBeenCalled();
  });

  it('is still rate limited by the global throttler', async () => {
    process.env[TSMART_TOKEN_HASH_ENV] = sha256Hex(token);
    await boot(2);
    const server = app.getHttpServer();
    await request(server).get(ROUTE).set('Authorization', `Bearer ${token}`).expect(200);
    await request(server).get(ROUTE).set('Authorization', `Bearer ${newToken()}`).expect(401);
    await request(server).get(ROUTE).set('Authorization', `Bearer ${token}`).expect(429);
  });
});

// ── usage tracking ───────────────────────────────────────────────────────────

describe('UsageTrackingMiddleware and the tsmart feed', () => {
  function middleware() {
    const prisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1' }),
      },
    } as any;
    const usage = {
      trackApiRequest: jest.fn().mockResolvedValue(undefined),
      trackBandwidth: jest.fn().mockResolvedValue(undefined),
    } as any;
    const mw = new UsageTrackingMiddleware(prisma, usage);
    clearInterval((mw as any).evictionTimer);
    return { mw, prisma, usage };
  }

  const reqFor = (url: string) =>
    ({ originalUrl: url, url, headers: { 'x-project-id': 'p1', apikey: 'k' } }) as any;

  it.each([ROUTE, `${ROUTE}?x=1`, '/api/Integrations/TSMART/projects'])(
    'does not count %s against a project, whatever headers it carries',
    async (url) => {
      const { mw, prisma, usage } = middleware();
      const next = jest.fn();
      await mw.use(reqFor(url), {} as any, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(prisma.project.findUnique).not.toHaveBeenCalled();
      expect(prisma.project.findFirst).not.toHaveBeenCalled();
      expect(usage.trackApiRequest).not.toHaveBeenCalled();
    },
  );

  it('still counts other API paths that name a project (control)', async () => {
    const { mw, usage } = middleware();
    const res = { write: jest.fn(), end: jest.fn() } as any;
    await mw.use(reqFor('/api/rest/v1/items'), res, jest.fn());
    expect(usage.trackApiRequest).toHaveBeenCalledWith('t1', 'p1');
  });
});
