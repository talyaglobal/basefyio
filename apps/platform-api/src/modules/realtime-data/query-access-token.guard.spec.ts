import { QueryAccessTokenGuard } from './query-access-token.guard';

function ctxFor(req: any) {
  return { switchToHttp: () => ({ getRequest: () => req }) } as any;
}

describe('QueryAccessTokenGuard', () => {
  const guard = new QueryAccessTokenGuard();

  it('copies ?access_token= into the Authorization header when none is present', () => {
    const req: any = { headers: {}, query: { access_token: ' abc.def.ghi ' } };
    expect(guard.canActivate(ctxFor(req))).toBe(true);
    expect(req.headers.authorization).toBe('Bearer abc.def.ghi');
  });

  it('leaves an existing Authorization header alone', () => {
    const req: any = { headers: { authorization: 'Bearer header-token' }, query: { access_token: 'query-token' } };
    guard.canActivate(ctxFor(req));
    expect(req.headers.authorization).toBe('Bearer header-token');
  });

  it('ignores an empty or non-string token', () => {
    const empty: any = { headers: {}, query: { access_token: '   ' } };
    const array: any = { headers: {}, query: { access_token: ['a', 'b'] } };
    const none: any = { headers: {}, query: {} };
    for (const req of [empty, array, none]) {
      expect(guard.canActivate(ctxFor(req))).toBe(true);
      expect(req.headers.authorization).toBeUndefined();
    }
  });

  it('never blocks the request', () => {
    expect(guard.canActivate(ctxFor({}))).toBe(true);
    expect(guard.canActivate(ctxFor(undefined))).toBe(true);
  });
});
