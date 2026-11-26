import { BadRequestException } from '@nestjs/common';
import { TurnstileService } from './turnstile.service';

describe('TurnstileService', () => {
  const env = { ...process.env };
  const realFetch = global.fetch;
  afterEach(() => {
    process.env = { ...env };
    global.fetch = realFetch;
  });

  it('is off without both keys and lets everything through', async () => {
    delete process.env.TURNSTILE_SITE_KEY;
    delete process.env.TURNSTILE_SECRET_KEY;
    const s = new TurnstileService();
    expect(s.enabled).toBe(false);
    await expect(s.assertHuman(undefined)).resolves.toBeUndefined();
  });

  it('requires a token when on', async () => {
    process.env.TURNSTILE_SITE_KEY = 'site';
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    await expect(new TurnstileService().assertHuman(undefined)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a token Cloudflare refuses and accepts one it approves', async () => {
    process.env.TURNSTILE_SITE_KEY = 'site';
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: false }) }) as never;
    await expect(new TurnstileService().assertHuman('bad')).rejects.toBeInstanceOf(BadRequestException);
    global.fetch = jest.fn().mockResolvedValue({ json: async () => ({ success: true }) }) as never;
    await expect(new TurnstileService().assertHuman('good', '1.2.3.4')).resolves.toBeUndefined();
  });

  it('fails open when Cloudflare is unreachable', async () => {
    process.env.TURNSTILE_SITE_KEY = 'site';
    process.env.TURNSTILE_SECRET_KEY = 'secret';
    global.fetch = jest.fn().mockRejectedValue(new Error('network')) as never;
    await expect(new TurnstileService().assertHuman('x')).resolves.toBeUndefined();
  });
});
