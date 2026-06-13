import { SecurePostgresProvider } from './secure-postgres.provider';
import { Pool } from 'pg';

jest.mock('pg');

const MockPool = Pool as jest.MockedClass<typeof Pool>;

// ── Mock helpers ──────────────────────────────────────────────────────────────

function makeClient(queryResult: { rows: Record<string, unknown>[]; rowCount: number } = { rows: [{ '?column?': 1 }], rowCount: 1 }) {
  return {
    query: jest.fn().mockResolvedValue(queryResult),
    release: jest.fn(),
  };
}

function makePool(client?: ReturnType<typeof makeClient>) {
  const c = client ?? makeClient();
  return {
    connect: jest.fn().mockResolvedValue(c),
    end: jest.fn().mockResolvedValue(undefined),
    _client: c,
  };
}

function setupPool(overridePool?: ReturnType<typeof makePool>) {
  const pool = overridePool ?? makePool();
  MockPool.mockImplementation(() => pool as any);
  return pool;
}

const MTLS_PARAMS = {
  host: 'db.internal',
  port: 5432,
  database: 'testdb',
  username: 'app',
  sslCert: '-----BEGIN CERTIFICATE-----\nCERT\n-----END CERTIFICATE-----',
  sslKey: '-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----',
  sslCa: '-----BEGIN CERTIFICATE-----\nCA\n-----END CERTIFICATE-----',
  requireMtls: true as const,
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SecurePostgresProvider', () => {
  let provider: SecurePostgresProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = new SecurePostgresProvider();
  });

  afterEach(async () => {
    await provider.disconnect().catch(() => {});
  });

  describe('connect()', () => {
    it('throws when sslCert missing', async () => {
      await expect(provider.connect({ ...MTLS_PARAMS, sslCert: undefined }))
        .rejects.toThrow('mTLS requires sslCert, sslKey, and sslCa');
    });

    it('throws when sslKey missing', async () => {
      await expect(provider.connect({ ...MTLS_PARAMS, sslKey: undefined }))
        .rejects.toThrow('mTLS requires sslCert, sslKey, and sslCa');
    });

    it('throws when sslCa missing', async () => {
      await expect(provider.connect({ ...MTLS_PARAMS, sslCa: undefined }))
        .rejects.toThrow('mTLS requires sslCert, sslKey, and sslCa');
    });

    it('creates pg.Pool with ssl.key = params.sslKey', async () => {
      setupPool();
      await provider.connect(MTLS_PARAMS);
      expect(MockPool).toHaveBeenCalledWith(
        expect.objectContaining({
          ssl: expect.objectContaining({ key: MTLS_PARAMS.sslKey }),
        }),
      );
    });

    it('ssl.cert and ssl.ca are passed to the pool', async () => {
      setupPool();
      await provider.connect(MTLS_PARAMS);
      expect(MockPool).toHaveBeenCalledWith(
        expect.objectContaining({
          ssl: expect.objectContaining({
            cert: MTLS_PARAMS.sslCert,
            ca: MTLS_PARAMS.sslCa,
          }),
        }),
      );
    });

    it('ssl.rejectUnauthorized = true — no self-signed certs allowed', async () => {
      setupPool();
      await provider.connect(MTLS_PARAMS);
      expect(MockPool).toHaveBeenCalledWith(
        expect.objectContaining({
          ssl: expect.objectContaining({ rejectUnauthorized: true }),
        }),
      );
    });

    it('verifies connectivity via SELECT 1 on connect', async () => {
      const pool = setupPool();
      await provider.connect(MTLS_PARAMS);
      expect(pool._client.query).toHaveBeenCalledWith('SELECT 1');
    });

    it('idempotent — second connect() tears down existing pool first', async () => {
      const pool1 = setupPool();
      await provider.connect(MTLS_PARAMS);

      const pool2 = setupPool();
      await provider.connect(MTLS_PARAMS);

      expect(pool1.end).toHaveBeenCalled();
      expect(pool2.end).not.toHaveBeenCalled(); // still active
    });

    it('connect failure → sanitized error — sslKey PEM not in message', async () => {
      const badClient = makeClient();
      badClient.query.mockRejectedValueOnce(
        new Error(`SSL handshake failed: ${MTLS_PARAMS.sslKey}`),
      );
      setupPool(makePool(badClient));

      let caughtErr: Error | undefined;
      try { await provider.connect(MTLS_PARAMS); } catch (e) { caughtErr = e as Error; }
      expect(caughtErr).toBeDefined();
      expect(caughtErr!.message).not.toContain('SECRET');
      expect(caughtErr!.message).not.toContain('PRIVATE KEY');
    });

    it('connect failure → sanitized error — password not in message', async () => {
      const badClient = makeClient();
      badClient.query.mockRejectedValueOnce(
        new Error('auth failed: password=hunter2'),
      );
      setupPool(makePool(badClient));

      let caughtErr: Error | undefined;
      try { await provider.connect({ ...MTLS_PARAMS, password: 'hunter2' }); } catch (e) { caughtErr = e as Error; }
      expect(caughtErr).toBeDefined();
      expect(caughtErr!.message).not.toContain('hunter2');
    });

    it('connect failure → pool.end() called to clean up', async () => {
      const pool = makePool();
      pool._client.query.mockRejectedValueOnce(new Error('fail'));
      setupPool(pool);

      await provider.connect(MTLS_PARAMS).catch(() => {});
      expect(pool.end).toHaveBeenCalled();
    });
  });

  describe('query()', () => {
    it('throws when not connected', async () => {
      await expect(provider.query('SELECT 1')).rejects.toThrow('not connected');
    });

    it('sends sql and params to the pg driver (parameterized — no interpolation)', async () => {
      const pool = setupPool();
      await provider.connect(MTLS_PARAMS);

      const queryClient = makeClient({ rows: [{ n: 42 }], rowCount: 1 });
      pool.connect.mockResolvedValue(queryClient);

      await provider.query('SELECT $1::int AS n', [42]);
      expect(queryClient.query).toHaveBeenCalledWith('SELECT $1::int AS n', [42]);
    });

    it('returns rows and rowCount from pg result', async () => {
      const pool = setupPool();
      await provider.connect(MTLS_PARAMS);

      const queryClient = makeClient({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
      pool.connect.mockResolvedValue(queryClient);

      const result = await provider.query('SELECT id FROM items');
      expect(result.rows).toHaveLength(2);
      expect(result.rowCount).toBe(2);
    });

    it('releases client after query success', async () => {
      const pool = setupPool();
      await provider.connect(MTLS_PARAMS);

      const queryClient = makeClient();
      pool.connect.mockResolvedValue(queryClient);
      await provider.query('SELECT 1');

      expect(queryClient.release).toHaveBeenCalled();
    });

    it('releases client after query failure', async () => {
      const pool = setupPool();
      await provider.connect(MTLS_PARAMS);

      const queryClient = makeClient();
      queryClient.query.mockRejectedValue(new Error('query failed'));
      pool.connect.mockResolvedValue(queryClient);

      await provider.query('SELECT 1').catch(() => {});
      expect(queryClient.release).toHaveBeenCalled();
    });

    it('sanitizes error — sslKey PEM not in thrown error message', async () => {
      const pool = setupPool();
      await provider.connect(MTLS_PARAMS);

      const queryClient = makeClient();
      queryClient.query.mockRejectedValue(
        new Error(`error context: ${MTLS_PARAMS.sslKey}`),
      );
      pool.connect.mockResolvedValue(queryClient);

      let caughtErr: Error | undefined;
      try { await provider.query('SELECT 1'); } catch (e) { caughtErr = e as Error; }
      expect(caughtErr).toBeDefined();
      expect(caughtErr!.message).not.toContain('SECRET');
      expect(caughtErr!.message).not.toContain('PRIVATE KEY');
    });
  });

  describe('disconnect()', () => {
    it('ends the pool', async () => {
      const pool = setupPool();
      await provider.connect(MTLS_PARAMS);
      await provider.disconnect();
      expect(pool.end).toHaveBeenCalled();
    });

    it('idempotent — second disconnect does not throw', async () => {
      setupPool();
      await provider.connect(MTLS_PARAMS);
      await provider.disconnect();
      await expect(provider.disconnect()).resolves.not.toThrow();
    });

    it('after disconnect, ping returns false (pool gone)', async () => {
      setupPool();
      await provider.connect(MTLS_PARAMS);
      await provider.disconnect();
      expect(await provider.ping()).toBe(false);
    });

    it('after disconnect, query throws not-connected', async () => {
      setupPool();
      await provider.connect(MTLS_PARAMS);
      await provider.disconnect();
      await expect(provider.query('SELECT 1')).rejects.toThrow('not connected');
    });
  });

  describe('ping()', () => {
    it('returns false when not connected', async () => {
      expect(await provider.ping()).toBe(false);
    });

    it('returns true when pool SELECT 1 succeeds', async () => {
      const pool = setupPool();
      await provider.connect(MTLS_PARAMS);

      const pingClient = makeClient();
      pool.connect.mockResolvedValue(pingClient);
      expect(await provider.ping()).toBe(true);
    });

    it('returns false when pool.connect() rejects', async () => {
      const pool = setupPool();
      await provider.connect(MTLS_PARAMS);

      pool.connect.mockRejectedValue(new Error('pool exhausted'));
      expect(await provider.ping()).toBe(false);
    });

    it('returns false after disconnect', async () => {
      setupPool();
      await provider.connect(MTLS_PARAMS);
      await provider.disconnect();
      expect(await provider.ping()).toBe(false);
    });
  });

  describe('key-material invariant', () => {
    it('providerType is secure-postgres', () => {
      expect(provider.providerType).toBe('secure-postgres');
    });

    it('Pool constructor args do not log sslKey — it is passed to driver only', async () => {
      // Verify sslKey IS passed to the pool (expected driver call)
      // but asserting it is not LEAKED anywhere else is done via sanitize tests above
      setupPool();
      await provider.connect(MTLS_PARAMS);
      const constructorArgs = MockPool.mock.calls[0][0] as any;
      // Key goes to the driver — this is correct and expected
      expect(constructorArgs.ssl.key).toBe(MTLS_PARAMS.sslKey);
      // Verify no password field in pool config for mTLS (mTLS doesn't use password auth)
      expect(constructorArgs.password).toBeUndefined();
    });
  });
});
