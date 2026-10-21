import { randomBytes } from 'crypto';
import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Pool } from 'pg';
import { access, chmod, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/** What the ini generator needs to know about an ACTIVE project. */
export interface PoolerProject {
  dbName: string;
  dbUser: string;
  dbPassword: string;
  dbReadonlyUser?: string | null;
  dbReadonlyPassword?: string | null;
  maxDbConnections?: number | null;
  team?: {
    subscription?: { plan?: { maxDbConnections: number | null } | null } | null;
  } | null;
}

export type DbConnectionLimitSource = 'project' | 'plan' | 'platform' | 'none';

/**
 * Client connections allowed per server connection when the per-database
 * client cap is on. Transaction pooling multiplexes many idle clients onto one
 * backend; ten is generous for application pools and still bounds a runaway
 * client.
 */
const CLIENTS_PER_SERVER_CONNECTION = 10;

@Injectable()
export class PgBouncerService implements OnModuleInit {
  private readonly logger = new Logger(PgBouncerService.name);
  private readonly configDir: string;
  private readonly pgHost: string;
  private readonly pgPort: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.configDir = this.config.get<string>('pgbouncer.configDir') || '/etc/pgbouncer';
    this.pgHost = this.config.get<string>('database.host') || 'postgres';
    this.pgPort = this.config.get<number>('database.port') || 5432;
  }

  async onModuleInit() {
    try {
      await this.regenerateConfig();
      this.logger.log('PgBouncer config generated on startup');
    } catch (err) {
      this.logger.warn(`PgBouncer config generation skipped: ${err}`);
    }
  }

  async regenerateConfig(): Promise<void> {
    const projects: PoolerProject[] = await this.prisma.project.findMany({
      where: { status: 'ACTIVE' },
      select: {
        dbName: true,
        dbUser: true,
        dbPassword: true,
        dbReadonlyUser: true,
        dbReadonlyPassword: true,
        maxDbConnections: true,
        team: {
          select: {
            subscription: { select: { plan: { select: { maxDbConnections: true } } } },
          },
        },
      },
    });

    // Opportunistic client TLS so customers can connect with sslmode=require
    // (migrations, pgAdmin, DBeaver). Only enabled if the cert is actually in
    // place — a missing cert with client_tls_* set would stop PgBouncer from
    // starting and take down DB access for every project.
    const tlsReady = await this.ensureTlsCert();

    const dbClientLimits = await this.supportsDbClientLimits();
    const iniContent = this.buildIni(projects, tlsReady, dbClientLimits);
    const userlistContent = this.buildUserlist(projects);

    await this.writeAtomically(join(this.configDir, 'pgbouncer.ini'), iniContent);
    await this.writeAtomically(join(this.configDir, 'userlist.txt'), userlistContent);

    this.logger.log(`PgBouncer config written: ${projects.length} project(s)`);

    await this.sendReload();
  }

  /**
   * Replace a config file in one step.
   *
   * The files live on a volume shared with PgBouncer, and with more than one
   * API replica two processes can regenerate them at the same moment. A plain
   * write truncates the file first, so a RELOAD — or the other writer — could
   * read it half-written. Writing beside it and renaming over it is atomic on
   * the same filesystem: readers see the old file or the new one, never a mix.
   */
  private async writeAtomically(path: string, content: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, content, 'utf-8');
    await rename(tmp, path);
  }

  private buildIni(
    projects: PoolerProject[],
    tlsReady: boolean,
    dbClientLimits = false,
  ): string {
    const dbEntries = projects
      .map((p) => this.databaseLine(p, dbClientLimits))
      .join('\n');

    // "allow" = opportunistic: clients may negotiate TLS, but plaintext
    // connections (existing customers, internal services) keep working.
    const tlsLines = tlsReady
      ? `client_tls_sslmode = allow
client_tls_cert_file = ${join(this.configDir, 'server.crt')}
client_tls_key_file = ${join(this.configDir, 'server.key')}
`
      : '';

    return `[databases]
${dbEntries}

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = plain
auth_file = /etc/pgbouncer/userlist.txt
pool_mode = transaction
max_client_conn = ${this.intSetting('pgbouncer.maxClientConn', 1000)}
default_pool_size = ${this.intSetting('pgbouncer.defaultPoolSize', 20)}
min_pool_size = ${this.intSetting('pgbouncer.minPoolSize', 5)}
reserve_pool_size = ${this.intSetting('pgbouncer.reservePoolSize', 5)}
reserve_pool_timeout = 3
server_lifetime = 3600
server_idle_timeout = 600
log_connections = 1
log_disconnections = 1
log_pooler_errors = 1
admin_users = pgbouncer_admin
stats_users = pgbouncer_admin
ignore_startup_parameters = extra_float_digits,search_path
${tlsLines}`;
  }

  /** One `[databases]` line; exactly the old line unless a cap applies to this project. */
  private databaseLine(p: PoolerProject, dbClientLimits: boolean): string {
    const base = `${p.dbName} = host=${this.pgHost} port=${this.pgPort} dbname=${p.dbName}`;
    const limit = this.resolveDbConnectionLimit(p);
    if (limit === null) return base;
    // pool_size bounds each (user, database) pool — the owner and the read-only
    // companion each get one — and max_db_connections bounds the database as a
    // whole, so together they can never take more than `limit` backends.
    const clientCap = dbClientLimits
      ? ` max_db_client_connections=${limit * CLIENTS_PER_SERVER_CONNECTION}`
      : '';
    return `${base} pool_size=${limit} max_db_connections=${limit}${clientCap}`;
  }

  private intSetting(key: string, fallback: number): number {
    const raw = this.config.get<number | string | undefined>(key);
    const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
    return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  }

  private ceiling(): number {
    return Math.max(1, this.intSetting('pgbouncer.maxDbConnectionsCeiling', 100));
  }

  /** PGBOUNCER_DEFAULT_MAX_DB_CONNECTIONS, or null when unset — no per-database cap. */
  private platformDefaultLimit(): number | null {
    const raw = this.config.get<number | string | undefined>('pgbouncer.defaultMaxDbConnections');
    if (raw == null || raw === '') return null;
    const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
    return Number.isFinite(n) ? n : null;
  }

  private clamp(value: number): number {
    return Math.min(Math.max(Math.trunc(value), 1), this.ceiling());
  }

  /** The highest per-database cap a project on the given plan may choose. */
  planCeiling(planMaxDbConnections: number | null | undefined): number {
    return planMaxDbConnections ?? this.ceiling();
  }

  /** Effective cap and where it comes from: project override, plan, platform default, or none. */
  describeDbConnectionLimit(p: {
    maxDbConnections?: number | null;
    planMaxDbConnections?: number | null;
  }): { effective: number | null; source: DbConnectionLimitSource } {
    const candidates: [number | null | undefined, DbConnectionLimitSource][] = [
      [p.maxDbConnections, 'project'],
      [p.planMaxDbConnections, 'plan'],
      [this.platformDefaultLimit(), 'platform'],
    ];
    for (const [raw, source] of candidates) {
      if (raw == null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      return { effective: this.clamp(n), source };
    }
    return { effective: null, source: 'none' };
  }

  resolveDbConnectionLimit(p: PoolerProject): number | null {
    return this.describeDbConnectionLimit({
      maxDbConnections: p.maxDbConnections,
      planMaxDbConnections: p.team?.subscription?.plan?.maxDbConnections,
    }).effective;
  }

  /** `SHOW VERSION` answers "PgBouncer 1.25.1"; only major.minor matter here. */
  static parsePgBouncerVersion(text: string): { major: number; minor: number } | null {
    const m = /(\d+)\.(\d+)/.exec(text || '');
    return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
  }

  /** max_db_client_connections exists since PgBouncer 1.24. */
  static supportsDbClientLimitsAt(v: { major: number; minor: number } | null): boolean {
    if (!v) return false;
    return v.major > 1 || (v.major === 1 && v.minor >= 24);
  }

  private dbClientLimitsSupported: boolean | null = null;

  /**
   * Whether to write max_db_client_connections. Off unless asked for, and even
   * then only once the pooler has confirmed a version that knows the key: an
   * unknown parameter is tolerated by RELOAD but refused at the next restart,
   * which would take external database access down for every tenant.
   */
  private async supportsDbClientLimits(): Promise<boolean> {
    if (!this.config.get<boolean>('pgbouncer.dbClientLimits')) return false;
    if (this.dbClientLimitsSupported !== null) return this.dbClientLimitsSupported;
    const version = await this.detectVersion();
    const ok = PgBouncerService.supportsDbClientLimitsAt(version);
    if (!ok) {
      this.logger.warn(
        `PgBouncer ${version ? `${version.major}.${version.minor}` : 'version unknown'}: per-database client limits need 1.24+, max_db_client_connections not written`,
      );
    }
    // A known version is final for this process; a failed check is retried next time.
    if (version) this.dbClientLimitsSupported = ok;
    return ok;
  }

  private async detectVersion(): Promise<{ major: number; minor: number } | null> {
    const pool = this.adminPool();
    try {
      const client = await pool.connect();
      try {
        const { rows } = await client.query('SHOW VERSION');
        const first = rows?.[0] ? Object.values(rows[0] as Record<string, unknown>)[0] : '';
        return PgBouncerService.parsePgBouncerVersion(String(first ?? ''));
      } finally {
        client.release();
      }
    } catch (err: any) {
      this.logger.warn(`PgBouncer version check failed: ${err.message}`);
      return null;
    } finally {
      await pool.end().catch(() => {});
    }
  }

  /** A short-lived connection to the pooler's admin console. */
  private adminPool(): Pool {
    return new Pool({
      host: this.config.get<string>('pgbouncer.host') || 'pgbouncer',
      port: this.config.get<number>('pgbouncer.port') || 6432,
      database: 'pgbouncer',
      user: 'pgbouncer_admin',
      password: this.adminPassword,
      connectionTimeoutMillis: 5000,
    });
  }

  /**
   * Ensure a self-signed TLS cert exists in the shared config volume so
   * PgBouncer can offer TLS to clients. Generated once with openssl (present
   * in the platform-api image); returns false on any failure so the caller
   * falls back to a plaintext-only config rather than a broken one.
   */
  private async ensureTlsCert(): Promise<boolean> {
    const certPath = join(this.configDir, 'server.crt');
    const keyPath = join(this.configDir, 'server.key');

    try {
      await access(certPath);
      await access(keyPath);
      return true;
    } catch {
      // Not present yet — generate below.
    }

    const cn = this.config.get<string>('pgbouncer.externalHost') || 'localhost';
    try {
      await execFileAsync('openssl', [
        'req', '-new', '-x509', '-nodes', '-days', '3650',
        '-keyout', keyPath,
        '-out', certPath,
        '-subj', `/CN=${cn}`,
      ]);
      // PgBouncer runs as a different user than platform-api in the shared
      // volume, so the key must be group/other-readable for it to load.
      await chmod(certPath, 0o644);
      await chmod(keyPath, 0o644);
      this.logger.log(`Generated self-signed TLS cert for PgBouncer (CN=${cn})`);
      return true;
    } catch (err: any) {
      this.logger.warn(
        `PgBouncer TLS cert generation failed; continuing without client TLS: ${err.message}`,
      );
      return false;
    }
  }

  /**
   * The pooler's admin password.
   *
   * This used to fall back to a literal that is published in this repository,
   * while the override was never passed through in any compose file — so the
   * published value was the live one. The pooler listens on 0.0.0.0 with
   * auth_type = plain and port 6432 is public, so that literal let a stranger
   * open the admin console and run SHOW, PAUSE, KILL or SHUTDOWN against every
   * tenant's connections.
   *
   * A random value is generated when none is configured rather than throwing,
   * so an existing self-hosted install keeps starting — but it is never a
   * value anyone can read. The same process writes the userlist and opens the
   * admin connection, so a generated password is consistent for both.
   */
  private readonly adminPassword: string = (() => {
    const configured = process.env.PGBOUNCER_ADMIN_PASSWORD;
    if (configured) return configured;
    const generated = randomBytes(24).toString('base64url');
    new Logger(PgBouncerService.name).warn(
      'PGBOUNCER_ADMIN_PASSWORD is not set — generated a random one for this process. Set it explicitly so the value survives a restart.',
    );
    return generated;
  })();

  private buildUserlist(projects: PoolerProject[]): string {
    const lines: string[] = [];
    for (const p of projects) {
      lines.push(`"${p.dbUser}" "${p.dbPassword}"`);
      // The read-only companion logs in through the pooler too, so it needs its
      // own entry — only once both halves of the credential exist.
      if (p.dbReadonlyUser && p.dbReadonlyPassword) {
        lines.push(`"${p.dbReadonlyUser}" "${p.dbReadonlyPassword}"`);
      }
    }

    lines.push(`"pgbouncer_admin" "${this.adminPassword}"`);

    return lines.join('\n') + '\n';
  }

  private async sendReload(): Promise<void> {
    const pool = this.adminPool();

    try {
      const client = await pool.connect();
      try {
        await client.query('RELOAD');
        this.logger.log('PgBouncer RELOAD sent via admin console');
      } finally {
        client.release();
      }
    } catch (err: any) {
      this.logger.warn(`PgBouncer reload failed: ${err.message}`);
    } finally {
      await pool.end().catch(() => {});
    }
  }
}
