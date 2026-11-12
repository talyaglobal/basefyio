import { UsageTrackingMiddleware } from './usage-tracking.middleware';

const MiB = 1024 * 1024;

/**
 * Bandwidth is egress. The middleware used to add the request's Content-Length
 * to the response size, so every upload was billed as bandwidth: a QA run that
 * uploaded 20 × 2 MiB and downloaded 80 MiB saw 120 MiB of egress, the excess
 * being exactly the uploads.
 */
describe('UsageTrackingMiddleware — egress and active users', () => {
  function setup() {
    const prisma = {
      project: {
        findUnique: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'p1', teamId: 't1' }),
      },
    } as any;
    const usage = {
      trackApiRequest: jest.fn().mockResolvedValue(undefined),
      trackBandwidth: jest.fn().mockResolvedValue(undefined),
      trackActiveUser: jest.fn().mockResolvedValue(undefined),
    } as any;
    const mw = new UsageTrackingMiddleware(prisma, usage);
    clearInterval((mw as any).evictionTimer);
    return { mw, usage };
  }

  function request(over: Record<string, any> = {}) {
    return {
      method: 'POST',
      originalUrl: '/api/storage/v1/object/p1/docs/a.bin',
      url: '/api/storage/v1/object/p1/docs/a.bin',
      headers: { 'x-project-id': 'p1', ...(over.headers ?? {}) },
      ...over,
    } as any;
  }

  function response() {
    return { write: jest.fn().mockReturnValue(true), end: jest.fn().mockReturnValue(undefined) } as any;
  }

  /** Sum of every bandwidth figure recorded. */
  const tracked = (usage: any) =>
    usage.trackBandwidth.mock.calls.reduce((s: number, c: any[]) => s + c[1], 0);

  it('does not count an upload body as bandwidth', async () => {
    const { mw, usage } = setup();
    const req = request({ headers: { 'x-project-id': 'p1', 'content-length': String(40 * MiB) } });
    const res = response();
    await mw.use(req, res, jest.fn());
    const body = JSON.stringify({ Key: 'docs/a.bin' });
    res.end(body);
    expect(usage.trackBandwidth).toHaveBeenCalledTimes(1);
    expect(usage.trackBandwidth).toHaveBeenCalledWith('t1', Buffer.byteLength(body), 'p1');
  });

  it('counts a streamed 80 MiB download as exactly 83,886,080 bytes', async () => {
    const { mw, usage } = setup();
    const req = request({ method: 'GET' });
    const res = response();
    await mw.use(req, res, jest.fn());
    const chunk = Buffer.alloc(MiB);
    for (let i = 0; i < 80; i++) res.write(chunk);
    res.end();
    expect(tracked(usage)).toBe(83_886_080);
  });

  it('reproduces the QA run: 20 × 2 MiB uploads plus an 80 MiB download bill 80 MiB, not 120', async () => {
    const { mw, usage } = setup();
    const ack = '{"ok":true}'; // 11 bytes per upload response
    for (let i = 0; i < 20; i++) {
      const res = response();
      await mw.use(request({ headers: { 'x-project-id': 'p1', 'content-length': String(2 * MiB) } }), res, jest.fn());
      res.end(ack);
    }
    const res = response();
    await mw.use(request({ method: 'GET' }), res, jest.fn());
    const chunk = Buffer.alloc(MiB);
    for (let i = 0; i < 80; i++) res.write(chunk);
    res.end();

    expect(tracked(usage)).toBe(80 * MiB + 20 * Buffer.byteLength(ack));
    // The old formula added every request body: 120 MiB plus the acks.
    expect(tracked(usage)).toBeLessThan(120 * MiB);
  });

  it('measures a string chunk in its encoding', async () => {
    const { mw, usage } = setup();
    const res = response();
    await mw.use(request({ method: 'GET' }), res, jest.fn());
    res.write('ğüş', 'utf8'); // 6 bytes in UTF-8
    res.end('00ff', 'hex'); // 2 bytes
    expect(tracked(usage)).toBe(8);
  });

  it('counts a response once even when end() is reached twice', async () => {
    const { mw, usage } = setup();
    const res = response();
    await mw.use(request({ method: 'GET' }), res, jest.fn());
    res.end('abc');
    res.end();
    expect(usage.trackBandwidth).toHaveBeenCalledTimes(1);
    expect(tracked(usage)).toBe(3);
  });

  it('skips a CORS preflight entirely', async () => {
    const { mw, usage } = setup();
    const next = jest.fn();
    await mw.use(request({ method: 'OPTIONS' }), response(), next);
    expect(next).toHaveBeenCalled();
    expect(usage.trackApiRequest).not.toHaveBeenCalled();
  });

  describe('monthly active users', () => {
    it('counts the end user whose token the guard verified', async () => {
      const { mw, usage } = setup();
      const req = request({ method: 'GET' });
      const res = response();
      await mw.use(req, res, jest.fn());
      // The ApiKeyGuard runs after the middleware and publishes verified claims.
      req.apiKeyPayload = { projectId: 'p1', role: 'anon', dbRole: 'authenticated', jwtClaims: { sub: 'user-1' } };
      res.end('[]');
      expect(usage.trackActiveUser).toHaveBeenCalledWith('t1', 'user-1', 'p1');
    });

    it('does not count anonymous or service-key requests', async () => {
      const { mw, usage } = setup();
      for (const dbRole of ['anon', 'service_role']) {
        const req = request({ method: 'GET' });
        const res = response();
        await mw.use(req, res, jest.fn());
        req.apiKeyPayload = { projectId: 'p1', role: 'anon', dbRole, jwtClaims: { sub: 'user-1' } };
        res.end('[]');
      }
      const req = request({ method: 'GET' });
      const res = response();
      await mw.use(req, res, jest.fn());
      res.end('[]'); // rejected before the guard published anything
      expect(usage.trackActiveUser).not.toHaveBeenCalled();
    });

    it('does not credit a user verified for a different project', async () => {
      const { mw, usage } = setup();
      const req = request({ method: 'GET' });
      const res = response();
      await mw.use(req, res, jest.fn());
      req.apiKeyPayload = { projectId: 'p2', role: 'anon', dbRole: 'authenticated', jwtClaims: { sub: 'user-1' } };
      res.end('[]');
      expect(usage.trackActiveUser).not.toHaveBeenCalled();
    });
  });
});
