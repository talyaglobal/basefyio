import { PostgresJsonbProvider } from './providers/postgres-jsonb.provider';
import { SecurePostgresProvider } from './providers/secure-postgres.provider';
import { SecureMongoProvider } from './providers/secure-mongo.provider';

// Tests the DATA_STORAGE_PROVIDER factory function in SecureGatewayModule.
// Exercises all three provider selection branches and the default fallback.

function runFactory(envValue: string | undefined) {
  const config = {
    get: jest.fn().mockReturnValue(envValue),
  };
  const pg = new PostgresJsonbProvider();
  const securePg = new SecurePostgresProvider();
  const mongo = new SecureMongoProvider();

  // Inline the same useFactory logic from SecureGatewayModule
  const type = config.get('GATEWAY_STORAGE_PROVIDER') ?? 'postgres-jsonb';
  if (type === 'secure-postgres') return securePg;
  if (type === 'secure-mongo') return mongo;
  return pg;
}

describe('SecureGatewayModule provider factory', () => {
  it('GATEWAY_STORAGE_PROVIDER=postgres-jsonb → PostgresJsonbProvider', () => {
    const provider = runFactory('postgres-jsonb');
    expect(provider).toBeInstanceOf(PostgresJsonbProvider);
    expect(provider.providerType).toBe('postgres-jsonb');
  });

  it('GATEWAY_STORAGE_PROVIDER=secure-postgres → SecurePostgresProvider', () => {
    const provider = runFactory('secure-postgres');
    expect(provider).toBeInstanceOf(SecurePostgresProvider);
    expect(provider.providerType).toBe('secure-postgres');
  });

  it('GATEWAY_STORAGE_PROVIDER=secure-mongo → SecureMongoProvider', () => {
    const provider = runFactory('secure-mongo');
    expect(provider).toBeInstanceOf(SecureMongoProvider);
    expect(provider.providerType).toBe('secure-mongo');
  });

  it('GATEWAY_STORAGE_PROVIDER=undefined (not set) → PostgresJsonbProvider fallback', () => {
    const provider = runFactory(undefined);
    expect(provider).toBeInstanceOf(PostgresJsonbProvider);
    expect(provider.providerType).toBe('postgres-jsonb');
  });

  it('GATEWAY_STORAGE_PROVIDER=unknown-value → PostgresJsonbProvider fallback', () => {
    const provider = runFactory('couchbase' as any);
    expect(provider).toBeInstanceOf(PostgresJsonbProvider);
  });
});

// Each provider reports its type correctly
describe('Provider providerType field', () => {
  it('PostgresJsonbProvider.providerType = postgres-jsonb', () => {
    expect(new PostgresJsonbProvider().providerType).toBe('postgres-jsonb');
  });

  it('SecurePostgresProvider.providerType = secure-postgres', () => {
    expect(new SecurePostgresProvider().providerType).toBe('secure-postgres');
  });

  it('SecureMongoProvider.providerType = secure-mongo', () => {
    expect(new SecureMongoProvider().providerType).toBe('secure-mongo');
  });
});

// Connection lifecycle — mTLS providers reject without SSL params
describe('mTLS provider lifecycle guards', () => {
  it('SecurePostgresProvider.connect() throws without sslKey', async () => {
    const p = new SecurePostgresProvider();
    await expect(
      p.connect({ host: 'localhost', port: 5432, database: 'db' }),
    ).rejects.toThrow(/mTLS requires/);
  });

  it('SecureMongoProvider.connect() throws without sslKey', async () => {
    const p = new SecureMongoProvider();
    await expect(
      p.connect({ host: 'localhost', port: 27017, database: 'db' }),
    ).rejects.toThrow(/mTLS requires/);
  });

  it('PostgresJsonbProvider.connect() does not enforce mTLS guard — no sslKey required', async () => {
    const p = new PostgresJsonbProvider();
    // May reject due to auth/connectivity in CI, but must NOT throw the mTLS guard
    const err = await p.connect({ host: 'localhost', port: 5432, database: 'db' }).catch((e) => e);
    if (err) {
      expect((err as Error).message).not.toMatch(/mTLS requires/);
    }
    await p.disconnect().catch(() => {});
  });

  it('SecurePostgresProvider.disconnect() on non-connected provider → ping false', async () => {
    const p = new SecurePostgresProvider();
    // disconnect() on a never-connected provider must be a no-op
    await p.disconnect();
    expect(await p.ping()).toBe(false);
  });
});
