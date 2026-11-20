import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { roleAllows } from '../teams/role-permissions';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { ProjectActivityKind, ProjectActivityService } from '../projects/project-activity.service';
import { StorageService } from './storage.service';
import { MINIO_ADMIN, MinioAdmin, MinioAdminError } from './minio-admin.client';
import { GrantResult, computeGrantSet, s3KeyPolicy, s3KeyPolicyName } from './s3-key-policy';

const UPPER_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Uniform random string over `alphabet` (rejection sampling, no modulo bias). */
export function randomString(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < limit) out += alphabet[b % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Status values under which a project's keys keep working. A paused (sleeping) project's files stay reachable. */
const SERVING = new Set(['ACTIVE', 'PAUSED']);

export interface S3BucketRef {
  /** The dashboard name, when the physical name is under the project's prefix. */
  name: string | null;
  /** The name an S3 client uses. */
  physical: string;
}

export interface S3ConnectionInfo {
  enabled: boolean;
  /** Why keys cannot be created for this project, when they cannot. */
  unavailableReason: string | null;
  endpoint: string;
  region: string;
  pathStyle: true;
  buckets: S3BucketRef[];
  unreachable: Array<{ physical: string; reason: string }>;
  maxKeys: number;
}

export interface S3KeyView {
  id: string;
  name: string;
  accessKeyId: string;
  secretLast4: string;
  createdAt: string;
  createdBy: string | null;
}

export interface S3KeyCreated extends S3KeyView {
  /** Shown once. The platform does not keep it. */
  secretAccessKey: string;
  endpoint: string;
  region: string;
  pathStyle: true;
  buckets: S3BucketRef[];
}

/**
 * Project-scoped S3 access keys (feedback #225, GitHub #13).
 *
 * Each key is a MinIO IAM user with one canned policy per project (`bf-s3keys-<projectId>`)
 * that names the project's buckets by exact ARN (see s3-key-policy.ts for the collision rules).
 * The secret goes to the caller once and is not stored here. Keys are service-level
 * credentials: they bypass storage access rules, bucket limits and the upload quota check,
 * which is why managing them needs the team's credentials permission and `secrets:*` scopes.
 *
 * `S3_KEYS_ENABLED` gates creating keys. Listing, revoking, the bucket hooks and the sweeper
 * work whatever the switch says, so turning it off never leaves a key unmanageable.
 */
@Injectable()
export class S3KeysService implements OnModuleInit {
  private readonly logger = new Logger(S3KeysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
    @Inject(MINIO_ADMIN) private readonly admin: MinioAdmin,
    @Optional() private readonly leader?: CronLeaderService,
    @Optional() private readonly activity?: ProjectActivityService,
  ) {}

  onModuleInit(): void {
    this.storage.addBucketListener({
      beforeDelete: (projectId, physical) => this.beforeBucketDelete(projectId, physical),
      afterCreate: (projectId) => this.afterBucketCreate(projectId),
    });
  }

  // ── Settings ──────────────────────────────────────────────────────────

  private get enabled(): boolean {
    return this.config.get<boolean>('storage.s3Keys.enabled') === true;
  }

  private get maxKeys(): number {
    const n = Number(this.config.get('storage.s3Keys.maxPerProject'));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
  }

  private get region(): string {
    return this.config.get<string>('storage.s3Keys.region') || 'us-east-1';
  }

  /** What customers configure: S3_KEYS_PUBLIC_ENDPOINT, else the public MinIO host. */
  endpoint(): string {
    const explicit = (this.config.get<string>('storage.s3Keys.publicEndpoint') || '').trim().replace(/\/+$/, '');
    if (explicit) return explicit;
    const host = this.config.get<string>('minio.publicEndpoint') || 'localhost';
    const ssl = String(this.config.get('minio.publicSsl')) === 'true';
    const port = Number(this.config.get('minio.publicPort')) || (ssl ? 443 : 80);
    const defaultPort = ssl ? 443 : 80;
    return `${ssl ? 'https' : 'http'}://${host}${port === defaultPort ? '' : `:${port}`}`;
  }

  private unavailableReason(project: { id: string; slug: string; storageAuthz: string; status: string }): string | null {
    if (!this.enabled) return 'S3 access keys are not enabled on this server.';
    if (this.storage.driver !== 'minio') return 'S3 access keys need the bundled MinIO object store.';
    const allow = String(this.config.get('storage.s3Keys.projects') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (allow.length && !allow.includes(project.id) && !allow.includes(project.slug)) {
      return 'S3 access keys are not enabled for this project.';
    }
    if (!SERVING.has(project.status)) return 'The project is not active.';
    if (project.storageAuthz === 'rls') {
      return "This project authorises storage with database policies (storageAuthz 'rls'); an S3 key would write around them.";
    }
    return null;
  }

  // ── Routes ────────────────────────────────────────────────────────────

  async info(projectId: string, userId: string): Promise<S3ConnectionInfo> {
    const { project } = await this.access(projectId, userId);
    const reason = this.unavailableReason(project);
    const grant = await this.grantFor(project);
    return {
      enabled: reason === null,
      unavailableReason: reason,
      endpoint: this.endpoint(),
      region: this.region,
      pathStyle: true,
      buckets: this.refs(project, grant.granted),
      unreachable: grant.unreachable,
      maxKeys: this.maxKeys,
    };
  }

  async list(projectId: string, userId: string): Promise<S3KeyView[]> {
    await this.access(projectId, userId);
    const rows = await this.prisma.projectS3Key.findMany({
      where: { projectId, revokedAt: null },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => this.view(r));
  }

  async create(projectId: string, userId: string, rawName: unknown, via: 'session' | 'token' | 'mcp' = 'session'): Promise<S3KeyCreated> {
    const { project } = await this.access(projectId, userId, true);
    const reason = this.unavailableReason(project);
    if (reason) throw new ForbiddenException(reason);

    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || name.length > 60 || /[\u0000-\u001f]/.test(name)) {
      throw new BadRequestException('Give the key a name of 1–60 characters');
    }
    const active = await this.prisma.projectS3Key.count({ where: { projectId, revokedAt: null } });
    if (active >= this.maxKeys) {
      throw new ConflictException(`A project can have at most ${this.maxKeys} S3 access keys; revoke one first`);
    }

    // The policy first: a user attached to it reaches exactly the project's buckets from its first request.
    const grant = await this.writePolicy(project);

    const accessKeyId = `BFS3${randomString(UPPER_DIGITS, 16)}`;
    const secretAccessKey = randomString(ALNUM, 40);
    try {
      await this.admin.addUser(accessKeyId, secretAccessKey);
    } catch (err) {
      throw this.adminFailure('create', projectId, err);
    }
    try {
      await this.admin.attachPolicy(accessKeyId, s3KeyPolicyName(project.id));
    } catch (err) {
      await this.admin.removeUser(accessKeyId).catch(() => undefined);
      throw this.adminFailure('attach', projectId, err);
    }

    let row;
    try {
      row = await this.prisma.projectS3Key.create({
        data: { projectId, name, accessKeyId, secretLast4: secretAccessKey.slice(-4), createdBy: userId },
      });
    } catch (err) {
      // No row, no key: a MinIO user nobody can see or revoke must not survive.
      await this.admin.removeUser(accessKeyId).catch(() => undefined);
      throw err;
    }

    await this.audit(userId, via, 'storage.s3_key_created', row.id, { projectId, accessKeyId, name });
    await this.activity
      ?.append(projectId, {
        userId,
        kind: ProjectActivityKind.STORAGE_S3_KEY_CREATED,
        title: `S3 access key created: ${name}`,
        detail: accessKeyId,
      })
      .catch(() => undefined);
    this.logger.log(`S3 key ${accessKeyId} created for project ${projectId} by ${userId}`);
    return {
      ...this.view(row),
      secretAccessKey,
      endpoint: this.endpoint(),
      region: this.region,
      pathStyle: true,
      buckets: this.refs(project, grant.granted),
    };
  }

  /** The MinIO user goes first; the row is only marked once MinIO no longer knows the key. */
  async revoke(projectId: string, userId: string, keyId: string, via: 'session' | 'token' | 'mcp' = 'session'): Promise<{ revoked: true }> {
    await this.access(projectId, userId, true);
    const row = await this.prisma.projectS3Key.findFirst({ where: { id: keyId, projectId, revokedAt: null } });
    if (!row) throw new NotFoundException('S3 access key not found');
    try {
      await this.admin.removeUser(row.accessKeyId);
    } catch (err) {
      throw this.adminFailure('revoke', projectId, err);
    }
    await this.prisma.projectS3Key.updateMany({
      where: { id: row.id, revokedAt: null },
      data: { revokedAt: new Date(), revokedBy: userId },
    });
    await this.audit(userId, via, 'storage.s3_key_revoked', row.id, { projectId, accessKeyId: row.accessKeyId, name: row.name });
    await this.activity
      ?.append(projectId, {
        userId,
        kind: ProjectActivityKind.STORAGE_S3_KEY_REVOKED,
        title: `S3 access key revoked: ${row.name}`,
        detail: row.accessKeyId,
      })
      .catch(() => undefined);
    this.logger.log(`S3 key ${row.accessKeyId} revoked for project ${projectId} by ${userId}`);
    return { revoked: true };
  }

  // ── Policy upkeep ─────────────────────────────────────────────────────

  /** Rewrite the project's policy when it has keys; the bucket is left out before it goes. */
  private async beforeBucketDelete(projectId: string, physical: string): Promise<void> {
    if (!(await this.hasActiveKeys(projectId))) return;
    const project = await this.loadProject(projectId);
    if (!project) return;
    await this.writePolicy(project, physical).catch((err) => {
      throw this.adminFailure('policy update before bucket delete', projectId, err);
    });
  }

  private async afterBucketCreate(projectId: string): Promise<void> {
    if (!(await this.hasActiveKeys(projectId))) return;
    const project = await this.loadProject(projectId);
    if (project) await this.writePolicy(project);
  }

  /**
   * Every ten minutes on the cron leader: keys of a deleted (or vanished) project are removed
   * from MinIO; every other project with keys gets its policy rewritten, which repairs a failed
   * write after a bucket create and puts a deactivated project's keys on the deny-only policy.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async sweep(): Promise<{ removed: number; synced: number }> {
    if (this.leader && !this.leader.isLeader()) return { removed: 0, synced: 0 };
    const keys = await this.prisma.projectS3Key.findMany({
      where: { revokedAt: null },
      select: { id: true, projectId: true, accessKeyId: true },
    });
    if (!keys.length) return { removed: 0, synced: 0 };
    const ids = [...new Set(keys.map((k) => k.projectId))];
    const projects = await this.prisma.project.findMany({
      where: { id: { in: ids } },
      select: { id: true, slug: true, storagePrefix: true, status: true, storageAuthz: true, teamId: true },
    });
    const byId = new Map(projects.map((p) => [p.id, p]));
    let removed = 0;
    let synced = 0;
    for (const projectId of ids) {
      const project = byId.get(projectId);
      try {
        if (!project || project.status === 'DELETED') {
          for (const k of keys.filter((x) => x.projectId === projectId)) {
            await this.admin.removeUser(k.accessKeyId);
            const { count } = await this.prisma.projectS3Key.updateMany({
              where: { id: k.id, revokedAt: null },
              data: { revokedAt: new Date(), revokedBy: 'system:project-deleted' },
            });
            removed += count;
          }
          await this.admin.removePolicy(s3KeyPolicyName(projectId)).catch(() => undefined);
          continue;
        }
        await this.writePolicy(project);
        synced++;
      } catch (err: any) {
        this.logger.warn(`S3 key sweep of project ${projectId} failed: ${err?.code ?? err?.message ?? err}`);
      }
    }
    if (removed) this.logger.log(`S3 key sweep removed ${removed} key(s) of deleted projects`);
    return { removed, synced };
  }

  /** Compute the grant set, record unambiguous owners, write the policy. */
  private async writePolicy(
    project: { id: string; slug: string; storagePrefix: string | null; status: string },
    excludePhysical?: string,
  ): Promise<GrantResult> {
    const grant = await this.grantFor(project);
    if (grant.backfill.length) {
      await this.prisma.storageBucketOwner.createMany({
        data: grant.backfill.map((physicalName) => ({ physicalName, projectId: project.id })),
        skipDuplicates: true,
      });
    }
    const buckets = SERVING.has(project.status) ? grant.granted.filter((b) => b !== excludePhysical) : [];
    await this.admin.putPolicy(s3KeyPolicyName(project.id), s3KeyPolicy(buckets));
    return { ...grant, granted: buckets };
  }

  private async grantFor(project: { id: string; slug: string; storagePrefix: string | null }): Promise<GrantResult> {
    const [buckets, all, owners] = await Promise.all([
      this.storage.listPhysicalBucketNames(),
      this.prisma.project.findMany({ select: { id: true, slug: true, storagePrefix: true } }),
      this.prisma.storageBucketOwner.findMany({ select: { physicalName: true, projectId: true } }),
    ]);
    return computeGrantSet({
      project: { id: project.id, prefix: this.storage.projectBucketPrefix(project) },
      others: all.filter((p) => p.id !== project.id).map((p) => ({ id: p.id, prefix: this.storage.projectBucketPrefix(p) })),
      buckets,
      owners: new Map(owners.map((o) => [o.physicalName, o.projectId])),
      reservedPrefixes: [this.storage.platformBucketPrefix],
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private refs(project: { slug: string; storagePrefix: string | null }, physical: string[]): S3BucketRef[] {
    const prefix = this.storage.projectBucketPrefix(project);
    return physical.map((p) => ({ name: p.startsWith(prefix) ? p.slice(prefix.length) : null, physical: p }));
  }

  private view(r: { id: string; name: string; accessKeyId: string; secretLast4: string; createdAt: Date; createdBy: string | null }): S3KeyView {
    return {
      id: r.id,
      name: r.name,
      accessKeyId: r.accessKeyId,
      secretLast4: r.secretLast4,
      createdAt: r.createdAt.toISOString(),
      createdBy: r.createdBy,
    };
  }

  private async hasActiveKeys(projectId: string): Promise<boolean> {
    return (await this.prisma.projectS3Key.count({ where: { projectId, revokedAt: null } })) > 0;
  }

  private loadProject(projectId: string) {
    return this.prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, slug: true, storagePrefix: true, status: true, storageAuthz: true, teamId: true },
    });
  }

  private async access(projectId: string, userId: string, manage = false) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
      select: { id: true, slug: true, storagePrefix: true, status: true, storageAuthz: true, teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const member = project.teamId
      ? await this.prisma.teamMember.findUnique({ where: { teamId_userId: { teamId: project.teamId, userId } } })
      : null;
    if (!member) throw new ForbiddenException("Not a member of this project's team");
    if (manage && !(await roleAllows(this.prisma, project.teamId, member.role, 'canResetDbPassword'))) {
      throw new ForbiddenException("Your role cannot manage this project's S3 keys (it needs the credentials permission)");
    }
    return { project, role: member.role };
  }

  private adminFailure(what: string, projectId: string, err: unknown): Error {
    const code = err instanceof MinioAdminError ? `${err.status} ${err.code}` : (err as any)?.message ?? String(err);
    this.logger.error(`S3 key ${what} for project ${projectId} failed at MinIO: ${code}`);
    return new BadGatewayException('The object store did not accept the change. Nothing was issued or revoked; try again.');
  }

  private async audit(userId: string, via: string, action: string, resourceId: string, meta: Record<string, string>): Promise<void> {
    await this.prisma.auditLog
      .create({
        data: {
          traceId: randomUUID(),
          actorUserId: userId,
          actorRole: via === 'session' ? 'TEAM_MEMBER' : 'API_TOKEN',
          action,
          resourceType: 'project_s3_key',
          resourceId,
          severity: 'MEDIUM',
          success: true,
          metadataJson: { ...meta, via },
        },
      })
      .catch((e: any) => this.logger.warn(`S3 key audit row not written: ${e?.message ?? e}`));
  }
}
