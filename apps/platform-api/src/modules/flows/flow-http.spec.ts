import { BadRequestException } from '@nestjs/common';
import { PassThrough, Readable } from 'stream';
import { AxiosRequestConfig } from 'axios';
import { HttpDeps, MAX_CAPTURE_BYTES, performHttpRequest } from './flow-http';

const streamOf = (text: string): Readable => Readable.from([Buffer.from(text)]);

function deps(responses: Array<(cfg: AxiosRequestConfig) => any>, guard?: (url: string) => Promise<void>) {
  const calls: AxiosRequestConfig[] = [];
  const d: HttpDeps = {
    request: jest.fn(async (cfg: AxiosRequestConfig) => {
      calls.push(cfg);
      const next = responses.shift();
      if (!next) throw new Error('unexpected request');
      return next(cfg);
    }),
    assertSafeUrl: guard ?? (async () => undefined),
    now: () => Date.now(),
  };
  return { d, calls };
}

describe('performHttpRequest', () => {
  it('returns status, headers and the parsed JSON body', async () => {
    const { d } = deps([
      () => ({ status: 201, headers: { 'content-type': 'application/json', 'set-cookie': ['s=1'] }, data: streamOf('{"id":5}') }),
    ]);
    const res = await performHttpRequest({ method: 'POST', url: 'https://x.io', body: { a: 1 }, timeoutMs: 5000 }, d);
    expect(res).toMatchObject({ ok: true, status: 201, body: { id: 5 }, truncated: false });
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('sends an object body as JSON', async () => {
    const { d, calls } = deps([() => ({ status: 200, headers: {}, data: streamOf('') })]);
    await performHttpRequest({ method: 'POST', url: 'https://x.io', body: { a: 1 }, timeoutMs: 5000 }, d);
    expect(calls[0].data).toBe('{"a":1}');
    expect((calls[0].headers as any)['Content-Type']).toBe('application/json');
  });

  it('reports a 4xx/5xx as a failure with the status', async () => {
    const { d } = deps([() => ({ status: 405, statusText: 'Method Not Allowed', headers: {}, data: streamOf('nope') })]);
    const res = await performHttpRequest({ method: 'POST', url: 'https://x.io', timeoutMs: 5000 }, d);
    expect(res).toMatchObject({ ok: false, status: 405, error: 'HTTP 405 Method Not Allowed', body: 'nope' });
  });

  it('follows redirects, re-checking every hop, and turns a 302 POST into a GET', async () => {
    const guard = jest.fn(async () => undefined);
    const { d, calls } = deps(
      [
        () => ({ status: 302, headers: { location: '/next' }, data: streamOf('') }),
        () => ({ status: 200, headers: {}, data: streamOf('done') }),
      ],
      guard,
    );
    const res = await performHttpRequest(
      { method: 'POST', url: 'https://x.io/start', body: { a: 1 }, timeoutMs: 5000 },
      d,
    );
    expect(res).toMatchObject({ ok: true, status: 200, body: 'done', redirects: ['https://x.io/next'] });
    expect(guard).toHaveBeenCalledWith('https://x.io/next');
    expect(calls[1].method).toBe('GET');
    expect(calls[1].data).toBeUndefined();
    expect(calls.every((c) => c.maxRedirects === 0)).toBe(true);
  });

  it('refuses a redirect into the private network', async () => {
    const guard = jest.fn(async (url: string) => {
      if (url.includes('169.254')) throw new BadRequestException('url host is not allowed');
    });
    const { d } = deps([() => ({ status: 301, headers: { location: 'http://169.254.169.254/' }, data: streamOf('') })], guard);
    const res = await performHttpRequest({ method: 'GET', url: 'https://x.io', timeoutMs: 5000 }, d);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('redirect to http://169.254.169.254/ refused');
  });

  it('drops credentials when a redirect leaves the host', async () => {
    const { d, calls } = deps([
      () => ({ status: 307, headers: { location: 'https://other.io/' }, data: streamOf('') }),
      () => ({ status: 200, headers: {}, data: streamOf('') }),
    ]);
    await performHttpRequest(
      { method: 'GET', url: 'https://x.io', headers: { Authorization: 'Bearer t', Accept: '*/*' }, timeoutMs: 5000 },
      d,
    );
    expect(calls[1].headers).toEqual({ Accept: '*/*' });
  });

  it('keeps a 3xx as the answer when redirects are switched off', async () => {
    const { d } = deps([() => ({ status: 302, headers: { location: '/x' }, data: streamOf('') })]);
    const res = await performHttpRequest({ method: 'GET', url: 'https://x.io', timeoutMs: 5000, followRedirects: false }, d);
    expect(res).toMatchObject({ ok: true, status: 302, redirects: [] });
  });

  it('gives up after too many redirects', async () => {
    const loop = () => ({ status: 302, headers: { location: '/again' }, data: streamOf('') });
    const { d } = deps(Array.from({ length: 10 }, () => loop));
    const res = await performHttpRequest({ method: 'GET', url: 'https://x.io', timeoutMs: 5000 }, d);
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('too many redirects') });
  });

  it('enforces the timeout as a hard deadline, even while the body is still streaming', async () => {
    const trickle = new PassThrough();
    const { d } = deps([() => ({ status: 200, headers: {}, data: trickle })]);
    const interval = setInterval(() => trickle.write('x'), 20);
    try {
      const res = await performHttpRequest({ method: 'GET', url: 'https://x.io', timeoutMs: 150 }, d);
      expect(res).toMatchObject({ ok: false, error: expect.stringContaining('timed out') });
    } finally {
      clearInterval(interval);
    }
  });

  it('caps how much of a large body is read', async () => {
    const big = 'a'.repeat(MAX_CAPTURE_BYTES + 1000);
    const { d } = deps([() => ({ status: 200, headers: { 'content-type': 'text/plain' }, data: streamOf(big) })]);
    const res = await performHttpRequest({ method: 'GET', url: 'https://x.io', timeoutMs: 5000 }, d);
    expect(res.truncated).toBe(true);
    expect((res.body as string).length).toBe(MAX_CAPTURE_BYTES);
  });
});
