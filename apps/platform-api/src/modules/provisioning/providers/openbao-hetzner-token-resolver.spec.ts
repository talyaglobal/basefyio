import { OpenBaoHetznerTokenResolver, OpenBaoConfig } from './openbao-hetzner-token-resolver';

// ── Fixtures ──────────────────────────────────────────────────

const VAULT_TOKEN = 'hvs.test-vault-root-token';
const OPENBAO_BASE = 'http://vault.internal:8200';

const CONFIG: OpenBaoConfig = {
  baseUrl: OPENBAO_BASE,
  vaultToken: VAULT_TOKEN,
};

function makeResolver(cfg: OpenBaoConfig = CONFIG): OpenBaoHetznerTokenResolver {
  return new OpenBaoHetznerTokenResolver(cfg);
}

function okJson(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function failResponse(status: number): Response {
  return { ok: false, status } as unknown as Response;
}

// ── Suite ─────────────────────────────────────────────────────

describe('OpenBaoHetznerTokenResolver — success paths', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('KV v1: returns token from data.token', async () => {
    fetchSpy.mockResolvedValue(
      okJson({ data: { token: 'hcloud-kv1-token' } }),
    );
    const resolver = makeResolver();
    const result = await resolver.resolve('secret/hetzner/prod');

    expect(result).toBe('hcloud-kv1-token');
  });

  it('KV v2: returns token from data.data.token', async () => {
    fetchSpy.mockResolvedValue(
      okJson({ data: { data: { token: 'hcloud-kv2-token' } } }),
    );
    const result = await makeResolver().resolve('secret/data/hetzner/prod');

    expect(result).toBe('hcloud-kv2-token');
  });

  it('calls the correct OpenBao URL from the path', async () => {
    fetchSpy.mockResolvedValue(okJson({ data: { token: 'tok' } }));
    await makeResolver().resolve('secret/hetzner/token');

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENBAO_BASE}/v1/secret/hetzner/token`);
  });

  it('strips leading slash from openbaoPath before appending', async () => {
    fetchSpy.mockResolvedValue(okJson({ data: { token: 'tok' } }));
    await makeResolver().resolve('/secret/hetzner/token');

    const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('//secret');
    expect(url).toContain('/v1/secret/hetzner/token');
  });

  it('sends X-Vault-Token header with the configured vault token', async () => {
    fetchSpy.mockResolvedValue(okJson({ data: { token: 'tok' } }));
    await makeResolver().resolve('secret/hetzner/token');

    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect((init?.headers as Record<string, string>)?.['X-Vault-Token']).toBe(VAULT_TOKEN);
  });

  it('KV v1 takes precedence over KV v2 when both fields exist', async () => {
    fetchSpy.mockResolvedValue(
      okJson({ data: { token: 'v1-tok', data: { token: 'v2-tok' } } }),
    );
    const result = await makeResolver().resolve('secret/hetzner/token');

    expect(result).toBe('v1-tok');
  });
});

// ── Secret boundary ───────────────────────────────────────────

describe('OpenBaoHetznerTokenResolver — vault token not in errors', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('network error message does NOT contain the vault token', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Network failure'));

    let err: Error | undefined;
    try { await makeResolver().resolve('secret/hetzner/token'); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).not.toContain(VAULT_TOKEN);
  });

  it('non-OK error message does NOT contain the vault token', async () => {
    fetchSpy.mockResolvedValue(failResponse(403));

    let err: Error | undefined;
    try { await makeResolver().resolve('secret/hetzner/token'); } catch (e) { err = e as Error; }

    expect(err).toBeDefined();
    expect(err!.message).not.toContain(VAULT_TOKEN);
  });

  it('resolve() result does NOT contain the vault token', async () => {
    fetchSpy.mockResolvedValue(okJson({ data: { token: 'hcloud-real-token' } }));
    const result = await makeResolver().resolve('secret/hetzner/token');

    // The return value is only the Hetzner token — vault token must not appear
    expect(result).not.toContain(VAULT_TOKEN);
  });
});

// ── Error handling ────────────────────────────────────────────

describe('OpenBaoHetznerTokenResolver — error handling', () => {
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('throws when openbaoPath is empty', async () => {
    await expect(makeResolver().resolve('')).rejects.toThrow(/openbaoPath must not be empty/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws when openbaoPath is whitespace only', async () => {
    await expect(makeResolver().resolve('   ')).rejects.toThrow(/openbaoPath must not be empty/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('throws a sanitized error on network failure', async () => {
    fetchSpy.mockRejectedValue(new TypeError('connect ECONNREFUSED 127.0.0.1:8200'));

    await expect(makeResolver().resolve('secret/hetzner/token')).rejects.toThrow(
      /could not reach OpenBao/,
    );
  });

  it('throws with HTTP status on non-OK response', async () => {
    fetchSpy.mockResolvedValue(failResponse(403));

    await expect(makeResolver().resolve('secret/hetzner/token')).rejects.toThrow(/HTTP 403/);
  });

  it('throws on 404 (path not found in vault)', async () => {
    fetchSpy.mockResolvedValue(failResponse(404));

    await expect(makeResolver().resolve('secret/hetzner/token')).rejects.toThrow(/HTTP 404/);
  });

  it('throws when response body is not valid JSON', async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.reject(new SyntaxError('bad json')),
    } as unknown as Response);

    await expect(makeResolver().resolve('secret/hetzner/token')).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it('throws when token field is absent in KV v1 response', async () => {
    fetchSpy.mockResolvedValue(okJson({ data: { other_field: 'value' } }));

    await expect(makeResolver().resolve('secret/hetzner/token')).rejects.toThrow(
      /valid token field/,
    );
  });

  it('throws when token field is absent in KV v2 response', async () => {
    fetchSpy.mockResolvedValue(okJson({ data: { data: { other_field: 'value' } } }));

    await expect(makeResolver().resolve('secret/hetzner/token')).rejects.toThrow(
      /valid token field/,
    );
  });

  it('throws when token is an empty string', async () => {
    fetchSpy.mockResolvedValue(okJson({ data: { token: '' } }));

    await expect(makeResolver().resolve('secret/hetzner/token')).rejects.toThrow(
      /valid token field/,
    );
  });

  it('throws when token is whitespace only', async () => {
    fetchSpy.mockResolvedValue(okJson({ data: { token: '   ' } }));

    await expect(makeResolver().resolve('secret/hetzner/token')).rejects.toThrow(
      /valid token field/,
    );
  });

  it('throws when response body is null', async () => {
    fetchSpy.mockResolvedValue(okJson(null));

    await expect(makeResolver().resolve('secret/hetzner/token')).rejects.toThrow(
      /valid token field/,
    );
  });
});
