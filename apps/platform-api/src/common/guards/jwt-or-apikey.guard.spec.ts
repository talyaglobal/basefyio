import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtOrApiKeyGuard } from './jwt-or-apikey.guard';

function ctx(req: Record<string, unknown>): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('JwtOrApiKeyGuard', () => {
  const jwt = { canActivate: jest.fn() };
  const apiKey = { canActivate: jest.fn().mockResolvedValue(true) };
  const guard = new JwtOrApiKeyGuard(jwt as never, apiKey as never);
  beforeEach(() => apiKey.canActivate.mockClear());

  it('hands a key in the apikey header to the API key guard', async () => {
    await expect(guard.canActivate(ctx({ headers: { apikey: 'k' }, query: {} }))).resolves.toBe(true);
    expect(apiKey.canActivate).toHaveBeenCalled();
  });

  it('hands a key in the query string to the API key guard (<img src> and download links)', async () => {
    await expect(guard.canActivate(ctx({ headers: {}, query: { apikey: 'k' } }))).resolves.toBe(true);
    expect(apiKey.canActivate).toHaveBeenCalled();
  });

  it('refuses a request with no credentials', async () => {
    await expect(guard.canActivate(ctx({ headers: {}, query: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(apiKey.canActivate).not.toHaveBeenCalled();
  });
});
