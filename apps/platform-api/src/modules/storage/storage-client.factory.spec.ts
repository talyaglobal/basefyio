const clientCtor = jest.fn();

jest.mock('minio', () => ({
  Client: jest.fn().mockImplementation(function (this: unknown, opts: unknown) {
    clientCtor(opts);
    return { opts };
  }),
}));

import { buildStorageClients, normaliseBucketPrefix, parseEndpoint } from './storage-client.factory';

function cfg(values: Record<string, unknown> = {}) {
  return { get: (key: string) => values[key] } as any;
}

beforeEach(() => clientCtor.mockReset());

describe('buildStorageClients — minio driver (the default)', () => {
  it('reproduces the original client construction when nothing is configured', () => {
    const set = buildStorageClients(cfg());

    expect(set.driver).toBe('minio');
    expect(clientCtor).toHaveBeenCalledTimes(2);
    expect(clientCtor.mock.calls[0][0]).toEqual({
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
      accessKey: 'kolaybase',
      secretKey: 'kolaybase_secret',
    });
    expect(clientCtor.mock.calls[1][0]).toEqual({
      endPoint: 'localhost',
      port: 9000,
      useSSL: false,
      accessKey: 'kolaybase',
      secretKey: 'kolaybase_secret',
    });
    expect(set.publicEndpoint).toBe('localhost');
    expect(set.publicPort).toBe(9000);
    expect(set.publicSsl).toBe(false);
    expect(set.virtualHost).toBe(false);
    expect(set.supportsBucketPolicies).toBe(true);
    expect(set.bucketPrefix).toBe('bf-');
  });

  it('passes MINIO_* values through and reads publicSsl as the string "true"', () => {
    const set = buildStorageClients(
      cfg({
        'minio.endpoint': 'minio',
        'minio.port': 9000,
        'minio.useSsl': false,
        'minio.accessKey': 'root',
        'minio.secretKey': 'secret',
        'minio.publicEndpoint': 'storage.example.com',
        'minio.publicPort': 443,
        'minio.publicSsl': 'true',
      }),
    );

    expect(clientCtor.mock.calls[0][0]).toEqual({
      endPoint: 'minio',
      port: 9000,
      useSSL: false,
      accessKey: 'root',
      secretKey: 'secret',
    });
    expect(clientCtor.mock.calls[1][0]).toEqual({
      endPoint: 'storage.example.com',
      port: 443,
      useSSL: true,
      accessKey: 'root',
      secretKey: 'secret',
    });
    expect(set.publicSsl).toBe(true);
    expect(set.describe()).toContain('minio');
  });

  it('treats any publicSsl other than the string "true" as plain http, as before', () => {
    const set = buildStorageClients(cfg({ 'minio.publicSsl': 'false' }));
    expect(set.publicSsl).toBe(false);
    expect(clientCtor.mock.calls[1][0]).toMatchObject({ useSSL: false });
  });

  it('is case-insensitive about the driver name', () => {
    expect(buildStorageClients(cfg({ 'storage.driver': 'MinIO' })).driver).toBe('minio');
  });
});

describe('buildStorageClients — s3 driver', () => {
  const base = {
    'storage.driver': 's3',
    'storage.s3.accessKey': 'AKIA',
    'storage.s3.secretKey': 'shh',
    'storage.s3.useSsl': true,
    'storage.s3.pathStyle': true,
    'storage.s3.bucketPolicies': true,
  };

  it('maps an AWS URL endpoint with virtual-host addressing', () => {
    const set = buildStorageClients(
      cfg({
        ...base,
        'storage.s3.endpoint': 'https://s3.eu-central-1.amazonaws.com',
        'storage.s3.region': 'eu-central-1',
        'storage.s3.pathStyle': false,
      }),
    );

    expect(set.driver).toBe('s3');
    expect(clientCtor).toHaveBeenCalledTimes(2);
    expect(clientCtor.mock.calls[0][0]).toEqual({
      endPoint: 's3.eu-central-1.amazonaws.com',
      port: 443,
      useSSL: true,
      accessKey: 'AKIA',
      secretKey: 'shh',
      region: 'eu-central-1',
      pathStyle: false,
    });
    expect(set.virtualHost).toBe(true);
    expect(set.publicEndpoint).toBe('s3.eu-central-1.amazonaws.com');
    expect(set.publicPort).toBe(443);
    expect(set.publicSsl).toBe(true);
  });

  it('defaults a bare host to https/443 and path-style', () => {
    const set = buildStorageClients(
      cfg({ ...base, 'storage.s3.endpoint': 'fsn1.your-objectstorage.com', 'storage.s3.region': 'fsn1' }),
    );
    expect(clientCtor.mock.calls[0][0]).toMatchObject({
      endPoint: 'fsn1.your-objectstorage.com',
      port: 443,
      useSSL: true,
      region: 'fsn1',
      pathStyle: true,
    });
    expect(set.virtualHost).toBe(false);
  });

  it('honours an explicit port and S3_USE_SSL=false', () => {
    buildStorageClients(cfg({ ...base, 'storage.s3.endpoint': 'minio.internal:9000', 'storage.s3.useSsl': false }));
    expect(clientCtor.mock.calls[0][0]).toMatchObject({ endPoint: 'minio.internal', port: 9000, useSSL: false });
  });

  it('signs public URLs against S3_PUBLIC_ENDPOINT when it differs', () => {
    const set = buildStorageClients(
      cfg({
        ...base,
        'storage.s3.endpoint': 'https://internal.store:9000',
        'storage.s3.publicEndpoint': 'https://files.example.com',
      }),
    );
    expect(clientCtor.mock.calls[1][0]).toMatchObject({ endPoint: 'files.example.com', port: 443, useSSL: true });
    expect(set.publicEndpoint).toBe('files.example.com');
  });

  it('falls back to us-east-1 when no region is given', () => {
    buildStorageClients(cfg({ ...base, 'storage.s3.endpoint': 'https://x.r2.cloudflarestorage.com' }));
    expect(clientCtor.mock.calls[0][0]).toMatchObject({ region: 'us-east-1' });
  });

  it('records that the store has no bucket policies', () => {
    const set = buildStorageClients(
      cfg({ ...base, 'storage.s3.endpoint': 'https://x.r2.cloudflarestorage.com', 'storage.s3.bucketPolicies': false }),
    );
    expect(set.supportsBucketPolicies).toBe(false);
    expect(set.describe()).toContain('no bucket policies');
  });

  it('refuses to start without credentials and names what is missing', () => {
    expect(() =>
      buildStorageClients(cfg({ 'storage.driver': 's3', 'storage.s3.endpoint': 'https://s3.amazonaws.com' })),
    ).toThrow(/S3_ACCESS_KEY, S3_SECRET_KEY/);
    expect(() => buildStorageClients(cfg({ ...base }))).toThrow(/S3_ENDPOINT/);
    expect(clientCtor).not.toHaveBeenCalled();
  });

  it('refuses an unknown driver', () => {
    expect(() => buildStorageClients(cfg({ 'storage.driver': 'gcs' }))).toThrow(/Unknown STORAGE_DRIVER "gcs"/);
  });
});

describe('parseEndpoint', () => {
  it('parses URLs and bare hosts', () => {
    expect(parseEndpoint('https://a.b.c', false)).toEqual({ endPoint: 'a.b.c', port: 443, useSSL: true });
    expect(parseEndpoint('http://a.b.c', true)).toEqual({ endPoint: 'a.b.c', port: 80, useSSL: false });
    expect(parseEndpoint('a.b.c', true)).toEqual({ endPoint: 'a.b.c', port: 443, useSSL: true });
    expect(parseEndpoint('a.b.c', false)).toEqual({ endPoint: 'a.b.c', port: 80, useSSL: false });
    expect(parseEndpoint(' a.b.c:9000 ', true)).toEqual({ endPoint: 'a.b.c', port: 9000, useSSL: true });
  });

  it('rejects empty values and non-http schemes', () => {
    expect(() => parseEndpoint('', true)).toThrow(/S3_ENDPOINT is required/);
    expect(() => parseEndpoint('ftp://a.b.c', true)).toThrow(/http or https/);
  });
});

describe('normaliseBucketPrefix', () => {
  it('keeps the default and lowercases/cleans custom prefixes', () => {
    expect(normaliseBucketPrefix(undefined)).toBe('bf-');
    expect(normaliseBucketPrefix('bf-')).toBe('bf-');
    expect(normaliseBucketPrefix('Acme_BF-')).toBe('acme-bf-');
    expect(normaliseBucketPrefix('')).toBe('bf-');
  });
});
