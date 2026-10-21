// A fixed admin password keeps the userlist deterministic and the "generated a
// random one" warning out of the test output.
process.env.PGBOUNCER_ADMIN_PASSWORD = 'adm';

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: jest.fn(),
    end: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { PgBouncerService } from './pgbouncer.service';

function service(cfg: Record<string, unknown> = {}) {
  const config = { get: (k: string) => cfg[k] };
  return new PgBouncerService({} as any, config as any);
}

const owner = { dbName: 'kb_a', dbUser: 'kb_user_a', dbPassword: 'pa' };
const other = { dbName: 'kb_b', dbUser: 'kb_user_b', dbPassword: 'pb' };

/**
 * The ini PgBouncer runs with today, reproduced byte for byte. Nothing in this
 * workstream may change it unless a project, a plan or an operator asks for a
 * limit — this fixture is what "unchanged by default" means.
 */
const TODAY = `[databases]
kb_a = host=postgres port=5432 dbname=kb_a
kb_b = host=postgres port=5432 dbname=kb_b

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = plain
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = 1000
default_pool_size = 20
min_pool_size = 5
reserve_pool_size = 5
reserve_pool_timeout = 3
server_lifetime = 3600
server_idle_timeout = 600
log_connections = 1
log_disconnections = 1
log_pooler_errors = 1
admin_users = pgbouncer_admin
stats_users = pgbouncer_admin
ignore_startup_parameters = extra_float_digits,search_path
`;

const ini = (svc: PgBouncerService, projects: unknown[], tls = false, clientLimits = false) =>
  (svc as any).buildIni(projects, tls, clientLimits) as string;
const userlist = (svc: PgBouncerService, projects: unknown[]) =>
  (svc as any).buildUserlist(projects) as string;

describe('buildIni', () => {
  it('is byte-identical to today when no project, plan or operator sets a limit', () => {
    expect(ini(service(), [owner, other])).toBe(TODAY);
  });

  it('adds the TLS block exactly as before when the cert is in place', () => {
    const out = ini(service({ 'pgbouncer.configDir': '/etc/pgbouncer' }), [owner, other], true);
    expect(out).toBe(
      TODAY +
        `client_tls_sslmode = allow
client_tls_cert_file = ${require('path').join('/etc/pgbouncer', 'server.crt')}
client_tls_key_file = ${require('path').join('/etc/pgbouncer', 'server.key')}
`,
    );
  });

  it('caps a database when its project sets a limit, and leaves the others alone', () => {
    const out = ini(service(), [{ ...owner, maxDbConnections: 10 }, other]);
    expect(out).toContain('kb_a = host=postgres port=5432 dbname=kb_a pool_size=10 max_db_connections=10\n');
    expect(out).toContain('kb_b = host=postgres port=5432 dbname=kb_b\n');
    expect(out).not.toContain('max_db_client_connections');
  });

  it('falls back to the plan, then to the platform default, then to none', () => {
    const planned = { ...owner, team: { subscription: { plan: { maxDbConnections: 8 } } } };
    expect(ini(service(), [planned])).toContain('dbname=kb_a pool_size=8 max_db_connections=8');
    expect(ini(service(), [{ ...planned, maxDbConnections: 3 }])).toContain('pool_size=3 max_db_connections=3');
    expect(ini(service({ 'pgbouncer.defaultMaxDbConnections': 25 }), [owner])).toContain('pool_size=25 max_db_connections=25');
    expect(ini(service({ 'pgbouncer.defaultMaxDbConnections': '' }), [owner])).toBe(TODAY.replace('kb_b = host=postgres port=5432 dbname=kb_b\n', ''));
  });

  it('clamps stored values into [1, ceiling] and ignores garbage', () => {
    expect(ini(service(), [{ ...owner, maxDbConnections: 0 }])).toContain('pool_size=1 max_db_connections=1');
    expect(ini(service(), [{ ...owner, maxDbConnections: 500 }])).toContain('pool_size=100 max_db_connections=100');
    expect(ini(service({ 'pgbouncer.maxDbConnectionsCeiling': 40 }), [{ ...owner, maxDbConnections: 500 }])).toContain('pool_size=40 max_db_connections=40');
    expect(ini(service(), [{ ...owner, maxDbConnections: Number.NaN }])).toContain('kb_a = host=postgres port=5432 dbname=kb_a\n');
  });

  it('adds the per-database client cap only when the pooler is known to support it', () => {
    const limited = { ...owner, maxDbConnections: 10 };
    expect(ini(service({ 'pgbouncer.dbClientLimits': true }), [limited], false, false)).not.toContain('max_db_client_connections');
    expect(ini(service({ 'pgbouncer.dbClientLimits': true }), [limited], false, true)).toContain(
      'pool_size=10 max_db_connections=10 max_db_client_connections=100',
    );
    // Without a limit there is nothing to cap, whatever the pooler supports.
    expect(ini(service({ 'pgbouncer.dbClientLimits': true }), [owner], false, true)).toContain('kb_a = host=postgres port=5432 dbname=kb_a\n');
  });

  it('takes the pooler globals from config with today\'s literals as defaults', () => {
    const out = ini(
      service({
        'pgbouncer.maxClientConn': 500,
        'pgbouncer.defaultPoolSize': '15',
        'pgbouncer.minPoolSize': 0,
        'pgbouncer.reservePoolSize': 2,
      }),
      [owner],
    );
    expect(out).toContain('max_client_conn = 500\n');
    expect(out).toContain('default_pool_size = 15\n');
    expect(out).toContain('min_pool_size = 0\n');
    expect(out).toContain('reserve_pool_size = 2\n');
  });
});

describe('limit resolution helpers', () => {
  it('describes where the effective limit comes from', () => {
    const svc = service({ 'pgbouncer.defaultMaxDbConnections': 25 });
    expect(svc.describeDbConnectionLimit({ maxDbConnections: 5, planMaxDbConnections: 10 })).toEqual({ effective: 5, source: 'project' });
    expect(svc.describeDbConnectionLimit({ maxDbConnections: null, planMaxDbConnections: 10 })).toEqual({ effective: 10, source: 'plan' });
    expect(svc.describeDbConnectionLimit({ maxDbConnections: null, planMaxDbConnections: null })).toEqual({ effective: 25, source: 'platform' });
    expect(service().describeDbConnectionLimit({})).toEqual({ effective: null, source: 'none' });
  });

  it('lets a plan raise or lower the ceiling a project may choose', () => {
    expect(service().planCeiling(null)).toBe(100);
    expect(service().planCeiling(12)).toBe(12);
    expect(service({ 'pgbouncer.maxDbConnectionsCeiling': 60 }).planCeiling(undefined)).toBe(60);
  });

  it('parses the pooler version and requires 1.24 for client limits', () => {
    expect(PgBouncerService.parsePgBouncerVersion('PgBouncer 1.25.1')).toEqual({ major: 1, minor: 25 });
    expect(PgBouncerService.parsePgBouncerVersion('nonsense')).toBeNull();
    expect(PgBouncerService.supportsDbClientLimitsAt({ major: 1, minor: 24 })).toBe(true);
    expect(PgBouncerService.supportsDbClientLimitsAt({ major: 1, minor: 23 })).toBe(false);
    expect(PgBouncerService.supportsDbClientLimitsAt({ major: 2, minor: 0 })).toBe(true);
    expect(PgBouncerService.supportsDbClientLimitsAt(null)).toBe(false);
  });

  it('never asks the pooler for its version while the client-limit flag is off', async () => {
    const svc = service();
    const detect = jest.spyOn(svc as any, 'detectVersion');
    expect(await (svc as any).supportsDbClientLimits()).toBe(false);
    expect(detect).not.toHaveBeenCalled();
  });

  it('asks once, and skips the key when the pooler is too old or unreachable', async () => {
    const old = service({ 'pgbouncer.dbClientLimits': true });
    jest.spyOn(old as any, 'detectVersion').mockResolvedValue({ major: 1, minor: 23 });
    expect(await (old as any).supportsDbClientLimits()).toBe(false);
    expect(await (old as any).supportsDbClientLimits()).toBe(false);
    expect((old as any).detectVersion).toHaveBeenCalledTimes(1);

    const down = service({ 'pgbouncer.dbClientLimits': true });
    jest.spyOn(down as any, 'detectVersion').mockResolvedValue(null);
    expect(await (down as any).supportsDbClientLimits()).toBe(false);

    const fresh = service({ 'pgbouncer.dbClientLimits': true });
    jest.spyOn(fresh as any, 'detectVersion').mockResolvedValue({ major: 1, minor: 25 });
    expect(await (fresh as any).supportsDbClientLimits()).toBe(true);
  });
});

describe('buildUserlist', () => {
  it('lists owners exactly as before, then the admin', () => {
    process.env.PGBOUNCER_ADMIN_PASSWORD = 'adm';
    const out = userlist(service(), [owner, other]);
    expect(out).toBe('"kb_user_a" "pa"\n"kb_user_b" "pb"\n"pgbouncer_admin" "adm"\n');
  });

  it('adds a read-only companion only when both its fields are present', () => {
    const out = userlist(service(), [
      { ...owner, dbReadonlyUser: 'kb_user_a_readonly', dbReadonlyPassword: 'ra' },
      { ...other, dbReadonlyUser: 'kb_user_b_readonly', dbReadonlyPassword: null },
    ]);
    expect(out.split('\n').filter(Boolean)).toEqual([
      '"kb_user_a" "pa"',
      '"kb_user_a_readonly" "ra"',
      '"kb_user_b" "pb"',
      expect.stringMatching(/^"pgbouncer_admin" /),
    ]);
  });
});
