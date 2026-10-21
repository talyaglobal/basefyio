jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('./storage.service', () => ({ StorageService: class {} }));
jest.mock('./image-transform.service', () => ({ ImageTransformService: class {} }));
jest.mock('./storage-access.service', () => ({ StorageAccessService: class {} }));
jest.mock('../projects/project-activity.service', () => ({
  ProjectActivityService: class {},
  ProjectActivityKind: {
    STORAGE_OBJECT_UPLOADED: 'storage.object_uploaded',
    STORAGE_BUCKET_CREATED: 'storage.bucket_created',
    STORAGE_BUCKET_UPDATED: 'storage.bucket_updated',
    STORAGE_BUCKET_DELETED: 'storage.bucket_deleted',
    STORAGE_OBJECT_DELETED: 'storage.object_deleted',
  },
}));
jest.mock('../../common/guards/jwt-or-apikey.guard', () => ({ JwtOrApiKeyGuard: class JwtOrApiKeyGuard {} }));

import 'reflect-metadata';
import { BadRequestException, ForbiddenException, Logger, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { API_KEY_SCOPE_KEY } from '../../common/decorators/api-key-scope.decorator';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { StorageController } from './storage.controller';

/**
 * Who may reach which storage route, read from what Nest itself reads.
 *
 * api-key-scope.contract.spec.ts checks the decorators as source text; this
 * checks the metadata they leave behind and then runs the real ApiKeyGuard
 * against the real handlers, so a decorator that is present but ineffective
 * (wrong key, wrong target) fails here. The handler cases at the bottom cover
 * the routes the rule-focused storage.controller.spec.ts does not.
 */

type Handler = keyof StorageController;
const proto = StorageController.prototype as unknown as Record<string, unknown>;

/** Every method Nest routes to: it carries a path. */
const routeHandlers = (): string[] =>
  Object.getOwnPropertyNames(StorageController.prototype).filter(
    (name) => name !== 'constructor' && Reflect.getMetadata(PATH_METADATA, proto[name] as object) !== undefined,
  );

const handlerScope = (name: string) => Reflect.getMetadata(API_KEY_SCOPE_KEY, proto[name] as object);
const effectiveScope = (name: string) =>
  new Reflector().getAllAndOverride(API_KEY_SCOPE_KEY, [proto[name] as () => unknown, StorageController]);

describe('StorageController — declared key scope', () => {
  it('defaults the whole controller to the service key', () => {
    expect(Reflect.getMetadata(API_KEY_SCOPE_KEY, StorageController)).toBe('service');
  });

  it('sits behind JwtOrApiKeyGuard', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, StorageController)).toEqual([JwtOrApiKeyGuard]);
  });

  it('tripwire: exactly these routes are open to the public anon key', () => {
    // A new public route fails here until it is named. An <img src> cannot send
    // headers, so these three are the only ones a browser needs without a user.
    const open = routeHandlers().filter((h) => effectiveScope(h) === 'anon').sort();
    expect(open).toEqual(['downloadObject', 'getPublicUrl', 'renderObject']);
  });

  it('these routes need a signed-in end user (or the service key)', () => {
    const authenticated = routeHandlers().filter((h) => effectiveScope(h) === 'authenticated').sort();
    expect(authenticated).toEqual(
      [
        'createFolder',
        'deleteObjects',
        'findExisting',
        'getPresignedUrl',
        'listBuckets',
        'listObjects',
        'moveObjects',
        'uploadObject',
      ].sort(),
    );
  });

  it('bucket administration declares nothing of its own and inherits the service-key default', () => {
    for (const h of ['createBucket', 'deleteBucket', 'updateBucket']) {
      expect(handlerScope(h)).toBeUndefined();
      expect(effectiveScope(h)).toBe('service');
    }
  });

  it('every route resolves to some scope — none is left to the guard\'s permissive "unmarked" path', () => {
    const handlers = routeHandlers();
    expect(handlers.length).toBeGreaterThanOrEqual(14);
    for (const h of handlers) {
      expect([h, effectiveScope(h)]).toEqual([h, expect.stringMatching(/^(service|authenticated|anon)$/)]);
    }
  });
});

describe('StorageController — the real ApiKeyGuard against the real handlers', () => {
  const PROJECT = { id: 'p1', anonKey: 'anon-key', serviceKey: 'svc-key', keycloakRealm: 'realm-p1' };

  let warn: jest.SpyInstance;
  beforeAll(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });
  beforeEach(() => warn.mockClear());

  function run(
    handler: Handler,
    opts: {
      apikey?: string;
      queryKey?: string;
      bearer?: string;
      projectId?: string;
      cfg?: Record<string, string>;
      claims?: Record<string, unknown> | null;
    },
  ) {
    const prisma = { project: { findFirst: jest.fn().mockResolvedValue(PROJECT) } };
    const config = { get: (k: string) => opts.cfg?.[k] };
    const guard = new ApiKeyGuard(prisma as any, config as any, new Reflector());
    if (opts.claims !== undefined) jest.spyOn(guard as any, 'verifyProjectJwt').mockResolvedValue(opts.claims);
    const headers: Record<string, string> = {};
    if (opts.apikey) headers.apikey = opts.apikey;
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    const req: any = {
      headers,
      params: { projectId: opts.projectId ?? 'p1' },
      query: opts.queryKey ? { apikey: opts.queryKey } : {},
      method: 'GET',
      url: `/api/projects/${opts.projectId ?? 'p1'}/storage/x`,
    };
    const ctx: any = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => proto[handler],
      getClass: () => StorageController,
    };
    return { result: guard.canActivate(ctx), req };
  }

  it('admits the anon key to the download route', async () => {
    const { result, req } = run('downloadObject', { apikey: 'anon-key' });
    await expect(result).resolves.toBe(true);
    expect(req.apiKeyPayload).toMatchObject({ role: 'anon', dbRole: 'anon' });
  });

  it('admits the anon key to the public-URL and render routes', async () => {
    await expect(run('getPublicUrl', { apikey: 'anon-key' }).result).resolves.toBe(true);
    await expect(run('renderObject', { apikey: 'anon-key' }).result).resolves.toBe(true);
  });

  it('refuses the anon key on bucket creation, naming the service key', async () => {
    await expect(run('createBucket', { apikey: 'anon-key' }).result).rejects.toThrow(/requires the service key/);
  });

  it('refuses the anon key on bucket deletion and visibility changes', async () => {
    await expect(run('deleteBucket', { apikey: 'anon-key' }).result).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run('updateBucket', { apikey: 'anon-key' }).result).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a bare anon key on object listing, asking for a signed-in user', async () => {
    await expect(run('listObjects', { apikey: 'anon-key' }).result).rejects.toThrow(/requires a signed-in user/);
  });

  it('refuses a bare anon key on uploads and signed URLs', async () => {
    await expect(run('uploadObject', { apikey: 'anon-key' }).result).rejects.toBeInstanceOf(ForbiddenException);
    await expect(run('getPresignedUrl', { apikey: 'anon-key' }).result).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('admits the service key everywhere, bucket administration included', async () => {
    for (const h of ['createBucket', 'deleteBucket', 'updateBucket', 'listObjects', 'uploadObject'] as Handler[]) {
      await expect(run(h, { apikey: 'svc-key' }).result).resolves.toBe(true);
    }
  });

  it('admits the anon key with a verified end-user token to object routes, as authenticated', async () => {
    const { result, req } = run('listObjects', { apikey: 'anon-key', bearer: 'user.jwt.token', claims: { sub: 'u1' } });
    await expect(result).resolves.toBe(true);
    expect(req.apiKeyPayload).toMatchObject({ dbRole: 'authenticated', jwtClaims: { sub: 'u1' } });
  });

  it('a signed-in end user still cannot create buckets', async () => {
    await expect(
      run('createBucket', { apikey: 'anon-key', bearer: 'user.jwt.token', claims: { sub: 'u1' } }).result,
    ).rejects.toThrow(/requires the service key/);
  });

  it('ANON_WRITE_BINDING=log lets a bare anon key through on an authenticated route, with a warning', async () => {
    const { result } = run('listObjects', { apikey: 'anon-key', cfg: { ANON_WRITE_BINDING: 'log' } });
    await expect(result).resolves.toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ANON_WRITE_BINDING=log'));
    // It never opens a service-key route.
    await expect(
      run('createBucket', { apikey: 'anon-key', cfg: { ANON_WRITE_BINDING: 'log' } }).result,
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a key aimed at another project\'s storage, even on a public route', async () => {
    await expect(run('downloadObject', { apikey: 'anon-key', projectId: 'p2' }).result).rejects.toThrow(
      /does not belong to the requested project/,
    );
    await expect(run('createBucket', { apikey: 'svc-key', projectId: 'p2' }).result).rejects.toThrow(
      /does not belong to the requested project/,
    );
  });

  it('refuses the service key from the query string', async () => {
    await expect(run('downloadObject', { queryKey: 'svc-key' }).result).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('StorageController — handler behaviour', () => {
  function deps() {
    const storage = {
      listBuckets: jest.fn().mockResolvedValue([]),
      createBucket: jest.fn().mockResolvedValue({ id: 'bf-acme-docs', name: 'docs' }),
      deleteBucket: jest.fn().mockResolvedValue({ message: 'deleted' }),
      toggleBucketPublic: jest.fn().mockImplementation(async (_p, _u, _b, pub: boolean) => ({ public: pub })),
      getPublicUrl: jest.fn().mockResolvedValue({ public: false, url: null }),
      createFolder: jest.fn().mockResolvedValue({ name: 'docs/2026/' }),
      findExistingObjects: jest.fn().mockResolvedValue(['a.txt']),
      moveObjects: jest.fn().mockResolvedValue({ moved: 2 }),
      getPresignedUrl: jest.fn().mockResolvedValue({ url: 'signed', expiresIn: 3600 }),
      deleteObjects: jest.fn().mockResolvedValue({ message: 'Deleted 1 object(s)' }),
      resolveBucket: jest.fn(),
      statObjectIn: jest.fn(),
    };
    const activity = { append: jest.fn().mockResolvedValue(undefined) };
    const access = {
      resolveMode: jest.fn().mockResolvedValue(null),
      assertCanRead: jest.fn(),
      assertCanModifyAll: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new StorageController(storage as any, activity as any, {} as any, access as any);
    return { storage, activity, access, controller };
  }

  const user = { sub: 'u1' } as any;
  const serviceReq = { apiKeyPayload: { projectId: 'p1', role: 'service', dbRole: 'service_role' } } as any;

  it('listBuckets passes the dashboard user, and nobody for a key caller', async () => {
    const { storage, controller } = deps();
    await controller.listBuckets('p1', user);
    await controller.listBuckets('p1', undefined);
    expect(storage.listBuckets.mock.calls).toEqual([
      ['p1', 'u1'],
      ['p1', undefined],
    ]);
  });

  it('createBucket forwards name and visibility and records which it was', async () => {
    const { storage, activity, controller } = deps();
    await controller.createBucket('p1', { name: 'docs', public: true }, user);
    await controller.createBucket('p1', { name: 'raw' }, undefined);
    expect(storage.createBucket.mock.calls).toEqual([
      ['p1', 'u1', 'docs', true],
      ['p1', undefined, 'raw', undefined],
    ]);
    expect(activity.append.mock.calls.map(([, a]) => [a.kind, a.title, a.detail, a.userId])).toEqual([
      ['storage.bucket_created', 'Storage bucket created: docs', 'Public bucket', 'u1'],
      ['storage.bucket_created', 'Storage bucket created: raw', 'Private bucket', undefined],
    ]);
  });

  it('createBucket records nothing when the service refuses', async () => {
    const { storage, activity, controller } = deps();
    storage.createBucket.mockRejectedValue(new BadRequestException('bad name'));
    await expect(controller.createBucket('p1', { name: '-x' }, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(activity.append).not.toHaveBeenCalled();
  });

  it('deleteBucket records the deletion', async () => {
    const { storage, activity, controller } = deps();
    await expect(controller.deleteBucket('p1', 'docs', user)).resolves.toEqual({ message: 'deleted' });
    expect(storage.deleteBucket).toHaveBeenCalledWith('p1', 'u1', 'docs');
    expect(activity.append).toHaveBeenCalledWith('p1', {
      userId: 'u1',
      kind: 'storage.bucket_deleted',
      title: 'Storage bucket deleted: docs',
    });
  });

  it('updateBucket toggles visibility and records the direction', async () => {
    const { storage, activity, controller } = deps();
    await expect(controller.updateBucket('p1', 'docs', { public: true }, user)).resolves.toEqual({ public: true });
    await controller.updateBucket('p1', 'docs', { public: false }, user);
    expect(storage.toggleBucketPublic.mock.calls).toEqual([
      ['p1', 'u1', 'docs', true],
      ['p1', 'u1', 'docs', false],
    ]);
    expect(activity.append.mock.calls.map(([, a]) => [a.kind, a.detail])).toEqual([
      ['storage.bucket_updated', 'Set public'],
      ['storage.bucket_updated', 'Set private'],
    ]);
  });

  it('getPublicUrl asks for the bucket root when no path is given', async () => {
    const { storage, controller } = deps();
    await controller.getPublicUrl('p1', 'docs', undefined as unknown as string, undefined);
    await controller.getPublicUrl('p1', 'docs', 'img/a.png', undefined);
    expect(storage.getPublicUrl.mock.calls).toEqual([
      ['p1', undefined, 'docs', ''],
      ['p1', undefined, 'docs', 'img/a.png'],
    ]);
  });

  it('createFolder records the marker the service created', async () => {
    const { storage, activity, controller } = deps();
    await expect(controller.createFolder('p1', 'docs', { path: 'docs/2026' }, user)).resolves.toEqual({
      name: 'docs/2026/',
    });
    expect(storage.createFolder).toHaveBeenCalledWith('p1', 'u1', 'docs', 'docs/2026');
    expect(activity.append.mock.calls[0][1]).toMatchObject({
      kind: 'storage.object_uploaded',
      title: 'Storage folder created: docs',
      detail: 'docs/2026/',
    });
  });

  it('findExisting wraps the result and tolerates a body without paths', async () => {
    const { storage, controller } = deps();
    await expect(controller.findExisting('p1', 'docs', {} as any, user)).resolves.toEqual({ existing: ['a.txt'] });
    expect(storage.findExistingObjects).toHaveBeenCalledWith('p1', 'u1', 'docs', []);
  });

  it('moveObjects defaults to no sources and the bucket root, and records the count', async () => {
    const { storage, activity, controller } = deps();
    await controller.moveObjects('p1', 'docs', {} as any, serviceReq, undefined);
    expect(storage.moveObjects).toHaveBeenCalledWith('p1', undefined, 'docs', [], '');
    expect(activity.append.mock.calls[0][1].detail).toBe('2 item(s) → /');

    await controller.moveObjects('p1', 'docs', { sources: ['a'], destFolder: 'archive' }, serviceReq, undefined);
    expect(activity.append.mock.calls[1][1].detail).toBe('2 item(s) → archive');
  });

  it('getPresignedUrl defaults to an hour', async () => {
    const { storage, controller } = deps();
    await controller.getPresignedUrl('p1', 'docs', 'a.txt', undefined as unknown as string, serviceReq, undefined);
    expect(storage.getPresignedUrl).toHaveBeenCalledWith('p1', undefined, 'docs', 'a.txt', 3600);
  });

  it('getPresignedUrl refuses an expiry that is not a number or outside one minute .. seven days', async () => {
    const { storage, controller } = deps();
    for (const expiry of ['abc', '59', '0', '-60', '604801']) {
      await expect(
        controller.getPresignedUrl('p1', 'docs', 'a.txt', expiry, serviceReq, undefined),
      ).rejects.toThrow('Expiry must be between 60 and 604800 seconds');
    }
    expect(storage.getPresignedUrl).not.toHaveBeenCalled();
  });

  it('getPresignedUrl accepts both bounds exactly', async () => {
    const { storage, controller } = deps();
    await controller.getPresignedUrl('p1', 'docs', 'a.txt', '60', serviceReq, undefined);
    await controller.getPresignedUrl('p1', 'docs', 'a.txt', '604800', serviceReq, undefined);
    expect(storage.getPresignedUrl.mock.calls.map((c) => c[4])).toEqual([60, 604800]);
  });

  it('deleteObjects records how many paths, keeping at most twenty in the metadata', async () => {
    const { activity, controller } = deps();
    const paths = Array.from({ length: 25 }, (_, i) => `f${i}.txt`);
    await controller.deleteObjects('p1', 'docs', { paths }, serviceReq, undefined);
    const entry = activity.append.mock.calls[0][1];
    expect(entry).toMatchObject({ kind: 'storage.object_deleted', detail: '25 path(s)' });
    expect(entry.metadata.paths).toEqual(paths.slice(0, 20));
  });

  it('downloadObject falls back to a generic type and encodes a non-ASCII file name (RFC 5987)', async () => {
    const { storage, controller } = deps();
    const stream = { pipe: jest.fn(), destroy: jest.fn() };
    (storage as any).getObject = jest.fn().mockResolvedValue({ stream, stat: { size: 7, metaData: {} } });
    const res: any = { set: jest.fn() };
    await controller.downloadObject('p1', 'docs', 'reports/Ödeme raporu.pdf', serviceReq, undefined, res);
    const encoded = encodeURIComponent('Ödeme raporu.pdf');
    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'application/octet-stream',
      'Content-Length': 7,
      'Content-Disposition': `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`,
    });
    expect(stream.pipe).toHaveBeenCalledWith(res);
  });
});
