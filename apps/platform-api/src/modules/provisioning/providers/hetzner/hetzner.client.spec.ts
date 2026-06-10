import { HetznerApiError, HetznerClient } from './hetzner.client';
import { HetznerCreateServerParams } from './hetzner.types';

// ── Fixtures ──────────────────────────────────────────────────

const TOKEN = 'hcloud-test-token-abc123';

const PARAMS: HetznerCreateServerParams = {
  name: 'web-1',
  server_type: 'cx11',
  image: 'ubuntu-22.04',
  location: 'nbg1',
};

const RAW_SERVER = {
  id: 42,
  name: 'web-1',
  status: 'initializing',
  server_type: { name: 'cx11' },
  public_net: { ipv4: { ip: '1.2.3.4' } },
  datacenter: {
    name: 'nbg1-dc3',
    location: { name: 'nbg1' },
  },
};

function okResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function noBodyResponse(status: number): Response {
  return { ok: true, status } as unknown as Response;
}

// ── Suite ─────────────────────────────────────────────────────

describe('HetznerClient — createServer', () => {
  let client: HetznerClient;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    client = new HetznerClient();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.useRealTimers();
  });

  // ── Success path ─────────────────────────────────────────────

  describe('success path', () => {
    beforeEach(() => {
      fetchSpy.mockResolvedValue(okResponse(201, { server: RAW_SERVER }));
    });

    it('sends POST to https://api.hetzner.cloud/v1/servers', async () => {
      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();
      await p;

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.hetzner.cloud/v1/servers');
      const { method } = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(method).toBe('POST');
    });

    it('includes Authorization: Bearer header', async () => {
      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();
      await p;

      const { headers } = fetchSpy.mock.calls[0][1] as RequestInit;
      expect((headers as Record<string, string>)['Authorization']).toBe(`Bearer ${TOKEN}`);
    });

    it('serialises request body as JSON', async () => {
      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();
      await p;

      const { body } = fetchSpy.mock.calls[0][1] as RequestInit;
      const sent = JSON.parse(body as string);
      expect(sent).toMatchObject({
        name: 'web-1',
        server_type: 'cx11',
        image: 'ubuntu-22.04',
        location: 'nbg1',
      });
    });

    it('maps Hetzner response to HetznerCreatedServer', async () => {
      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();
      const result = await p;

      expect(result).toEqual({
        id: 42,
        name: 'web-1',
        status: 'initializing',
        serverType: 'cx11',
        publicIpv4: '1.2.3.4',
        locationName: 'nbg1',
        datacenterName: 'nbg1-dc3',
      });
    });

    it('returns null publicIpv4 when ipv4 block is absent', async () => {
      fetchSpy.mockResolvedValue(
        okResponse(201, {
          server: {
            id: 99, name: 'private-1', status: 'running',
            server_type: { name: 'cx11' },
            public_net: {},
            datacenter: { name: 'nbg1-dc3', location: { name: 'nbg1' } },
          },
        }),
      );
      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();
      const result = await p;

      expect(result.publicIpv4).toBeNull();
    });
  });

  // ── Error handling ────────────────────────────────────────────

  describe('error handling', () => {
    it('throws HetznerApiError on 4xx (non-429)', async () => {
      fetchSpy.mockResolvedValue(okResponse(422, { error: { code: 'invalid_input' } }));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();

      await expect(p).rejects.toBeInstanceOf(HetznerApiError);
    });

    it('error message contains the Hetzner error code', async () => {
      fetchSpy.mockResolvedValue(okResponse(422, { error: { code: 'invalid_input' } }));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();

      await expect(p).rejects.toThrow(/invalid_input/);
    });

    it('statusCode and retryable are set correctly on 4xx error', async () => {
      fetchSpy.mockResolvedValue(okResponse(422, { error: { code: 'invalid_input' } }));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();

      await expect(p).rejects.toMatchObject({ statusCode: 422, retryable: false });
    });

    it('does NOT include the api token in 4xx error messages', async () => {
      fetchSpy.mockResolvedValue(okResponse(401, { error: { code: 'unauthorized' } }));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();

      let err: Error | undefined;
      try { await p; } catch (e) { err = e as Error; }
      expect(err).toBeDefined();
      expect(err!.message).not.toContain(TOKEN);
    });

    it('does NOT include the api token in network error messages', async () => {
      // Exhaust all retries with network failures
      fetchSpy.mockRejectedValue(new TypeError('Failed to connect'));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();

      let err: Error | undefined;
      try { await p; } catch (e) { err = e as Error; }
      expect(err).toBeDefined();
      expect(err!.message).not.toContain(TOKEN);
    });

    it('does NOT propagate Hetzner error body content in error messages', async () => {
      // Even if the Hetzner error.message field mentions the token, we never include it.
      fetchSpy.mockResolvedValue(
        okResponse(409, {
          error: { code: 'conflict', message: `detail contains ${TOKEN}` },
        }),
      );

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();

      let err: Error | undefined;
      try { await p; } catch (e) { err = e as Error; }
      expect(err).toBeDefined();
      expect(err!.message).not.toContain(TOKEN);
    });

    it('uses unknown_error code when response body is not valid JSON', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 400,
        json: () => Promise.reject(new SyntaxError('bad json')),
      } as unknown as Response);

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();

      await expect(p).rejects.toThrow(/unknown_error/);
    });
  });

  // ── Retry behaviour ───────────────────────────────────────────

  describe('retry behaviour', () => {
    it('retries once on 429 and succeeds on second attempt', async () => {
      fetchSpy
        .mockResolvedValueOnce(okResponse(429, {}))
        .mockResolvedValueOnce(okResponse(201, { server: RAW_SERVER }));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();
      const result = await p;

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.id).toBe(42);
    });

    it('retries on 503 (5xx) and succeeds on second attempt', async () => {
      fetchSpy
        .mockResolvedValueOnce(okResponse(503, {}))
        .mockResolvedValueOnce(okResponse(201, { server: RAW_SERVER }));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();
      const result = await p;

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.id).toBe(42);
    });

    it('does NOT retry on 4xx (non-429)', async () => {
      fetchSpy.mockResolvedValue(okResponse(422, { error: { code: 'invalid_input' } }));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();
      await expect(p).rejects.toThrow();

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('gives up after 3 attempts (MAX_ATTEMPTS) and throws last error', async () => {
      fetchSpy.mockResolvedValue(okResponse(429, {}));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();

      await expect(p).rejects.toMatchObject({
        statusCode: 429,
        code: 'rate_limit_exceeded',
        retryable: true,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('retries network errors and succeeds on second attempt', async () => {
      fetchSpy
        .mockRejectedValueOnce(new TypeError('Network failure'))
        .mockResolvedValueOnce(okResponse(201, { server: RAW_SERVER }));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();
      const result = await p;

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result.id).toBe(42);
    });

    it('exhausted network retries produce a retryable HetznerApiError', async () => {
      fetchSpy.mockRejectedValue(new TypeError('Network failure'));

      const p = client.createServer(PARAMS, TOKEN);
      await jest.runAllTimersAsync();

      await expect(p).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
        retryable: true,
      });
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });
  });
});

// ── deleteServer ──────────────────────────────────────────────

describe('HetznerClient — deleteServer', () => {
  let client: HetznerClient;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    client = new HetznerClient();
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(noBodyResponse(204));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.useRealTimers();
  });

  it('sends DELETE to /v1/servers/{id}', async () => {
    const p = client.deleteServer(99, TOKEN);
    await jest.runAllTimersAsync();
    await p;

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.hetzner.cloud/v1/servers/99');
    expect(init.method).toBe('DELETE');
  });

  it('resolves without error on 204 response', async () => {
    const p = client.deleteServer(99, TOKEN);
    await jest.runAllTimersAsync();
    await expect(p).resolves.toBeNull();
  });
});
