// A fixed admin password keeps the "generated a random one" warning out of the output.
process.env.PGBOUNCER_ADMIN_PASSWORD = 'adm';

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockRejectedValue(new Error('no pooler in tests')),
    end: jest.fn().mockResolvedValue(undefined),
  })),
}));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PgBouncerService } from './pgbouncer.service';

function service(cfg: Record<string, unknown> = {}) {
  const config = { get: (k: string) => cfg[k] };
  return new PgBouncerService({} as any, config as any);
}

const open = { dbName: 'kb_a', dbUser: 'kb_user_a', dbPassword: 'pa' };
const locked = {
  dbName: 'kb_b',
  dbUser: 'kb_user_b',
  dbPassword: 'pb',
  dbAccessPolicy: { requireTls: true, allowedCidrs: ['203.0.113.0/24'] },
};

describe('pooler network rules', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pgb-rules-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const hba = (svc: PgBouncerService, projects: unknown[], tls = true) =>
    (svc as any).writeHbaFile(projects, tls) as Promise<string | null>;

  it('stay off unless PGBOUNCER_NETWORK_RULES=enforce, whatever projects hold', async () => {
    for (const value of [undefined, '', 'off', 'log', 'true']) {
      const svc = service({ 'pgbouncer.configDir': dir, PGBOUNCER_NETWORK_RULES: value });
      expect(svc.networkRulesEnforced()).toBe(false);
      expect(await hba(svc, [open, locked])).toBeNull();
    }
    expect(existsSync(join(dir, 'pg_hba.conf'))).toBe(false);
  });

  it('write no file while no project has rules, so auth stays plain', async () => {
    const svc = service({ 'pgbouncer.configDir': dir, PGBOUNCER_NETWORK_RULES: 'enforce' });
    expect(await hba(svc, [open, { ...open, dbName: 'kb_c', dbAccessPolicy: { requireTls: false, allowedCidrs: [] } }])).toBeNull();
    expect(existsSync(join(dir, 'pg_hba.conf'))).toBe(false);
  });

  it('write the HBA file and point the ini at it once a project has rules', async () => {
    const svc = service({ 'pgbouncer.configDir': dir, PGBOUNCER_NETWORK_RULES: ' Enforce ' });
    const path = await hba(svc, [open, locked]);
    expect(path).toBe(`${dir.replace(/\\/g, '/')}/pg_hba.conf`);
    const file = readFileSync(path!, 'utf-8');
    expect(file).toContain('hostssl kb_b all 203.0.113.0/24 password\nhost kb_b all 0.0.0.0/0 reject');
    expect(file).not.toContain('kb_a');
    expect(file).toContain('host all all 0.0.0.0/0 password');

    const ini = (svc as any).buildIni([open, locked], true, false, path) as string;
    expect(ini).toContain(`listen_port = 6432\nauth_type = hba\nauth_hba_file = ${path}\nauth_file = /etc/pgbouncer/userlist.txt\n`);
    expect(ini).not.toContain('auth_type = plain');
  });

  it('keep auth_type = plain in the ini without an HBA file', () => {
    const ini = (service() as any).buildIni([open], false) as string;
    expect(ini).toContain('listen_port = 6432\nauth_type = plain\nauth_file = /etc/pgbouncer/userlist.txt\n');
  });
});

const opensslAvailable = (() => {
  const r = spawnSync(process.env.OPENSSL_BIN || 'openssl', ['version'], { encoding: 'utf-8' });
  return !r.error && r.status === 0;
})();
const describeWithOpenssl = opensslAvailable ? describe : describe.skip;

describeWithOpenssl('pooler certificate from a configured source', () => {
  let dir: string;
  let src: string;
  const ssl = (cwd: string, ...args: string[]) => {
    const r = spawnSync(process.env.OPENSSL_BIN || 'openssl', args, { cwd, encoding: 'utf-8' });
    if (r.error || r.status !== 0) throw new Error(`openssl failed: ${r.error?.message ?? r.stderr}`);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pgb-tls-'));
    src = mkdtempSync(join(tmpdir(), 'pgb-src-'));
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
    // What the pooler has today: a self-signed pair.
    ssl(dir, 'req', '-x509', ...ec, '-keyout', 'server.key', '-out', 'server.crt', '-days', '30', '-subj', '/CN=db.example.test');
    // What the source offers: a different pair (self-signed here; issuer does not matter to the install).
    ssl(src, 'req', '-x509', ...ec, '-keyout', 'privkey.pem', '-out', 'fullchain.pem', '-days', '30', '-subj', '/CN=*.example.test',
      '-addext', 'subjectAltName=DNS:*.example.test');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(src, { recursive: true, force: true });
  });

  const svcWith = (cert: string, key: string) =>
    service({ 'pgbouncer.configDir': dir, PGBOUNCER_TLS_CERT_SOURCE: cert, PGBOUNCER_TLS_KEY_SOURCE: key });
  const install = (svc: PgBouncerService) => (svc as any).installSourceCert() as Promise<string>;

  it('is not used when unset', async () => {
    expect(await install(service({ 'pgbouncer.configDir': dir }))).toBe('unavailable');
  });

  it('installs a valid pair once, keeping the self-signed one beside it', async () => {
    const before = readFileSync(join(dir, 'server.crt'), 'utf-8');
    const svc = svcWith(join(src, 'fullchain.pem'), join(src, 'privkey.pem'));
    expect(await install(svc)).toBe('installed');
    expect(readFileSync(join(dir, 'server.crt'), 'utf-8')).toBe(readFileSync(join(src, 'fullchain.pem'), 'utf-8'));
    expect(readFileSync(join(dir, 'server.key'), 'utf-8')).toBe(readFileSync(join(src, 'privkey.pem'), 'utf-8'));
    expect(readFileSync(join(dir, 'server-selfsigned.crt'), 'utf-8')).toBe(before);
    expect(await install(svc)).toBe('unchanged');
  });

  it('never replaces the pair with one that does not match or cannot be read', async () => {
    const before = readFileSync(join(dir, 'server.crt'), 'utf-8');
    // Certificate from the source, key from the pooler: they do not belong together.
    expect(await install(svcWith(join(src, 'fullchain.pem'), join(dir, 'server.key')))).toBe('unavailable');
    expect(await install(svcWith(join(src, 'missing.pem'), join(src, 'privkey.pem')))).toBe('unavailable');
    writeFileSync(join(src, 'garbage.pem'), 'not a certificate');
    expect(await install(svcWith(join(src, 'garbage.pem'), join(src, 'privkey.pem')))).toBe('unavailable');
    expect(readFileSync(join(dir, 'server.crt'), 'utf-8')).toBe(before);
  });
});
