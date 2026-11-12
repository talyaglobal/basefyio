jest.mock('./team-domains.service', () => ({ TeamDomainsService: class {} }));

import { TenantHostMiddleware } from './tenant-host.middleware';

function setup(resolve: (label: string) => Promise<unknown>, base: string | null = 'basefyio.com') {
  const domains = { baseDomain: jest.fn(() => base), resolveLabel: jest.fn(resolve) };
  const mw = new TenantHostMiddleware(domains as any);
  const run = (host: string | undefined) =>
    new Promise<{ req: any; status?: number; body?: any; nextCalled: boolean }>((resolveRun) => {
      const req: any = { headers: host === undefined ? {} : { host } };
      const res: any = {
        status: jest.fn((code: number) => {
          res.code = code;
          return res;
        }),
        json: jest.fn((body: unknown) => resolveRun({ req, status: res.code, body, nextCalled: false })),
      };
      mw.use(req, res, () => resolveRun({ req, nextCalled: true }));
    });
  return { domains, run };
}

describe('TenantHostMiddleware', () => {
  it.each([
    'api.basefyio.com',
    'app.basefyio.com',
    'basefyio.com',
    'db.basefyio.com',
    'storage.basefyio.com',
    'platform-api:4000',
    'localhost:4000',
    undefined,
  ])('passes %j through untouched, without a lookup', async (host) => {
    const { domains, run } = setup(async () => {
      throw new Error('must not be called');
    });
    const r = await run(host);
    expect(r.nextCalled).toBe(true);
    expect(r.req.tenant).toBeUndefined();
    expect(domains.resolveLabel).not.toHaveBeenCalled();
  });

  it('attaches the team of a known workspace address', async () => {
    const { run } = setup(async () => ({ teamId: 't1', subdomain: 'technoplatz', previous: false }));
    const r = await run('technoplatz.basefyio.com');
    expect(r.nextCalled).toBe(true);
    expect(r.req.tenant).toEqual({
      teamId: 't1',
      subdomain: 'technoplatz',
      host: 'technoplatz.basefyio.com',
      previous: false,
    });
  });

  it('answers 404 for a workspace address nobody holds', async () => {
    const { run } = setup(async () => null);
    const r = await run('nobody.basefyio.com');
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ statusCode: 404, code: 'WORKSPACE_NOT_FOUND' });
  });

  it('answers 503 rather than passing through when the lookup fails', async () => {
    const { run } = setup(async () => {
      throw new Error('db down');
    });
    const r = await run('technoplatz.basefyio.com');
    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(503);
  });

  it('does nothing on a server without a base domain', async () => {
    const { domains, run } = setup(async () => null, null);
    const r = await run('technoplatz.basefyio.com');
    expect(r.nextCalled).toBe(true);
    expect(domains.resolveLabel).not.toHaveBeenCalled();
  });
});
