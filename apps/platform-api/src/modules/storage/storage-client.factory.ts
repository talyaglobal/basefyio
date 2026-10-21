import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

/**
 * Which object store the API talks to.
 *
 *  - `minio` (default): the bundled MinIO container, configured by `MINIO_*`.
 *    This path reproduces the original client construction exactly.
 *  - `s3`: any S3-compatible store (AWS S3, Cloudflare R2, Hetzner Object
 *    Storage, a remote MinIO), configured by `S3_*`. The same client library is
 *    used; only the endpoint, region and addressing style change.
 */
export type StorageDriver = 'minio' | 's3';

export interface StorageClientSet {
  driver: StorageDriver;
  /** Internal data path (uploads, downloads, listings). */
  client: Minio.Client;
  /** Signs URLs against the host browsers reach, so the signature stays valid. */
  publicClient: Minio.Client;
  publicEndpoint: string;
  publicPort: number;
  publicSsl: boolean;
  /** Public URL shape: `https://<bucket>.<host>/<key>` when true, `https://<host>/<bucket>/<key>` when false. */
  virtualHost: boolean;
  /** Whether the store accepts anonymous bucket policies (`PutBucketPolicy`). Cloudflare R2 does not. */
  supportsBucketPolicies: boolean;
  /** Prefix of every physical bucket name; `bf-` unless `STORAGE_BUCKET_PREFIX` says otherwise. */
  bucketPrefix: string;
  /** One line for the boot log. */
  describe(): string;
}

export interface ParsedEndpoint {
  endPoint: string;
  port: number;
  useSSL: boolean;
}

export const DEFAULT_BUCKET_PREFIX = 'bf-';

/**
 * Accepts `https://s3.eu-central-1.amazonaws.com`, `fsn1.your-objectstorage.com`
 * or `minio:9000`. A scheme decides TLS; without one `defaultSsl` does, and the
 * port falls back to 443/80 accordingly.
 */
export function parseEndpoint(raw: string, defaultSsl: boolean): ParsedEndpoint {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    throw new Error('S3_ENDPOINT is required when STORAGE_DRIVER=s3');
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url: URL;
  try {
    url = new URL(hasScheme ? trimmed : `${defaultSsl ? 'https' : 'http'}://${trimmed}`);
  } catch {
    throw new Error(`S3_ENDPOINT "${trimmed}" is not a valid host or URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`S3_ENDPOINT must use http or https, got "${url.protocol.replace(/:$/, '')}"`);
  }
  const useSSL = hasScheme ? url.protocol === 'https:' : defaultSsl;
  const port = url.port ? Number(url.port) : useSSL ? 443 : 80;
  return { endPoint: url.hostname, port, useSSL };
}

/** Physical bucket names may only contain lowercase letters, digits and hyphens. */
export function normaliseBucketPrefix(raw: string | undefined): string {
  const clean = String(raw ?? DEFAULT_BUCKET_PREFIX)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  return clean || DEFAULT_BUCKET_PREFIX;
}

export function buildStorageClients(config: ConfigService): StorageClientSet {
  const driver = String(config.get<string>('storage.driver') || 'minio').toLowerCase();
  if (driver === 'minio') return buildMinio(config);
  if (driver === 's3') return buildS3(config);
  throw new Error(`Unknown STORAGE_DRIVER "${driver}" (expected "minio" or "s3")`);
}

function buildMinio(config: ConfigService): StorageClientSet {
  const accessKey = config.get<string>('minio.accessKey') || 'kolaybase';
  const secretKey = config.get<string>('minio.secretKey') || 'kolaybase_secret';
  const endpoint = config.get<string>('minio.endpoint') || 'localhost';
  const port = config.get<number>('minio.port') || 9000;

  const client = new Minio.Client({
    endPoint: endpoint,
    port,
    useSSL: config.get<boolean>('minio.useSsl') || false,
    accessKey,
    secretKey,
  });

  const publicEndpoint = config.get<string>('minio.publicEndpoint') || 'localhost';
  const publicPort = config.get<number>('minio.publicPort') || 9000;
  const publicSsl = config.get<string>('minio.publicSsl') === 'true';

  const publicClient = new Minio.Client({
    endPoint: publicEndpoint,
    port: publicPort,
    useSSL: publicSsl,
    accessKey,
    secretKey,
  });

  return {
    driver: 'minio',
    client,
    publicClient,
    publicEndpoint,
    publicPort,
    publicSsl,
    virtualHost: false,
    supportsBucketPolicies: true,
    bucketPrefix: normaliseBucketPrefix(config.get<string>('storage.bucketPrefix')),
    describe: () => `minio (${endpoint}:${port}, public ${publicEndpoint}:${publicPort})`,
  };
}

function buildS3(config: ConfigService): StorageClientSet {
  const endpoint = config.get<string>('storage.s3.endpoint') || '';
  const region = config.get<string>('storage.s3.region') || 'us-east-1';
  const accessKey = config.get<string>('storage.s3.accessKey') || '';
  const secretKey = config.get<string>('storage.s3.secretKey') || '';
  const useSsl = config.get<boolean>('storage.s3.useSsl') ?? true;
  const pathStyle = config.get<boolean>('storage.s3.pathStyle') ?? true;
  const publicEndpointRaw = config.get<string>('storage.s3.publicEndpoint') || '';
  const supportsBucketPolicies = config.get<boolean>('storage.s3.bucketPolicies') ?? true;

  const missing = [
    !endpoint && 'S3_ENDPOINT',
    !accessKey && 'S3_ACCESS_KEY',
    !secretKey && 'S3_SECRET_KEY',
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`STORAGE_DRIVER=s3 requires ${missing.join(', ')}`);
  }

  const internal = parseEndpoint(endpoint, useSsl);
  const pub = publicEndpointRaw ? parseEndpoint(publicEndpointRaw, useSsl) : internal;
  const shared = { accessKey, secretKey, region, pathStyle };

  const client = new Minio.Client({
    endPoint: internal.endPoint,
    port: internal.port,
    useSSL: internal.useSSL,
    ...shared,
  });
  const publicClient = new Minio.Client({
    endPoint: pub.endPoint,
    port: pub.port,
    useSSL: pub.useSSL,
    ...shared,
  });

  return {
    driver: 's3',
    client,
    publicClient,
    publicEndpoint: pub.endPoint,
    publicPort: pub.port,
    publicSsl: pub.useSSL,
    virtualHost: !pathStyle,
    supportsBucketPolicies,
    bucketPrefix: normaliseBucketPrefix(config.get<string>('storage.bucketPrefix')),
    describe: () =>
      `s3 (${internal.endPoint}:${internal.port}, region ${region}, ${pathStyle ? 'path-style' : 'virtual-host'}` +
      `${supportsBucketPolicies ? '' : ', no bucket policies'})`,
  };
}
