import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

function makeCtx(headers: Record<string, unknown>) {
  const req: any = { headers };
  const context: any = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => undefined,
    getClass: () => undefined,
  };
  return { context, req };
}

/** A Reflector that reports the given route scope, or none at all. */
const reflectorFor = (scope?: string) =>
  ({ getAllAndOverride: jest.fn().mockReturnValue(scope) }) as any;

const PROJECT = { id: 'p1', anonKey: 'anon-key', serviceKey: 'svc-key', keycloakRealm: 'realm1' };
const prismaWith = (project: any) =>
  ({ project: { findFirst: jest.fn().mockResolvedValue(project) } }) as any;
const config = { get: jest.fn().mockReturnValue(undefined) } as any;

describe('ApiKeyGuard', () => {
  it('rejects a missing apikey header', async () => {
    const g = new ApiKeyGuard(prismaWith(null), config, reflectorFor());
    await expect(g.canActivate(makeCtx({}).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown apikey', async () => {
    const g = new ApiKeyGuard(prismaWith(null), config, reflectorFor());
    await expect(
      g.canActivate(makeCtx({ apikey: 'nope' }).context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts an anon key as anon / dbRole anon', async () => {
    const g = new ApiKeyGuard(prismaWith(PROJECT), config, reflectorFor());
    const { context, req } = makeCtx({ apikey: 'anon-key' });
    await expect(g.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyPayload).toMatchObject({ projectId: 'p1', role: 'anon', dbRole: 'anon' });
  });

  it('accepts a service key as service / dbRole service_role', async () => {
    const g = new ApiKeyGuard(prismaWith(PROJECT), config, reflectorFor());
    const { context, req } = makeCtx({ apikey: 'svc-key' });
    await g.canActivate(context);
    expect(req.apiKeyPayload).toMatchObject({ role: 'service', dbRole: 'service_role' });
  });

  it('treats a Bearer token that mirrors the apikey as anon (SDK default) without JWT verification', async () => {
    const g = new ApiKeyGuard(prismaWith(PROJECT), config, reflectorFor());
    const verify = jest.spyOn(g as any, 'verifyProjectJwt');
    const { context, req } = makeCtx({ apikey: 'anon-key', authorization: 'Bearer anon-key' });
    await expect(g.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyPayload.dbRole).toBe('anon');
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects a forged Bearer JWT that fails verification', async () => {
    const g = new ApiKeyGuard(prismaWith(PROJECT), config, reflectorFor());
    jest.spyOn(g as any, 'verifyProjectJwt').mockResolvedValue(null);
    const { context } = makeCtx({ apikey: 'anon-key', authorization: 'Bearer forged.jwt.token' });
    await expect(g.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('promotes to authenticated when the Bearer JWT verifies', async () => {
    const g = new ApiKeyGuard(prismaWith(PROJECT), config, reflectorFor());
    jest.spyOn(g as any, 'verifyProjectJwt').mockResolvedValue({ sub: 'user-1' });
    const { context, req } = makeCtx({ apikey: 'anon-key', authorization: 'Bearer good.jwt.token' });
    await expect(g.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyPayload.dbRole).toBe('authenticated');
    expect(req.apiKeyPayload.jwtClaims).toEqual({ sub: 'user-1' });
  });
});

/**
 * A key opens exactly one project.
 *
 * These cover the hole that let any project's public anon key act on every
 * other project: the guard resolved the key to its own project, but the
 * services acted on whichever project the request named, and only checked
 * access for dashboard users.
 */
describe('ApiKeyGuard — project binding', () => {
  const OWN = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const ANON = 'anon-key-of-own-project';
  const SERVICE = 'service-key-of-own-project';

  const project = {
    id: OWN,
    anonKey: ANON,
    serviceKey: SERVICE,
    keycloakRealm: 'bf-own',
  };

  function guardWith(binding?: string) {
    const prisma = {
      project: { findFirst: jest.fn().mockResolvedValue(project) },
    };
    const config = {
      get: jest.fn((key: string) =>
        key === 'SERVICE_KEY_PROJECT_BINDING' ? binding : undefined,
      ),
    };
    return new ApiKeyGuard(prisma as any, config as any, reflectorFor());
  }

  function context(request: Record<string, unknown>) {
    const req = {
      method: 'POST',
      originalUrl: '/api/test',
      headers: {},
      params: {},
      query: {},
      body: {},
      ...request,
    };
    return {
      req,
      ctx: {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => undefined,
        getClass: () => undefined,
      } as any,
    };
  }

  describe('anon key', () => {
    it('is accepted on its own project', async () => {
      const { ctx, req } = context({ headers: { apikey: ANON }, params: { projectId: OWN } });
      await expect(guardWith().canActivate(ctx)).resolves.toBe(true);
      expect((req as any).apiKeyPayload.projectId).toBe(OWN);
    });

    it('is accepted where the route names no project at all', async () => {
      const { ctx } = context({ headers: { apikey: ANON } });
      await expect(guardWith().canActivate(ctx)).resolves.toBe(true);
    });

    it('is refused when the path names another project', async () => {
      const { ctx } = context({ headers: { apikey: ANON }, params: { projectId: OTHER } });
      await expect(guardWith().canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is refused when the body names another project (POST /sql/execute)', async () => {
      const { ctx } = context({
        headers: { apikey: ANON },
        body: { projectId: OTHER, query: 'select 1' },
      });
      await expect(guardWith().canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is refused when the query string names another project', async () => {
      const { ctx } = context({ headers: { apikey: ANON }, query: { projectId: OTHER } });
      await expect(guardWith().canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is refused when the path names its own project but the body names another', async () => {
      const { ctx } = context({
        headers: { apikey: ANON },
        params: { projectId: OWN },
        body: { projectId: OTHER },
      });
      await expect(guardWith().canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is refused from the query string too', async () => {
      const { ctx } = context({ query: { apikey: ANON, projectId: OTHER } });
      await expect(guardWith().canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is refused even when it also carries a Bearer mirror of itself', async () => {
      const { ctx } = context({
        headers: { apikey: ANON, authorization: `Bearer ${ANON}` },
        params: { projectId: OTHER },
      });
      await expect(guardWith().canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('service key', () => {
    it('is accepted on its own project', async () => {
      const { ctx } = context({ headers: { apikey: SERVICE }, params: { projectId: OWN } });
      await expect(guardWith().canActivate(ctx)).resolves.toBe(true);
    });

    it('is refused on another project by default', async () => {
      const { ctx } = context({ headers: { apikey: SERVICE }, params: { projectId: OTHER } });
      await expect(guardWith().canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('is allowed but logged on another project when binding is set back to log-only', async () => {
      const guard = guardWith('log');
      const warn = jest.spyOn((guard as any).logger, 'warn').mockImplementation(() => undefined);
      const { ctx } = context({ headers: { apikey: SERVICE }, params: { projectId: OTHER } });

      await expect(guard.canActivate(ctx)).resolves.toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('CROSS-PROJECT SERVICE KEY'));
    });

    it('is still never accepted from the query string', async () => {
      const { ctx } = context({ query: { apikey: SERVICE } });
      await expect(guardWith().canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  it('rejects a key that belongs to no project', async () => {
    const prisma = { project: { findFirst: jest.fn().mockResolvedValue(null) } };
    const guard = new ApiKeyGuard(prisma as any, { get: jest.fn() } as any, reflectorFor());
    const { ctx } = context({ headers: { apikey: 'unknown' } });
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

/**
 * Route scopes.
 *
 * The anon key ships inside every customer's browser bundle, so a route it can
 * reach is a route the whole internet can reach. These cover the second half of
 * that hole: the key was bound to its own project, but within that project it
 * still reached the user directory, the auth configuration and the identity
 * providers — list and delete users, reset passwords, repoint the IdP.
 */
describe('ApiKeyGuard — route scopes', () => {
  const PID = 'proj-1';
  const project = { id: PID, anonKey: 'anon', serviceKey: 'svc', keycloakRealm: 'r1' };

  function guard(scope?: string, env: Record<string, string> = {}) {
    return new ApiKeyGuard(
      { project: { findFirst: jest.fn().mockResolvedValue(project) } } as any,
      { get: jest.fn((k: string) => env[k]) } as any,
      { getAllAndOverride: jest.fn().mockReturnValue(scope) } as any,
    );
  }

  function ctx(headers: Record<string, unknown>) {
    const req: any = {
      method: 'POST',
      originalUrl: '/api/projects/proj-1/auth/users',
      headers,
      params: { projectId: PID },
      query: {},
      body: {},
    };
    return {
      req,
      context: {
        switchToHttp: () => ({ getRequest: () => req }),
        getHandler: () => undefined,
        getClass: () => undefined,
      } as any,
    };
  }

  const verified = (g: ApiKeyGuard) =>
    jest.spyOn(g as any, 'verifyProjectJwt').mockResolvedValue({ sub: 'end-user-1' });

  describe("a route marked 'service'", () => {
    it('refuses the public anon key', async () => {
      const { context } = ctx({ apikey: 'anon' });
      await expect(guard('service').canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('refuses the anon key even with a signed-in end user behind it', async () => {
      const g = guard('service');
      verified(g);
      const { context } = ctx({ apikey: 'anon', authorization: 'Bearer real.jwt' });
      await expect(g.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('accepts the service key', async () => {
      const { context } = ctx({ apikey: 'svc' });
      await expect(guard('service').canActivate(context)).resolves.toBe(true);
    });

    it('says the key is public rather than that it is invalid', async () => {
      const { context } = ctx({ apikey: 'anon' });
      await expect(guard('service').canActivate(context)).rejects.toThrow(/service key/i);
    });
  });

  describe("a route marked 'authenticated'", () => {
    it('refuses a bare anon key', async () => {
      const { context } = ctx({ apikey: 'anon' });
      await expect(guard('authenticated').canActivate(context)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('accepts an anon key carrying a verified end-user JWT', async () => {
      const g = guard('authenticated');
      verified(g);
      const { context, req } = ctx({ apikey: 'anon', authorization: 'Bearer real.jwt' });
      await expect(g.canActivate(context)).resolves.toBe(true);
      expect(req.apiKeyPayload.dbRole).toBe('authenticated');
    });

    it('accepts the service key', async () => {
      const { context } = ctx({ apikey: 'svc' });
      await expect(guard('authenticated').canActivate(context)).resolves.toBe(true);
    });

    it('lets a deployment fall back to logging instead of refusing', async () => {
      const g = guard('authenticated', { ANON_WRITE_BINDING: 'log' });
      const warn = jest.spyOn((g as any).logger, 'warn').mockImplementation(() => undefined);
      const { context } = ctx({ apikey: 'anon' });
      await expect(g.canActivate(context)).resolves.toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ANON WRITE'));
    });
  });

  describe('a route marked anon, or not marked at all', () => {
    it('accepts a bare anon key when explicitly public', async () => {
      const { context } = ctx({ apikey: 'anon' });
      await expect(guard('anon').canActivate(context)).resolves.toBe(true);
    });

    it('leaves an unmarked route exactly as it was', async () => {
      const { context } = ctx({ apikey: 'anon' });
      await expect(guard(undefined).canActivate(context)).resolves.toBe(true);
    });
  });

  /**
   * There are two ways out of key resolution — the normal path and the
   * shortcut for SDKs that mirror the key into the Authorization header. A
   * scope check on only one of them reads as covered and is not.
   */
  it('applies the scope on the mirrored-key shortcut too', async () => {
    const g = guard('service');
    const verify = jest.spyOn(g as any, 'verifyProjectJwt');
    const { context } = ctx({ apikey: 'anon', authorization: 'Bearer anon' });
    await expect(g.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(verify).not.toHaveBeenCalled();
  });

  it('publishes the payload before refusing, so the audit log can name the caller', async () => {
    const g = guard('service');
    const { context, req } = ctx({ apikey: 'anon' });
    await expect(g.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(req.apiKeyPayload).toMatchObject({ projectId: PID, role: 'anon' });
  });
});
