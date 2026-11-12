jest.mock('./team-domains.service', () => ({ TeamDomainsService: class {} }));

import { ForbiddenException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { TenantBindingInterceptor, projectIdsOf } from './tenant-binding.interceptor';

const TEAM_OF: Record<string, string> = { pA: 'team-a', pA2: 'team-a', pB: 'team-b' };

function setup() {
  const domains = { teamOfProject: jest.fn(async (id: string) => TEAM_OF[id] ?? null) };
  const interceptor = new TenantBindingInterceptor(domains as any);
  const run = (req: any, type = 'http') => {
    const handle = jest.fn(() => of('handled'));
    const ctx: any = { getType: () => type, switchToHttp: () => ({ getRequest: () => req }) };
    return { result: lastValueFrom(interceptor.intercept(ctx, { handle }) as any), handle };
  };
  return { domains, run };
}

const tenantA = { teamId: 'team-a', subdomain: 'acme', host: 'acme.basefyio.com', previous: false };

describe('projectIdsOf', () => {
  it('collects the key, path, body and query projects once each', () => {
    expect(
      projectIdsOf({
        apiKeyPayload: { projectId: 'pA' },
        params: { projectId: 'pA' },
        body: { projectId: 'pB' },
        query: { projectId: 'pC' },
      }),
    ).toEqual(['pA', 'pB', 'pC']);
    expect(projectIdsOf({ body: 'raw text', params: {}, query: {} })).toEqual([]);
  });
});

describe('TenantBindingInterceptor', () => {
  it('leaves requests on every other host alone', async () => {
    const { domains, run } = setup();
    const { result, handle } = run({ apiKeyPayload: { projectId: 'pB' }, params: {}, query: {} });
    await expect(result).resolves.toBe('handled');
    expect(handle).toHaveBeenCalled();
    expect(domains.teamOfProject).not.toHaveBeenCalled();
  });

  it("serves the workspace's own projects", async () => {
    const { run } = setup();
    const { result } = run({
      tenant: tenantA,
      apiKeyPayload: { projectId: 'pA' },
      params: { projectId: 'pA2' },
      query: {},
    });
    await expect(result).resolves.toBe('handled');
  });

  it("refuses another team's API key on a workspace address", async () => {
    const { run } = setup();
    const { result, handle } = run({
      tenant: tenantA,
      method: 'GET',
      originalUrl: '/api/rest/v1/todos',
      apiKeyPayload: { projectId: 'pB' },
      params: {},
      query: {},
    });
    await expect(result).rejects.toBeInstanceOf(ForbiddenException);
    await expect(result).rejects.toMatchObject({ response: { code: 'WORKSPACE_MISMATCH' } });
    expect(handle).not.toHaveBeenCalled();
  });

  it("refuses another team's project named in the path, body or query", async () => {
    const { run } = setup();
    for (const req of [
      { params: { projectId: 'pB' }, query: {} },
      { params: {}, body: { projectId: 'pB' }, query: {} },
      { params: {}, query: { projectId: 'pB' } },
    ]) {
      const { result } = run({ tenant: tenantA, method: 'POST', url: '/api/x', ...req });
      await expect(result).rejects.toBeInstanceOf(ForbiddenException);
    }
  });

  it('leaves an unknown project to the route, which answers 404 itself', async () => {
    const { run } = setup();
    const { result } = run({ tenant: tenantA, params: { projectId: 'missing' }, query: {} });
    await expect(result).resolves.toBe('handled');
  });

  it('ignores non-HTTP contexts', async () => {
    const { run } = setup();
    const { result } = run({ tenant: tenantA, apiKeyPayload: { projectId: 'pB' } }, 'ws');
    await expect(result).resolves.toBe('handled');
  });
});
