import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';

function makeCtx(headers: Record<string, unknown>) {
  const req: any = { headers };
  const context: any = { switchToHttp: () => ({ getRequest: () => req }) };
  return { context, req };
}

const PROJECT = { id: 'p1', anonKey: 'anon-key', serviceKey: 'svc-key', keycloakRealm: 'realm1' };
const prismaWith = (project: any) =>
  ({ project: { findFirst: jest.fn().mockResolvedValue(project) } }) as any;
const config = {} as any;

describe('ApiKeyGuard', () => {
  it('rejects a missing apikey header', async () => {
    const g = new ApiKeyGuard(prismaWith(null), config);
    await expect(g.canActivate(makeCtx({}).context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown apikey', async () => {
    const g = new ApiKeyGuard(prismaWith(null), config);
    await expect(
      g.canActivate(makeCtx({ apikey: 'nope' }).context),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('accepts an anon key as anon / dbRole anon', async () => {
    const g = new ApiKeyGuard(prismaWith(PROJECT), config);
    const { context, req } = makeCtx({ apikey: 'anon-key' });
    await expect(g.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyPayload).toMatchObject({ projectId: 'p1', role: 'anon', dbRole: 'anon' });
  });

  it('accepts a service key as service / dbRole service_role', async () => {
    const g = new ApiKeyGuard(prismaWith(PROJECT), config);
    const { context, req } = makeCtx({ apikey: 'svc-key' });
    await g.canActivate(context);
    expect(req.apiKeyPayload).toMatchObject({ role: 'service', dbRole: 'service_role' });
  });

  it('treats a Bearer token that mirrors the apikey as anon (SDK default) without JWT verification', async () => {
    const g = new ApiKeyGuard(prismaWith(PROJECT), config);
    const verify = jest.spyOn(g as any, 'verifyProjectJwt');
    const { context, req } = makeCtx({ apikey: 'anon-key', authorization: 'Bearer anon-key' });
    await expect(g.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyPayload.dbRole).toBe('anon');
    expect(verify).not.toHaveBeenCalled();
  });

  it('rejects a forged Bearer JWT that fails verification', async () => {
    const g = new ApiKeyGuard(prismaWith(PROJECT), config);
    jest.spyOn(g as any, 'verifyProjectJwt').mockResolvedValue(null);
    const { context } = makeCtx({ apikey: 'anon-key', authorization: 'Bearer forged.jwt.token' });
    await expect(g.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('promotes to authenticated when the Bearer JWT verifies', async () => {
    const g = new ApiKeyGuard(prismaWith(PROJECT), config);
    jest.spyOn(g as any, 'verifyProjectJwt').mockResolvedValue({ sub: 'user-1' });
    const { context, req } = makeCtx({ apikey: 'anon-key', authorization: 'Bearer good.jwt.token' });
    await expect(g.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyPayload.dbRole).toBe('authenticated');
    expect(req.apiKeyPayload.jwtClaims).toEqual({ sub: 'user-1' });
  });
});
