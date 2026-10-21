import { ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import { Readable, pipeline as pipelineCb } from 'stream';
import * as Minio from 'minio';
import type { BackupArtifactKind, BackupCopyStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StorageService } from '../../storage/storage.service';
import { ENCRYPTED_SUFFIX, createEncryptStream, encryptedSize, getBackupKey } from './backup-crypto';
import { envInt } from './backup-env';

/** Local buckets whose contents are worth a copy elsewhere. */
export const AUTO_BACKUP_BUCKET = 'bf-platform-auto-backups';
export const PITR_BUCKET = 'bf-platform-pitr';
const CLUSTER_BASE_PREFIX = '_cluster/base/';
const CLUSTER_WAL_PREFIX = '_cluster/wal/';

/** Rows older than this are pruned by the nightly reconcile; the remote bucket keeps the objects. */
const COPY_RECORD_RETENTION_DAYS = 90;

export interface OffsiteConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  region: string;
  pathStyle: boolean;
  bucket: string;
  /** Key prefix inside the bucket, always ending in "/" or empty. */
  prefix: string;
  timeoutMs: number;
  encrypt: boolean;
}

export type OffsiteSetup =
  | { kind: 'disabled' }
  | { kind: 'misconfigured'; reason: string }
  | { kind: 'enabled'; config: OffsiteConfig; key: Buffer | null };

/**
 * Read BACKUP_S3_* from the environment.
 *
 * Nothing leaves the server unencrypted by accident: with the S3 variables
 * set but no BACKUP_ENC_KEY, the service refuses to run unless the operator
 * says BACKUP_OFFSITE_ALLOW_PLAINTEXT=true in so many words.
 */
export function readOffsiteSetup(env: NodeJS.ProcessEnv, key: Buffer | null): OffsiteSetup {
  const endpointRaw = env.BACKUP_S3_ENDPOINT?.trim();
  const bucket = env.BACKUP_S3_BUCKET?.trim();
  const accessKey = env.BACKUP_S3_ACCESS_KEY?.trim();
  const secretKey = env.BACKUP_S3_SECRET_KEY?.trim();

  if (!endpointRaw && !bucket && !accessKey && !secretKey) return { kind: 'disabled' };
  if (!endpointRaw || !bucket || !accessKey || !secretKey) {
    return {
      kind: 'misconfigured',
      reason:
        'BACKUP_S3_ENDPOINT, BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY and BACKUP_S3_SECRET_KEY must all be set',
    };
  }

  let url: URL;
  try {
    url = new URL(endpointRaw.includes('://') ? endpointRaw : `https://${endpointRaw}`);
  } catch {
    return { kind: 'misconfigured', reason: 'BACKUP_S3_ENDPOINT is not a valid URL' };
  }

  const allowPlaintext = env.BACKUP_OFFSITE_ALLOW_PLAINTEXT?.trim().toLowerCase() === 'true';
  if (!key && !allowPlaintext) {
    return {
      kind: 'misconfigured',
      reason:
        'BACKUP_ENC_KEY is not set, so off-site copies stay disabled until a key exists ' +
        '(or BACKUP_OFFSITE_ALLOW_PLAINTEXT=true explicitly allows unencrypted copies)',
    };
  }

  const useSSL = url.protocol !== 'http:';
  const port = url.port ? Number.parseInt(url.port, 10) : useSSL ? 443 : 80;
  let prefix = (env.BACKUP_S3_PREFIX ?? 'basefyio/').trim().replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';

  return {
    kind: 'enabled',
    key,
    config: {
      endPoint: url.hostname,
      port,
      useSSL,
      accessKey,
      secretKey,
      region: env.BACKUP_S3_REGION?.trim() || 'us-east-1',
      pathStyle: env.BACKUP_S3_PATH_STYLE?.trim().toLowerCase() !== 'false',
      bucket,
      prefix,
      timeoutMs: envInt('BACKUP_S3_TIMEOUT_MS', 600_000, env),
      encrypt: !!key,
    },
  };
}

/** Where a local object lands in the remote bucket. Mirrors the local layout so an operator recognises it. */
export function remoteKeyFor(prefix: string, localBucket: string, localKey: string, encrypted: boolean): string {
  const base =
    localBucket === AUTO_BACKUP_BUCKET
      ? `auto-backups/${localKey}`
      : localBucket === PITR_BUCKET
        ? `pitr/${localKey}`
        : `${localBucket}/${localKey}`;
  return `${prefix}${base}${encrypted ? ENCRYPTED_SUFFIX : ''}`;
}

export function kindForLocalKey(localBucket: string, localKey: string): BackupArtifactKind {
  if (localBucket === AUTO_BACKUP_BUCKET) return 'AUTO_BACKUP';
  if (localKey.startsWith(CLUSTER_BASE_PREFIX)) return 'PITR_CLUSTER_BASE';
  if (localKey.startsWith(CLUSTER_WAL_PREFIX)) return 'PITR_WAL';
  return 'PITR_PROJECT_BASE';
}

/** Project-scoped keys start with the project id; cluster artifacts have none. */
export function projectIdForLocalKey(localKey: string): string | null {
  if (localKey.startsWith('_cluster/')) return null;
  const first = localKey.split('/')[0];
  return first || null;
}

export interface CopyInput {
  kind: BackupArtifactKind;
  projectId?: string | null;
  localBucket: string;
  localKey: string;
}

export type CopyOutcome = 'disabled' | 'skipped' | 'uploaded' | 'failed';

export interface ReconcileReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scanned: number;
  alreadyPresent: number;
  copied: number;
  failed: number;
  bytes: number;
  perKind: Record<string, { copied: number; failed: number }>;
}

export interface OffsiteHealth {
  enabled: boolean;
  encrypted: boolean;
  misconfigured: boolean;
  reason: string | null;
  endpoint: string | null;
  bucket: string | null;
  copies: Record<string, { status: BackupCopyStatus; createdAt: string; encrypted: boolean; error: string | null }>;
}

/**
 * Copies backup artifacts to an S3-compatible bucket somewhere else.
 *
 * Off until BACKUP_S3_ENDPOINT is set. Every upload is best-effort — a slow or
 * missing remote never fails the backup that produced the artifact — and the
 * nightly {@link reconcile} copies whatever a fast-path upload missed, so the
 * remote set converges on the local one.
 *
 * The service never deletes from the remote bucket. Retention there is the
 * bucket's lifecycle rule, and the credentials can be write-only, so a host
 * that is compromised cannot erase its own backups.
 */
@Injectable()
export class BackupOffsiteService implements OnModuleInit {
  private readonly logger = new Logger(BackupOffsiteService.name);
  private readonly setup: OffsiteSetup;
  private readonly client: Minio.Client | null;
  private reconciling = false;
  private bucketChecked = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {
    this.setup = readOffsiteSetup(process.env, getBackupKey());
    this.client =
      this.setup.kind === 'enabled'
        ? new Minio.Client({
            endPoint: this.setup.config.endPoint,
            port: this.setup.config.port,
            useSSL: this.setup.config.useSSL,
            accessKey: this.setup.config.accessKey,
            secretKey: this.setup.config.secretKey,
            region: this.setup.config.region,
            pathStyle: this.setup.config.pathStyle,
          })
        : null;
  }

  async onModuleInit() {
    if (this.setup.kind === 'disabled') {
      this.logger.log('Off-site backup copies: disabled (BACKUP_S3_ENDPOINT not set)');
      return;
    }
    if (this.setup.kind === 'misconfigured') {
      this.logger.error(`Off-site backup copies are NOT running: ${this.setup.reason}`);
      await this.prisma.rootAlert
        .create({
          data: {
            kind: 'backup.offsite_misconfigured',
            severity: 'HIGH',
            title: 'Off-site backup copies are not running',
            message: this.setup.reason,
          },
        })
        .catch(() => undefined);
      return;
    }
    const c = this.setup.config;
    this.logger.log(
      `Off-site backup copies: enabled → ${c.endPoint}/${c.bucket}/${c.prefix} (${c.encrypt ? 'encrypted' : 'PLAINTEXT — allowed by BACKUP_OFFSITE_ALLOW_PLAINTEXT'})`,
    );
  }

  isEnabled(): boolean {
    return this.setup.kind === 'enabled' && this.client !== null;
  }

  isEncrypting(): boolean {
    return this.setup.kind === 'enabled' && this.setup.config.encrypt;
  }

  /** Copy a file that a job still has on disk. Never throws. */
  async copyFile(input: CopyInput & { localPath: string; size?: number }): Promise<CopyOutcome> {
    if (!this.isEnabled()) return 'disabled';
    let size = input.size;
    try {
      if (size == null) size = (await stat(input.localPath)).size;
    } catch (err: any) {
      await this.record(input, null, 0, this.isEncrypting(), 'FAILED', `cannot stat ${input.localPath}: ${err.message}`);
      return 'failed';
    }
    const plainSize = size;
    return this.upload(input, plainSize, () => createReadStream(input.localPath));
  }

  /** Copy an object already in the local MinIO (used by reconcile). Never throws. */
  async copyFromLocalObject(input: CopyInput): Promise<CopyOutcome> {
    if (!this.isEnabled()) return 'disabled';
    let size: number;
    let open: () => Promise<Readable>;
    try {
      const { stat: st } = await this.storage.getPlatformObject(input.localBucket, input.localKey);
      size = st.size;
      open = async () => (await this.storage.getPlatformObject(input.localBucket, input.localKey)).stream;
    } catch (err: any) {
      await this.record(input, null, 0, this.isEncrypting(), 'FAILED', `cannot read local object: ${err.message}`);
      return 'failed';
    }
    return this.upload(input, size, open);
  }

  private async upload(
    input: CopyInput,
    plainSize: number,
    open: () => Readable | Promise<Readable>,
  ): Promise<CopyOutcome> {
    if (this.setup.kind !== 'enabled' || !this.client) return 'disabled';
    const { config } = this.setup;
    // An archive already encrypted at rest (BACKUP_ENCRYPT_LOCAL) goes up as it
    // is — wrapping it a second time would leave two formats to undo later.
    const alreadyEncrypted = input.localKey.endsWith(ENCRYPTED_SUFFIX);
    const key = alreadyEncrypted ? null : this.setup.key;
    const encrypted = alreadyEncrypted || !!key;
    const remoteKey = remoteKeyFor(config.prefix, input.localBucket, input.localKey, !!key);
    // WAL segments are small and arrive every few minutes; a stuck one must not hold the shipper for ten.
    const timeoutMs = input.kind === 'PITR_WAL' ? Math.min(config.timeoutMs, 120_000) : config.timeoutMs;

    try {
      await this.ensureRemoteBucket();
      if (await this.remoteHasPlainSize(remoteKey, plainSize, !!key)) {
        await this.record(input, remoteKey, plainSize, encrypted, 'UPLOADED', null);
        return 'skipped';
      }

      const source = await open();
      let body: Readable = source;
      let pipeFailure: Promise<never> | null = null;
      if (key) {
        const enc = createEncryptStream(key);
        pipeFailure = new Promise<never>((_, reject) => {
          pipelineCb(source, enc, (err) => {
            if (err) reject(err);
          });
        });
        pipeFailure.catch(() => undefined);
        body = enc;
      }

      const totalSize = key ? encryptedSize(plainSize) : plainSize;
      const meta: Record<string, string> = {
        'Content-Type': 'application/octet-stream',
        'x-amz-meta-bf-enc': encrypted ? 'aes-256-gcm-v1' : 'none',
        'x-amz-meta-bf-plain-size': String(plainSize),
        'x-amz-meta-bf-kind': input.kind,
        'x-amz-meta-bf-source': `${input.localBucket}/${input.localKey}`,
      };

      const put = this.client.putObject(config.bucket, remoteKey, body, totalSize, meta);
      await this.withTimeout(
        pipeFailure ? Promise.race([put, pipeFailure]) : put,
        timeoutMs,
        () => source.destroy(new Error(`off-site upload timed out after ${timeoutMs} ms`)),
      );

      await this.record(input, remoteKey, plainSize, encrypted, 'UPLOADED', null);
      this.logger.log(`Off-site copy stored: ${remoteKey} (${plainSize} bytes${encrypted ? ', encrypted' : ''})`);
      return 'uploaded';
    } catch (err: any) {
      const message = String(err?.message || err).slice(0, 1000);
      this.logger.warn(`Off-site copy failed for ${input.localBucket}/${input.localKey}: ${message}`);
      await this.record(input, remoteKey, plainSize, encrypted, 'FAILED', message);
      return 'failed';
    }
  }

  private withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          onTimeout();
        } catch {
          // destroying an already-closed stream is harmless
        }
        reject(new Error(`timed out after ${ms} ms`));
      }, ms);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer)) as Promise<T>;
  }

  private async ensureRemoteBucket(): Promise<void> {
    if (this.bucketChecked || this.setup.kind !== 'enabled' || !this.client) return;
    this.bucketChecked = true;
    const { bucket, region } = this.setup.config;
    try {
      const exists = await this.client.bucketExists(bucket);
      if (!exists) await this.client.makeBucket(bucket, region);
    } catch (err: any) {
      // Write-only credentials cannot list or create buckets; the first putObject will say if the bucket is really missing.
      this.logger.warn(`Could not confirm the off-site bucket "${bucket}": ${err?.message}`);
    }
  }

  private async remoteHasPlainSize(remoteKey: string, plainSize: number, encrypted: boolean): Promise<boolean> {
    if (this.setup.kind !== 'enabled' || !this.client) return false;
    try {
      const st = await this.client.statObject(this.setup.config.bucket, remoteKey);
      const meta: Record<string, unknown> = (st as any).metaData ?? {};
      const recorded = meta['bf-plain-size'] ?? meta['x-amz-meta-bf-plain-size'];
      if (recorded != null) return Number(recorded) === plainSize;
      return st.size === (encrypted ? encryptedSize(plainSize) : plainSize);
    } catch {
      return false;
    }
  }

  private async record(
    input: CopyInput,
    remoteKey: string | null,
    plainBytes: number,
    encrypted: boolean,
    status: BackupCopyStatus,
    error: string | null,
  ): Promise<void> {
    if (this.setup.kind !== 'enabled') return;
    const remoteBucket = this.setup.config.bucket;
    const data = {
      kind: input.kind,
      projectId: input.projectId ?? null,
      remoteBucket,
      remoteKey: remoteKey ?? remoteKeyFor(this.setup.config.prefix, input.localBucket, input.localKey, encrypted),
      plainBytes: BigInt(Math.max(0, Math.floor(plainBytes))),
      encrypted,
      status,
      error,
      createdAt: new Date(),
    };
    await this.prisma.backupOffsiteCopy
      .upsert({
        where: { localBucket_localKey: { localBucket: input.localBucket, localKey: input.localKey } },
        update: data,
        create: { ...data, localBucket: input.localBucket, localKey: input.localKey },
      })
      .catch((err: any) => this.logger.warn(`Off-site copy record not written: ${err?.message}`));
  }

  // ── Reconcile ──────────────────────────────────────────────────────────────

  /**
   * Copy whatever the remote bucket is missing. Runs after the nightly backup
   * jobs (02:00 PITR, 03:00 archives, 04:30 cleanup) so the remote set
   * catches up with the night's artifacts even when a fast-path upload failed.
   */
  @Cron('0 5 * * *')
  async reconcile(): Promise<ReconcileReport | null> {
    if (!this.isEnabled() || this.setup.kind !== 'enabled' || !this.client) return null;
    if (this.reconciling) {
      this.logger.warn('Off-site reconcile is already running; skipping this run');
      return null;
    }
    this.reconciling = true;
    const started = Date.now();
    const report: ReconcileReport = {
      startedAt: new Date(started).toISOString(),
      finishedAt: '',
      durationMs: 0,
      scanned: 0,
      alreadyPresent: 0,
      copied: 0,
      failed: 0,
      bytes: 0,
      perKind: {},
    };
    const { prefix, encrypt } = this.setup.config;

    try {
      const remote = await this.listRemoteKeys();
      const locals = await this.listLocalArtifacts();
      report.scanned = locals.length;

      for (const item of locals) {
        const encryptHere = encrypt && !item.localKey.endsWith(ENCRYPTED_SUFFIX);
        const expected = remoteKeyFor(prefix, item.localBucket, item.localKey, encryptHere);
        // A copy made under the other encryption setting still counts as present.
        const alternate = encryptHere
          ? expected.slice(0, -ENCRYPTED_SUFFIX.length)
          : expected + ENCRYPTED_SUFFIX;
        if (remote.has(expected) || remote.has(alternate)) {
          report.alreadyPresent++;
          continue;
        }
        const outcome = await this.copyFromLocalObject(item);
        const bucket = (report.perKind[item.kind] ??= { copied: 0, failed: 0 });
        if (outcome === 'uploaded' || outcome === 'skipped') {
          report.copied++;
          report.bytes += item.size;
          bucket.copied++;
        } else {
          report.failed++;
          bucket.failed++;
        }
      }

      report.finishedAt = new Date().toISOString();
      report.durationMs = Date.now() - started;
      await this.writeManifest(report);

      const cutoff = new Date(Date.now() - COPY_RECORD_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      await this.prisma.backupOffsiteCopy.deleteMany({ where: { createdAt: { lt: cutoff } } }).catch(() => undefined);

      this.logger.log(
        `Off-site reconcile: ${report.copied} copied, ${report.alreadyPresent} already present, ${report.failed} failed (${report.scanned} scanned, ${Math.round(report.durationMs / 1000)} s)`,
      );
    } catch (err: any) {
      this.logger.error(`Off-site reconcile failed: ${err?.message}`);
      report.finishedAt = new Date().toISOString();
      report.durationMs = Date.now() - started;
    } finally {
      this.reconciling = false;
    }
    return report;
  }

  /** Start a reconcile right away — after configuring the bucket, rather than waiting for 05:00. ROOT only. */
  async reconcileNow(userId: string): Promise<{ message: string }> {
    const actor = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (actor?.role !== 'ROOT') {
      throw new ForbiddenException('Only ROOT can trigger an off-site reconcile');
    }
    if (!this.isEnabled()) {
      return {
        message:
          this.setup.kind === 'misconfigured'
            ? `Off-site copies are not configured correctly: ${this.setup.reason}`
            : 'Off-site copies are disabled (BACKUP_S3_ENDPOINT is not set)',
      };
    }
    if (this.reconciling) return { message: 'An off-site reconcile is already running.' };
    void this.reconcile().catch((err: any) => this.logger.error(`Manual off-site reconcile failed: ${err?.message}`));
    return { message: 'Off-site reconcile started; it completes in the background.' };
  }

  private async listLocalArtifacts(): Promise<Array<CopyInput & { size: number }>> {
    const out: Array<CopyInput & { size: number }> = [];
    for (const bucket of [AUTO_BACKUP_BUCKET, PITR_BUCKET]) {
      await this.storage.ensurePlatformBucket(bucket).catch(() => undefined);
      const objects: { name: string; size: number }[] = await this.storage
        .listPlatformObjects(bucket, '')
        .catch(() => []);
      for (const o of objects) {
        if (!o.name) continue;
        out.push({
          kind: kindForLocalKey(bucket, o.name),
          projectId: projectIdForLocalKey(o.name),
          localBucket: bucket,
          localKey: o.name,
          size: o.size,
        });
      }
    }
    return out;
  }

  private listRemoteKeys(): Promise<Set<string>> {
    if (this.setup.kind !== 'enabled' || !this.client) return Promise.resolve(new Set());
    const { bucket, prefix } = this.setup.config;
    const client = this.client;
    const collect = (p: string) =>
      new Promise<string[]>((resolve, reject) => {
        const names: string[] = [];
        const stream = client.listObjectsV2(bucket, p, true);
        stream.on('data', (obj: { name?: string }) => {
          if (obj.name) names.push(obj.name);
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(names));
      });
    return Promise.all([collect(`${prefix}auto-backups/`), collect(`${prefix}pitr/`)]).then(
      ([a, b]) => new Set([...a, ...b]),
    );
  }

  private async writeManifest(report: ReconcileReport): Promise<void> {
    if (this.setup.kind !== 'enabled' || !this.client) return;
    const { bucket, prefix } = this.setup.config;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const body = Buffer.from(JSON.stringify(report, null, 2));
    await this.client
      .putObject(bucket, `${prefix}manifests/${stamp}.json`, body, body.length, {
        'Content-Type': 'application/json',
      })
      .catch((err: any) => this.logger.warn(`Off-site manifest not written: ${err?.message}`));
  }

  // ── Dashboard ──────────────────────────────────────────────────────────────

  async healthForProject(projectId: string): Promise<OffsiteHealth> {
    const enabled = this.isEnabled();
    const copies: OffsiteHealth['copies'] = {};
    if (enabled) {
      const rows = await this.prisma.backupOffsiteCopy.findMany({
        where: { projectId },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      for (const r of rows) {
        copies[r.localKey] = {
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          encrypted: r.encrypted,
          error: r.error,
        };
      }
    }
    return {
      enabled,
      encrypted: this.isEncrypting(),
      misconfigured: this.setup.kind === 'misconfigured',
      reason: this.setup.kind === 'misconfigured' ? this.setup.reason : null,
      endpoint: this.setup.kind === 'enabled' ? this.setup.config.endPoint : null,
      bucket: this.setup.kind === 'enabled' ? this.setup.config.bucket : null,
      copies,
    };
  }
}
