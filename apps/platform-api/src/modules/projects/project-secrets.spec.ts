import * as fs from 'fs';
import * as path from 'path';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProjectSecretsService } from './project-secrets.service';
import {
  buildConnectionDetails,
  PASSWORD_PLACEHOLDER,
  PROJECT_SECRET_FIELDS,
  projectCreationResponse,
  stripProjectSecrets,
} from './project-secrets';

/** #14: credentials never leave a general project response; they are revealed on demand. */

const SECRETS = {
  dbPassword: 'Owner-Pass-123!xyz',
  serviceKey: 'bf_service_abcdefghijklmnopqrstuvwxyz',
  dbReadonlyPassword: 'Readonly-Pass-456!xyz',
  githubToken: 'ghp_secret',
  vercelToken: 'vercel_secret',
  embeddingApiKey: 'sk-embed-secret',
};
const EXTRA_ROLE_PASSWORD = 'Extra-Role-Pass-789!xyz';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'orders',
  slug: 'orders',
  teamId: 't1',
  status: 'ACTIVE',
  dbHost: 'postgres',
  dbPort: 5432,
  dbName: 'kb_orders',
  dbUser: 'kb_user_orders',
  keycloakRealm: 'bf-orders',
  anonKey: 'bf_anon_public',
  serviceKeyLastUsedAt: null as Date | null,
  dbReadonlyUser: 'kb_user_orders_readonly',
  githubOwner: null,
  githubRepo: null,
  vercelProjectId: null,
  folder: null,
  tags: [],
  parent: null,
  maxDbConnections: null,
  extraRoles: [
    { id: 'r1', label: 'Worker', roleName: 'kb_user_orders_worker', password: EXTRA_ROLE_PASSWORD, memberOf: 'none', createdAt: new Date('2026-01-01') },
  ],
  ...SECRETS,
  ...over,
});

const config = {
  get: (key: string) =>
    ({
      publicApiUrl: 'https://api.example.com',
      'pgbouncer.externalHost': 'db.example.com',
      'pgbouncer.externalPort': 6432,
      'keycloak.publicUrl': 'https://auth.example.com',
    } as Record<string, unknown>)[key],
} as any;

/** Every secret value, raw and URI-encoded, that must not appear in a masked response. */
const secretValues = [...Object.values(SECRETS), EXTRA_ROLE_PASSWORD].flatMap((v) => [v, encodeURIComponent(v)]);
const leaks = (value: unknown) => {
  const text = JSON.stringify(value);
  return secretValues.filter((s) => text.includes(s));
};

describe('stripProjectSecrets / projectCreationResponse', () => {
  it('removes every stored credential and keeps the other fields', () => {
    const out = stripProjectSecrets(row());
    for (const f of PROJECT_SECRET_FIELDS) expect(out).not.toHaveProperty(f);
    expect(out).toMatchObject({ id: 'p1', anonKey: 'bf_anon_public', dbUser: 'kb_user_orders' });
  });

  it('the create response carries the generated password and service key once, nothing else', () => {
    const out = projectCreationResponse(row());
    expect(out.dbPassword).toBe(SECRETS.dbPassword);
    expect(out.serviceKey).toBe(SECRETS.serviceKey);
    for (const f of ['dbReadonlyPassword', 'githubToken', 'vercelToken', 'embeddingApiKey']) {
      expect(out).not.toHaveProperty(f);
    }
  });
});

describe('ProjectsService.findOne', () => {
  function build(project = row()) {
    const prisma = {
      project: { findFirst: jest.fn().mockResolvedValue(project) },
      teamMember: { findUnique: jest.fn().mockResolvedValue({ role: 'OWNER' }) },
      projectActivityLog: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const svc = Object.create(ProjectsService.prototype) as any;
    Object.assign(svc, { prisma, config });
    return svc as ProjectsService;
  }

  it('never returns a credential, even to the team owner', async () => {
    const out = await build().findOne('p1', 'u1');
    for (const f of PROJECT_SECRET_FIELDS) expect(out).not.toHaveProperty(f);
    expect(leaks(out)).toEqual([]);
    expect(out).toMatchObject({ id: 'p1', anonKey: 'bf_anon_public', dbHost: 'db.example.com', dbPort: 6432 });
  });
});

describe('buildConnectionDetails', () => {
  it('is masked by default: same shape, no secret anywhere', () => {
    const out = buildConnectionDetails(row(), config);
    expect(leaks(out)).toEqual([]);
    expect(out.password).toBeNull();
    expect(out.serviceKey).toBeNull();
    expect(out.secretsMasked).toBe(true);
    expect(out.poolerUri).toBe(`postgresql://kb_user_orders:${PASSWORD_PLACEHOLDER}@db.example.com:6432/kb_orders`);
    expect(out.readonly).toMatchObject({ user: 'kb_user_orders_readonly', password: null });
    expect(out.extraRoles[0]).toMatchObject({ user: 'kb_user_orders_worker', password: null });
    expect(out.anonKey).toBe('bf_anon_public');
  });

  it('carries the values only when asked to reveal', () => {
    const out = buildConnectionDetails(row(), config, { reveal: true });
    expect(out.password).toBe(SECRETS.dbPassword);
    expect(out.poolerUri).toContain(encodeURIComponent(SECRETS.dbPassword));
    expect(out.readonly?.password).toBe(SECRETS.dbReadonlyPassword);
    expect(out.extraRoles[0].password).toBe(EXTRA_ROLE_PASSWORD);
    expect(out.secretsMasked).toBe(false);
  });
});

describe('ProjectSecretsService.reveal', () => {
  function build(role: string | null, opts: { project?: any; perms?: Record<string, boolean> | null; logFails?: boolean } = {}) {
    const prisma = {
      project: { findFirst: jest.fn().mockResolvedValue(opts.project === undefined ? row() : opts.project) },
      teamMember: { findUnique: jest.fn().mockResolvedValue(role ? { role } : null) },
      teamRolePermission: { findUnique: jest.fn().mockResolvedValue(opts.perms ?? null) },
      projectActivityLog: {
        create: opts.logFails
          ? jest.fn().mockRejectedValue(new Error('db down'))
          : jest.fn().mockResolvedValue({ id: 'a1' }),
      },
    };
    return { svc: new ProjectSecretsService(prisma as any, config), prisma };
  }

  it.each(['OWNER', 'ADMIN'])('%s gets the values and an activity entry is written', async (role) => {
    const { svc, prisma } = build(role);
    const out = await svc.reveal('p1', 'u1');
    expect(out.password).toBe(SECRETS.dbPassword);
    expect(out.serviceKey).toBe(SECRETS.serviceKey);
    expect(out.serviceKeyRevealable).toBe(true);
    expect(out.readonly?.password).toBe(SECRETS.dbReadonlyPassword);
    expect(out.extraRoles[0].password).toBe(EXTRA_ROLE_PASSWORD);
    expect(prisma.projectActivityLog.create).toHaveBeenCalledTimes(1);
    const entry = prisma.projectActivityLog.create.mock.calls[0][0].data;
    expect(entry).toMatchObject({ projectId: 'p1', userId: 'u1', kind: 'project.secrets_revealed' });
    expect(entry.metadata.fields).toEqual(['dbPassword', 'dbReadonlyPassword', 'extraRolePasswords', 'serviceKey']);
    // The entry records which fields, never the values.
    expect(leaks(entry)).toEqual([]);
    // Nothing beyond the credentials: no integration tokens.
    expect(JSON.stringify(out)).not.toContain(SECRETS.githubToken);
    expect(JSON.stringify(out)).not.toContain(SECRETS.embeddingApiKey);
  });

  it('a MEMBER without the credentials permission is refused and nothing is logged', async () => {
    const { svc, prisma } = build('MEMBER');
    await expect(svc.reveal('p1', 'u1')).rejects.toThrow(ForbiddenException);
    expect(prisma.projectActivityLog.create).not.toHaveBeenCalled();
  });

  it('a MEMBER whose role holds canResetDbPassword may reveal', async () => {
    const { svc } = build('MEMBER', { perms: { canResetDbPassword: true } });
    await expect(svc.reveal('p1', 'u1')).resolves.toMatchObject({ password: SECRETS.dbPassword });
  });

  it('a non-member is refused', async () => {
    const { svc } = build(null);
    await expect(svc.reveal('p1', 'u1')).rejects.toThrow(ForbiddenException);
  });

  it('a missing or deleted project is 404', async () => {
    const { svc } = build('OWNER', { project: null });
    await expect(svc.reveal('p1', 'u1')).rejects.toThrow(NotFoundException);
  });

  it('keeps the service key hidden once an application has used it', async () => {
    const { svc } = build('OWNER', { project: row({ serviceKeyLastUsedAt: new Date() }) });
    const out = await svc.reveal('p1', 'u1');
    expect(out.serviceKey).toBeNull();
    expect(out.serviceKeyRevealable).toBe(false);
    expect(out.password).toBe(SECRETS.dbPassword);
  });

  it('does not reveal when the activity entry cannot be written', async () => {
    const { svc } = build('OWNER', { logFails: true });
    await expect(svc.reveal('p1', 'u1')).rejects.toThrow('db down');
  });

  it('the masked details hold no secret', async () => {
    const { svc } = build('OWNER');
    expect(leaks(svc.masked(await svc.loadConnectionRow('p1')))).toEqual([]);
  });
});

describe('reveal route', () => {
  const src = fs.readFileSync(path.join(__dirname, 'projects.controller.ts'), 'utf8');

  it('is dashboard-session only (@JwtOnly) and never cached', () => {
    const at = src.indexOf("@Post(':id/secrets/reveal')");
    expect(at).toBeGreaterThan(-1);
    // The decorators of this one handler: from the end of the previous handler to its name.
    const start = src.lastIndexOf('}', at);
    const decorators = src.slice(start, src.indexOf('async revealSecrets(', at));
    expect(decorators).toContain('@JwtOnly()');
    expect(decorators).not.toContain('@Scopes(');
    expect(decorators).toContain("@Header('Cache-Control', 'no-store')");
  });

  it('the connection-strings route builds masked details only', () => {
    const data = fs.readFileSync(path.join(__dirname, 'project-data.controller.ts'), 'utf8');
    const handler = data.slice(data.indexOf("@Get('connect')"));
    expect(handler).toContain('this.secrets.masked(');
    expect(handler).not.toMatch(/reveal:\s*true/);
  });
});
