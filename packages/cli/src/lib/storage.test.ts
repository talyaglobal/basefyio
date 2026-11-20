import { describe, expect, it } from 'vitest';
import { awsEnvLines, bucketLabel, connectionLines, keyRows, validateBucketName } from './storage';

const created = {
  id: 'k1',
  name: 'writer',
  accessKeyId: 'BFS3ABCDEFGHIJKLMNOP',
  secretLast4: 'wxyz',
  createdAt: '2026-11-20T08:00:00.000Z',
  secretAccessKey: 'abcdefghijklmnopqrstuvwxyz0123456789wxyz',
  endpoint: 'https://storage.basefyio.com',
  region: 'us-east-1',
  pathStyle: true,
  buckets: [{ name: 'docs', physical: 'bf-acme-docs' }],
};

describe('basefyio storage helpers', () => {
  it('validates bucket names like the API', () => {
    expect(validateBucketName('invoices')).toBeNull();
    for (const bad of ['ab', '-abc', 'abc-', 'a_b_c', 'x'.repeat(64)]) expect(validateBucketName(bad)).not.toBeNull();
  });

  it('lists keys with the last four of the secret only', () => {
    const rows = keyRows([created]);
    expect(rows[0]).toEqual(['k1', 'writer', 'BFS3ABCDEFGHIJKLMNOP', '••••••••wxyz', '2026-11-20']);
    expect(JSON.stringify(rows)).not.toContain(created.secretAccessKey);
  });

  it('status shows endpoint, region and path-style, never a secret', () => {
    const lines = connectionLines({
      enabled: true,
      unavailableReason: null,
      endpoint: created.endpoint,
      region: 'us-east-1',
      pathStyle: true,
      buckets: created.buckets,
      unreachable: [],
      maxKeys: 5,
    });
    expect(Object.fromEntries(lines)).toMatchObject({ Endpoint: 'https://storage.basefyio.com', Region: 'us-east-1' });
    expect(JSON.stringify(lines)).not.toContain(created.secretAccessKey);
  });

  it('says why keys are unavailable', () => {
    const lines = connectionLines({
      enabled: false,
      unavailableReason: 'S3 access keys are not enabled on this server.',
      endpoint: 'x',
      region: 'us-east-1',
      pathStyle: true,
      buckets: [],
      unreachable: [],
      maxKeys: 5,
    });
    expect(lines[0][1]).toMatch(/not enabled on this server/);
  });

  it('names the physical bucket an S3 client must use', () => {
    expect(bucketLabel({ name: 'docs', physical: 'bf-acme-docs' })).toBe('docs  →  bf-acme-docs');
    expect(bucketLabel({ name: null, physical: 'bf-old-x' })).toBe('bf-old-x');
  });

  it('prints the AWS SDK environment for a new key', () => {
    expect(awsEnvLines(created)).toEqual([
      'AWS_ACCESS_KEY_ID=BFS3ABCDEFGHIJKLMNOP',
      `AWS_SECRET_ACCESS_KEY=${created.secretAccessKey}`,
      'AWS_REGION=us-east-1',
      'AWS_ENDPOINT_URL_S3=https://storage.basefyio.com',
    ]);
  });
});
