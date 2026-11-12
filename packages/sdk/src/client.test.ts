import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient, VERSION } from './index';

/**
 * The client surface: rpc() answering like every other call, the version
 * export, and what createClient() says when it has no credentials.
 */

function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
  return calls;
}

const client = () => createClient({ projectId: 'p1', apiKey: 'anon', apiUrl: 'https://api.example.test' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('rpc() (#13)', () => {
  it('resolves to { data, error } with the rows', async () => {
    const calls = stubFetch(() => ({ status: 200, body: [{ qa_hello: 'Hello QA' }] }));
    const { data, error } = await client().rpc('qa_hello', { name: 'QA' });
    expect(data).toEqual([{ qa_hello: 'Hello QA' }]);
    expect(error).toBeNull();
    expect(calls[0].url).toBe('https://api.example.test/api/rest/v1/rpc/qa_hello');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ name: 'QA' });
  });

  it('returns a failure as error instead of throwing', async () => {
    stubFetch(() => ({ status: 400, body: { statusCode: 400, message: 'Function "x" cannot be called', code: 'PGRST202' } }));
    const res = await client().rpc('x', { a: 1 });
    expect(res.data).toBeNull();
    expect(res.error).toEqual({ message: 'Function "x" cannot be called', status: 400, code: 'PGRST202' });
  });

  it('still works for code that used the rows directly', async () => {
    stubFetch(() => ({ status: 200, body: [{ n: 7 }] }));
    const rows = (await client().rpc('noarg')) as unknown as Array<{ n: number }>;
    expect(Array.isArray(rows)).toBe(true);
    expect(rows[0].n).toBe(7);
    expect(rows.length).toBe(1);
  });

  it('sends a BigInt argument as a decimal string', async () => {
    const calls = stubFetch(() => ({ status: 200, body: [] }));
    await client().rpc('by_id', { id: 12345678901234567890n });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ id: '12345678901234567890' });
  });
});

describe('package metadata (#170)', () => {
  it('exports VERSION equal to package.json', async () => {
    // A computed specifier: the SDK has no Node typings, and needs none at runtime.
    const nodeFs = 'node:fs';
    const { readFileSync } = (await import(nodeFs)) as { readFileSync(path: URL, enc: string): string };
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(VERSION).toBe(pkg.version);
  });
});

describe('createClient() without credentials (#170)', () => {
  it('says to pass them explicitly in a browser', () => {
    vi.stubGlobal('window', {});
    expect(() => createClient({ apiKey: 'x' })).toThrow(/not read in the browser/);
  });
});

describe('auth.signOut() (#169)', () => {
  it('revokes the refresh token on the server and emits SIGNED_OUT once', async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith('/auth/signin')) {
        return { status: 200, body: { accessToken: 'a.b.c', refreshToken: 'r1', expiresIn: 1800, tokenType: 'Bearer' } };
      }
      if (url.endsWith('/auth/me')) return { status: 200, body: { sub: 'u1' } };
      return { status: 200, body: { message: 'Signed out' } };
    });
    const bf = createClient({ projectId: 'p1', apiKey: 'anon', apiUrl: 'https://api.example.test', autoRefreshToken: false });
    const events: string[] = [];
    bf.auth.onAuthStateChange((e) => events.push(e));
    await bf.auth.signIn({ email: 'a@b.c', password: 'pw' });
    const { error } = await bf.auth.signOut();
    expect(error).toBeNull();
    const revoke = calls.find((c) => c.url.endsWith('/auth/signout'))!;
    expect(JSON.parse(String(revoke.init.body))).toEqual({ refreshToken: 'r1' });
    // Sent with the project key only — an expired access token must not block it.
    expect((revoke.init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(events.filter((e) => e === 'SIGNED_OUT')).toHaveLength(1);
  });

  it('emits nothing and calls nothing when there is no session', async () => {
    const calls = stubFetch(() => ({ status: 200, body: {} }));
    const bf = client();
    const events: string[] = [];
    bf.auth.onAuthStateChange((e) => events.push(e));
    await bf.auth.signOut();
    expect(events).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('auth persistSession (#169)', () => {
  it('stores the session and restores it in a new client', async () => {
    stubFetch((url) => {
      if (url.endsWith('/auth/signin')) {
        return { status: 200, body: { accessToken: 'a.b.c', refreshToken: 'r1', expiresIn: 1800, tokenType: 'Bearer' } };
      }
      return { status: 200, body: { sub: 'u1', email: 'a@b.c', preferred_username: 'a' } };
    });
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const opts = { projectId: 'p1', apiKey: 'anon', apiUrl: 'https://api.example.test', autoRefreshToken: false, auth: { persistSession: true, storage } };

    const first = createClient(opts);
    await first.auth.ready();
    await first.auth.signIn({ email: 'a@b.c', password: 'pw' });
    // Let the user lookup that follows a sign-in settle (it saves the session again).
    await new Promise((r) => setTimeout(r, 10));
    expect(store.get('basefyio.auth.p1')).toContain('r1');
    expect(store.get('basefyio.auth.p1')).toContain('a@b.c');

    const second = createClient(opts);
    await second.auth.ready();
    expect(second.auth.getAccessToken()).toBe('a.b.c');

    await second.auth.signOut();
    expect(store.has('basefyio.auth.p1')).toBe(false);
  });

  it('keeps the session in memory only by default', async () => {
    const bf = client();
    await bf.auth.ready();
    expect(bf.auth.getSession()).toBeNull();
  });
});
