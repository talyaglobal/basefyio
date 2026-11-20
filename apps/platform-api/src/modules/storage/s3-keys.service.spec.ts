jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadGatewayException, ConflictException, ForbiddenException, Logger, NotFoundException } from '@nestjs/common';
import { MinioAdmin, MinioAdminError } from './minio-admin.client';
import { computeGrantSet, s3KeyPolicy } from './s3-key-policy';
import { S3KeysService, randomString } from './s3-keys.service';

beforeAll(() => {
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

// ── The policy and the prefix-collision rules ───────────────────────────────

describe('computeGrantSet', () => {
  const A = { id: 'pa', prefix: 'bf-a-' };
  const AB = { id: 'pab', prefix: 'bf-a-b-' };
  const base = { reservedPrefixes: ['bf-platform-'], owners: new Map<string, string>() };

  it('grants an unambiguous bucket under the project prefix and records it', () => {
    const r = computeGrantSet({ ...base, project: A, others: [], buckets: ['bf-a-docs', 'bf-zzz-x'] });
    expect(r.granted).toEqual(['bf-a-docs']);
    expect(r.backfill).toEqual(['bf-a-docs']);
  });

  it("never grants project a the buckets of project a-b (bf-a- is a prefix of bf-a-b-)", () => {
    const r = computeGrantSet({ ...base, project: A, others: [AB], buckets: ['bf-a-b-x', 'bf-a-docs'] });
    expect(r.granted).toEqual(['bf-a-docs']);
    expect(r.unreachable.map((u) => u.physical)).toEqual(['bf-a-b-x']);
  });

  it('leaves an ambiguous unrecorded bucket out of both projects', () => {
    const forAB = computeGrantSet({ ...base, project: AB, others: [A], buckets: ['bf-a-b-x'] });
    const forA = computeGrantSet({ ...base, project: A, others: [AB], buckets: ['bf-a-b-x'] });
    expect(forAB.granted).toEqual([]);
    expect(forA.granted).toEqual([]);
    expect(forAB.backfill).toEqual([]);
  });

  it('resolves an ambiguous bucket by its owner record, for the owner only', () => {
    const owners = new Map([['bf-a-b-x', 'pa']]);
    expect(computeGrantSet({ ...base, owners, project: A, others: [AB], buckets: ['bf-a-b-x'] }).granted).toEqual(['bf-a-b-x']);
    expect(computeGrantSet({ ...base, owners, project: AB, others: [A], buckets: ['bf-a-b-x'] }).granted).toEqual([]);
  });

  it("a deleted project's prefix still counts (its leftovers stay ambiguous)", () => {
    // `others` holds projects of every status; the service passes them all.
    const r = computeGrantSet({ ...base, project: AB, others: [A], buckets: ['bf-a-b-old'] });
    expect(r.granted).toEqual([]);
  });

  it('never grants a platform bucket, even to a project whose prefix matches', () => {
    const P = { id: 'pp', prefix: 'bf-platform-' };
    const r = computeGrantSet({
      ...base,
      owners: new Map([['bf-platform-pitr', 'pp']]),
      project: P,
      others: [],
      buckets: ['bf-platform-pitr', 'bf-platform-auto-backups'],
    });
    expect(r.granted).toEqual([]);
  });
});

describe('s3KeyPolicy', () => {
  it('names each bucket exactly, with no wildcard bucket ARN and no bucket-admin action', () => {
    const p: any = s3KeyPolicy(['bf-a-docs', 'bf-a-media']);
    const resources = p.Statement.flatMap((s: any) => s.Resource);
    expect(resources).toEqual(['arn:aws:s3:::bf-a-docs', 'arn:aws:s3:::bf-a-media', 'arn:aws:s3:::bf-a-docs/*', 'arn:aws:s3:::bf-a-media/*']);
    const actions = p.Statement.flatMap((s: any) => s.Action);
    for (const forbidden of ['s3:*', 's3:PutBucketPolicy', 's3:DeleteBucket', 's3:ListAllMyBuckets', 's3:CreateBucket']) {
      expect(actions).not.toContain(forbidden);
    }
    expect(actions.some((a: string) => a.startsWith('admin:'))).toBe(false);
  });

  it('is deny-only when nothing is reachable', () => {
    const p: any = s3KeyPolicy([]);
    expect(p.Statement).toHaveLength(1);
    expect(p.Statement[0].Effect).toBe('Deny');
  });

  it('refuses a name that is not a bucket name (no ARN injection)', () => {
    expect(() => s3KeyPolicy(['bf-a-*'])).toThrow();
    expect(() => s3KeyPolicy(['bf-a-x/../y'])).toThrow();
  });
});

describe('randomString', () => {
  it('draws only from the alphabet at the requested length', () => {
    const s = randomString('AB', 200);
    expect(s).toHaveLength(200);
    expect(/^[AB]+$/.test(s)).toBe(true);
  });
});

// ── The service, against a fake MinIO ───────────────────────────────────────

class FakeAdmin implements MinioAdmin {
  users = new Map<string, { secret: string; policies: string[] }>();
  policies = new Map<string, any>();
  fail: Partial<Record<keyof MinioAdmin, MinioAdminError>> = {};
  async putPolicy(name: string, policy: object) {
    if (this.fail.putPolicy) throw this.fail.putPolicy;
    this.policies.set(name, policy);
  }
  async removePolicy(name: string) {
    this.policies.delete(name);
  }
  async addUser(ak: string, secret: string) {
    if (this.fail.addUser) throw this.fail.addUser;
    this.users.set(ak, { secret, policies: [] });
  }
  async attachPolicy(ak: string, name: string) {
    if (this.fail.attachPolicy) throw this.fail.attachPolicy;
    this.users.get(ak)!.policies.push(name);
  }
  async removeUser(ak: string) {
    if (this.fail.removeUser) throw this.fail.removeUser;
    this.users.delete(ak);
  }
  /** Physical buckets a user reaches through its policies. */
  reach(ak: string): string[] {
    const u = this.users.get(ak);
    if (!u) return [];
    return u.policies.flatMap((n) =>
      (this.policies.get(n)?.Statement ?? [])
        .filter((s: any) => s.Effect === 'Allow')
        .flatMap((s: any) => s.Resource)
        .filter((r: string) => !r.endsWith('/*'))
        .map((r: string) => r.replace('arn:aws:s3:::', '')),
    );
  }
}

const P1 = { id: 'p1', slug: 'a', storagePrefix: null, status: 'ACTIVE', storageAuthz: 'presets', teamId: 't1' };
const P2 = { id: 'p2', slug: 'a_b', storagePrefix: null, status: 'ACTIVE', storageAuthz: 'presets', teamId: 't2' };

function build(opts: { cfg?: Record<string, unknown>; buckets?: string[]; projects?: any[]; role?: string; member?: boolean } = {}) {
  const cfg: Record<string, unknown> = {
    'storage.s3Keys.enabled': true,
    'storage.s3Keys.maxPerProject': 2,
    'minio.publicEndpoint': 'storage.example.com',
    'minio.publicPort': 443,
    'minio.publicSsl': 'true',
    ...opts.cfg,
  };
  const projects = opts.projects ?? [P1, P2];
  const buckets = opts.buckets ?? ['bf-a-docs', 'bf-a-b-x', 'bf-platform-pitr'];
  const keys: any[] = [];
  const owners = new Map<string, string>();
  const audit: any[] = [];
  let seq = 0;
  const prisma: any = {
    project: {
      findFirst: jest.fn(async ({ where }: any) => projects.find((p) => p.id === where.id && p.status !== 'DELETED') ?? null),
      findUnique: jest.fn(async ({ where }: any) => projects.find((p) => p.id === where.id) ?? null),
      findMany: jest.fn(async ({ where }: any = {}) => (where?.id?.in ? projects.filter((p) => where.id.in.includes(p.id)) : projects)),
    },
    teamMember: {
      findUnique: jest.fn(async ({ where }: any) =>
        opts.member === false ? null : { teamId: where.teamId_userId.teamId, userId: where.teamId_userId.userId, role: opts.role ?? 'OWNER' },
      ),
    },
    teamRolePermission: { findUnique: jest.fn(async () => null) },
    projectS3Key: {
      count: jest.fn(async ({ where }: any) => keys.filter((k) => k.projectId === where.projectId && !k.revokedAt).length),
      findMany: jest.fn(async ({ where }: any) => keys.filter((k) => !k.revokedAt && (!where.projectId || k.projectId === where.projectId))),
      findFirst: jest.fn(async ({ where }: any) => keys.find((k) => k.id === where.id && k.projectId === where.projectId && !k.revokedAt) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `k${++seq}`, createdAt: new Date(0), revokedAt: null, revokedBy: null, createdBy: null, ...data };
        keys.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = keys.filter((k) => k.id === where.id && !k.revokedAt);
        hit.forEach((k) => Object.assign(k, data));
        return { count: hit.length };
      }),
    },
    storageBucketOwner: {
      findMany: jest.fn(async () => [...owners].map(([physicalName, projectId]) => ({ physicalName, projectId }))),
      createMany: jest.fn(async ({ data }: any) => {
        for (const d of data) if (!owners.has(d.physicalName)) owners.set(d.physicalName, d.projectId);
        return { count: data.length };
      }),
    },
    auditLog: { create: jest.fn(async ({ data }: any) => audit.push(data)) },
  };
  const storage: any = {
    driver: 'minio',
    platformBucketPrefix: 'bf-platform-',
    projectBucketPrefix: (p: any) => `bf-${String(p.storagePrefix ?? p.slug).replace(/[^a-z0-9-]/g, '-')}-`,
    listPhysicalBucketNames: jest.fn(async () => buckets),
    addBucketListener: jest.fn(),
  };
  const admin = new FakeAdmin();
  const config = { get: (k: string) => cfg[k] };
  const svc = new S3KeysService(prisma, config as any, storage, admin);
  svc.onModuleInit();
  const listener = storage.addBucketListener.mock.calls[0][0];
  return { svc, admin, prisma, storage, keys, owners, audit, buckets, listener };
}

describe('S3KeysService', () => {
  it('refuses to create a key while the server switch is off, and says so in info', async () => {
    const { svc, admin } = build({ cfg: { 'storage.s3Keys.enabled': false } });
    await expect(svc.create('p1', 'u1', 'ci')).rejects.toBeInstanceOf(ForbiddenException);
    expect(admin.users.size).toBe(0);
    const info = await svc.info('p1', 'u1');
    expect(info.enabled).toBe(false);
    expect(info.unavailableReason).toMatch(/not enabled/);
  });

  it('honours the per-project allow list', async () => {
    const { svc } = build({ cfg: { 'storage.s3Keys.projects': 'other-project' } });
    await expect(svc.create('p1', 'u1', 'ci')).rejects.toThrow(/not enabled for this project/);
    const ok = build({ cfg: { 'storage.s3Keys.projects': 'a' } });
    await expect(ok.svc.create('p1', 'u1', 'ci')).resolves.toMatchObject({ name: 'ci' });
  });

  it('refuses projects that authorise storage with database policies', async () => {
    const { svc } = build({ projects: [{ ...P1, storageAuthz: 'rls' }, P2] });
    await expect(svc.create('p1', 'u1', 'ci')).rejects.toThrow(/rls/);
  });

  it('refuses a member without the credentials permission', async () => {
    const { svc } = build({ role: 'MEMBER' });
    await expect(svc.create('p1', 'u1', 'ci')).rejects.toThrow(/credentials permission/);
  });

  it("refuses someone outside the project's team", async () => {
    const { svc } = build({ member: false });
    await expect(svc.list('p1', 'u1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('creates a MinIO user limited to its own buckets and returns the secret once', async () => {
    const { svc, admin, keys, audit } = build();
    const out = await svc.create('p1', 'u1', 'tsmart writer');
    expect(out.accessKeyId).toMatch(/^BFS3[A-Z0-9]{16}$/);
    expect(out.secretAccessKey).toMatch(/^[A-Za-z0-9]{40}$/);
    expect(out).toMatchObject({ endpoint: 'https://storage.example.com', region: 'us-east-1', pathStyle: true });
    expect(out.buckets).toEqual([{ name: 'docs', physical: 'bf-a-docs' }]);
    // Project a never reaches a-b's bucket bf-a-b-x, nor a platform bucket.
    expect(admin.reach(out.accessKeyId)).toEqual(['bf-a-docs']);
    // MinIO holds the secret; the platform keeps only the last four.
    expect(admin.users.get(out.accessKeyId)!.secret).toBe(out.secretAccessKey);
    expect(JSON.stringify(keys)).not.toContain(out.secretAccessKey);
    expect(keys[0].secretLast4).toBe(out.secretAccessKey.slice(-4));
    expect(JSON.stringify(audit)).not.toContain(out.secretAccessKey);
    expect(audit[0]).toMatchObject({ action: 'storage.s3_key_created', resourceType: 'project_s3_key' });
  });

  it('lists keys without any secret', async () => {
    const { svc } = build();
    const created = await svc.create('p1', 'u1', 'ci');
    const list = await svc.list('p1', 'u1');
    expect(list).toEqual([expect.objectContaining({ id: created.id, accessKeyId: created.accessKeyId, secretLast4: created.secretAccessKey.slice(-4) })]);
    expect(JSON.stringify(list)).not.toContain(created.secretAccessKey);
    expect(list[0]).not.toHaveProperty('secretAccessKey');
  });

  it('enforces the per-project key limit', async () => {
    const { svc } = build();
    await svc.create('p1', 'u1', 'one');
    await svc.create('p1', 'u1', 'two');
    await expect(svc.create('p1', 'u1', 'three')).rejects.toBeInstanceOf(ConflictException);
  });

  it('rolls the MinIO user back when attaching the policy fails', async () => {
    const { svc, admin, keys } = build();
    admin.fail.attachPolicy = new MinioAdminError('attach-policy', 500, 'XMinioAdminInternal');
    await expect(svc.create('p1', 'u1', 'ci')).rejects.toBeInstanceOf(BadGatewayException);
    expect(admin.users.size).toBe(0);
    expect(keys).toHaveLength(0);
  });

  it('rolls the MinIO user back when the row cannot be written', async () => {
    const { svc, admin, prisma } = build();
    prisma.projectS3Key.create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.create('p1', 'u1', 'ci')).rejects.toThrow('db down');
    expect(admin.users.size).toBe(0);
  });

  it('revokes by deleting the MinIO user first; a MinIO failure keeps the row active', async () => {
    const { svc, admin, keys } = build();
    const k = await svc.create('p1', 'u1', 'ci');
    admin.fail.removeUser = new MinioAdminError('remove-user', 500, 'XMinioAdminInternal');
    await expect(svc.revoke('p1', 'u1', k.id)).rejects.toBeInstanceOf(BadGatewayException);
    expect(keys[0].revokedAt).toBeNull();
    delete admin.fail.removeUser;
    await expect(svc.revoke('p1', 'u1', k.id)).resolves.toEqual({ revoked: true });
    expect(admin.users.has(k.accessKeyId)).toBe(false);
    expect(keys[0].revokedAt).toBeInstanceOf(Date);
    await expect(svc.revoke('p1', 'u1', k.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("cannot revoke another project's key through its own project id", async () => {
    const { svc } = build();
    const k = await svc.create('p1', 'u1', 'ci');
    await expect(svc.revoke('p2', 'u1', k.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('drops a bucket from the policy before it is deleted, and refuses the delete if that fails', async () => {
    const { svc, admin, listener, buckets } = build({ buckets: ['bf-a-docs', 'bf-a-media'] });
    const k = await svc.create('p1', 'u1', 'ci');
    expect(admin.reach(k.accessKeyId)).toEqual(['bf-a-docs', 'bf-a-media']);
    await listener.beforeDelete('p1', 'bf-a-media');
    expect(admin.reach(k.accessKeyId)).toEqual(['bf-a-docs']);
    admin.fail.putPolicy = new MinioAdminError('add-canned-policy', 500, 'XMinioAdminInternal');
    await expect(listener.beforeDelete('p1', 'bf-a-docs')).rejects.toBeInstanceOf(BadGatewayException);
    expect(buckets).toContain('bf-a-docs');
  });

  it('adds a new bucket to the policy after it is created', async () => {
    const { svc, admin, listener, buckets } = build({ buckets: ['bf-a-docs'] });
    const k = await svc.create('p1', 'u1', 'ci');
    buckets.push('bf-a-new');
    await listener.afterCreate('p1', 'bf-a-new');
    expect(admin.reach(k.accessKeyId)).toEqual(['bf-a-docs', 'bf-a-new']);
  });

  it('does not touch MinIO on bucket changes of a project without keys', async () => {
    const { admin, listener } = build();
    await listener.beforeDelete('p1', 'bf-a-docs');
    await listener.afterCreate('p1', 'bf-a-docs');
    expect(admin.policies.size).toBe(0);
  });

  it('sweeps: removes keys of a deleted project, puts a deactivated one on the deny-only policy', async () => {
    const projects = [{ ...P1 }, { ...P2, slug: 'zz' }];
    const { svc, admin, keys, buckets } = build({ projects, buckets: ['bf-a-docs', 'bf-zz-x'] });
    const k1 = await svc.create('p1', 'u1', 'ci');
    const k2 = await svc.create('p2', 'u1', 'ci');
    expect(admin.reach(k2.accessKeyId)).toEqual(['bf-zz-x']);
    projects[0].status = 'DELETED';
    projects[1].status = 'DEACTIVATED';
    expect(buckets).toHaveLength(2);
    await expect(svc.sweep()).resolves.toEqual({ removed: 1, synced: 1 });
    expect(admin.users.has(k1.accessKeyId)).toBe(false);
    expect(keys.find((k) => k.id === k1.id).revokedBy).toBe('system:project-deleted');
    expect(admin.reach(k2.accessKeyId)).toEqual([]);
  });

  it('reports buckets it will not grant, with the reason', async () => {
    const { svc } = build({ buckets: ['bf-a-docs', 'bf-a-b-x'] });
    const info = await svc.info('p1', 'u1');
    expect(info.buckets.map((b) => b.physical)).toEqual(['bf-a-docs']);
    expect(info.unreachable).toEqual([expect.objectContaining({ physical: 'bf-a-b-x' })]);
  });
});
