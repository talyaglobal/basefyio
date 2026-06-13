/**
 * Integration tests for PostgresJsonbProvider against a real Postgres instance.
 *
 * Set TEST_GATEWAY_POSTGRES_URL to run these tests:
 *   TEST_GATEWAY_POSTGRES_URL=postgres://user:pass@localhost:5432/testdb npx jest postgres-jsonb
 *
 * All tests are skipped when the env var is absent.
 */

import { PostgresJsonbProvider } from './postgres-jsonb.provider';
import type { ConnectionParams } from '../data-storage-provider.interface';

const PG_URL = process.env.TEST_GATEWAY_POSTGRES_URL;
const describePg = PG_URL ? describe : describe.skip;

function parseUrl(url: string): ConnectionParams {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    database: u.pathname.replace(/^\//, ''),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
  };
}

describePg('PostgresJsonbProvider — integration (TEST_GATEWAY_POSTGRES_URL)', () => {
  let provider: PostgresJsonbProvider;
  let params: ConnectionParams;

  beforeAll(() => {
    params = parseUrl(PG_URL!);
  });

  beforeEach(() => {
    provider = new PostgresJsonbProvider();
  });

  afterEach(async () => {
    await provider.disconnect().catch(() => {});
  });

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  it('connect() succeeds and ping() returns true', async () => {
    await provider.connect(params);
    expect(await provider.ping()).toBe(true);
  });

  it('disconnect() sets ping to false', async () => {
    await provider.connect(params);
    await provider.disconnect();
    expect(await provider.ping()).toBe(false);
  });

  it('disconnect() is idempotent — second call does not throw', async () => {
    await provider.connect(params);
    await provider.disconnect();
    await expect(provider.disconnect()).resolves.not.toThrow();
  });

  it('reconnect after disconnect works', async () => {
    await provider.connect(params);
    await provider.disconnect();
    await provider.connect(params);
    expect(await provider.ping()).toBe(true);
  });

  // ── Basic queries ───────────────────────────────────────────────────────────

  it('query("SELECT 1") returns a row', async () => {
    await provider.connect(params);
    const result = await provider.query('SELECT 1 AS n');
    expect(result.rowCount).toBeGreaterThanOrEqual(1);
    expect(result.rows[0]).toHaveProperty('n');
  });

  it('query("SELECT now()") returns current timestamp', async () => {
    await provider.connect(params);
    const result = await provider.query('SELECT now() AS ts');
    expect(result.rows[0]).toHaveProperty('ts');
  });

  // ── Parameterized queries ───────────────────────────────────────────────────

  it('parameterized query binds $1 correctly', async () => {
    await provider.connect(params);
    const result = await provider.query('SELECT $1::int AS n', [42]);
    expect(result.rows[0].n).toBe(42);
  });

  it('parameterized query binds multiple params', async () => {
    await provider.connect(params);
    const result = await provider.query(
      'SELECT $1::text AS a, $2::int AS b, $3::bool AS c',
      ['hello', 7, true],
    );
    expect(result.rows[0].a).toBe('hello');
    expect(result.rows[0].b).toBe(7);
    expect(result.rows[0].c).toBe(true);
  });

  it('parameterized query with null param', async () => {
    await provider.connect(params);
    const result = await provider.query('SELECT $1::text AS val', [null]);
    expect(result.rows[0].val).toBeNull();
  });

  // ── Concurrency ─────────────────────────────────────────────────────────────

  it('concurrent queries succeed — pool handles multiple clients', async () => {
    await provider.connect(params);
    const queries = Array.from({ length: 5 }, (_, i) =>
      provider.query('SELECT $1::int AS n', [i]),
    );
    const results = await Promise.all(queries);
    results.forEach((r, i) => {
      expect(r.rows[0].n).toBe(i);
    });
  });

  // ── Error handling ──────────────────────────────────────────────────────────

  it('syntax error → throws DatabaseError with sanitized message', async () => {
    await provider.connect(params);
    let caughtErr: Error | undefined;
    try { await provider.query('NOT VALID SQL !!!'); } catch (e) { caughtErr = e as Error; }
    expect(caughtErr).toBeInstanceOf(Error);
    expect(caughtErr!.name).toBe('DatabaseError');
    // Password/key material must not appear in sanitized error
    expect(caughtErr!.message).not.toMatch(/password=/i);
  });

  it('query on disconnected provider → throws not-connected', async () => {
    await expect(provider.query('SELECT 1')).rejects.toThrow('not connected');
  });

  // ── Connection pool limits ──────────────────────────────────────────────────

  it('rowCount reflects actual number of rows returned', async () => {
    await provider.connect(params);
    const result = await provider.query(
      'SELECT generate_series(1, 3) AS n',
    );
    expect(result.rowCount).toBe(3);
    expect(result.rows).toHaveLength(3);
  });
});
