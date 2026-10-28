import { ConfigService } from '@nestjs/config';
import { ForbiddenException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

/**
 * The guard on the data plane.
 *
 * Two things a supabase-js caller needs of the guard beyond the key itself:
 * the dialect decision on the request, taken here so the controller and its
 * error filter cannot disagree; and that a `projectId` in the body or the
 * query string of a /rest/v1 request is a column of the caller's own table,
 * not another project — before this, a table with a `projectId` column was
 * refused with 403 on every write and every filter on it.
 */
describe('ApiKeyGuard on /rest/v1', () => {
  const OWN = '11111111-1111-4111-8111-111111111111';
  const OTHER = '22222222-2222-4222-8222-222222222222';
  const ANON = 'anon-key';

  function guard() {
    const prisma: any = {
      project: {
        findFirst: jest.fn().mockResolvedValue({
          id: OWN, anonKey: ANON, serviceKey: 'service-key', keycloakRealm: 'r', status: 'ACTIVE',
        }),
      },
    };
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) } as any;
    return new ApiKeyGuard(prisma, { get: () => undefined } as unknown as ConfigService, reflector);
  }

  function context(req: Record<string, unknown>) {
    const request: any = { headers: {}, params: {}, query: {}, method: 'POST', ...req };
    return {
      request,
      ctx: {
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => undefined,
        getClass: () => undefined,
      } as any,
    };
  }

  it('records the dialect on the request when it admits a PostgREST client', async () => {
    const { ctx, request } = context({ headers: { apikey: ANON, 'accept-profile': 'public' }, originalUrl: '/api/rest/v1/posts' });
    await expect(guard().canActivate(ctx)).resolves.toBe(true);
    expect(request.supabaseCompat).toBe(true);
  });

  it('records the platform dialect for a caller without the client headers', async () => {
    const { ctx, request } = context({ headers: { apikey: ANON }, originalUrl: '/api/rest/v1/posts' });
    await expect(guard().canActivate(ctx)).resolves.toBe(true);
    expect(request.supabaseCompat).toBe(false);
  });

  it('does not read a projectId column in the body or query as a project on /rest/v1', async () => {
    const body = context({
      headers: { apikey: ANON },
      originalUrl: '/api/rest/v1/tasks',
      body: { projectId: OTHER, title: 'x' },
    });
    await expect(guard().canActivate(body.ctx)).resolves.toBe(true);

    const query = context({
      headers: { apikey: ANON },
      method: 'GET',
      originalUrl: `/api/rest/v1/tasks?projectId=eq.${OTHER}`,
      query: { projectId: `eq.${OTHER}` },
    });
    await expect(guard().canActivate(query.ctx)).resolves.toBe(true);
  });

  it('still refuses another project named in the body elsewhere', async () => {
    const { ctx } = context({ headers: { apikey: ANON }, originalUrl: '/api/sql/execute', body: { projectId: OTHER } });
    await expect(guard().canActivate(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
