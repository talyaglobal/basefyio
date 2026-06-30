import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Pool } from 'pg';
import { access, chmod, writeFile } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

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
    const projects = await this.prisma.project.findMany({
      where: { status: 'ACTIVE' },
      select: { dbName: true, dbUser: true, dbPassword: true },
    });

    // Opportunistic client TLS so customers can connect with sslmode=require
    // (migrations, pgAdmin, DBeaver). Only enabled if the cert is actually in
    // place — a missing cert with client_tls_* set would stop PgBouncer from
    // starting and take down DB access for every project.
    const tlsReady = await this.ensureTlsCert();

    const iniContent = this.buildIni(projects, tlsReady);
    const userlistContent = this.buildUserlist(projects);

    await writeFile(join(this.configDir, 'pgbouncer.ini'), iniContent, 'utf-8');
    await writeFile(join(this.configDir, 'userlist.txt'), userlistContent, 'utf-8');

    this.logger.log(`PgBouncer config written: ${projects.length} project(s)`);

    await this.sendReload();
  }

  private buildIni(
    projects: { dbName: string; dbUser: string }[],
    tlsReady: boolean,
  ): string {
    const dbEntries = projects
      .map((p) => `${p.dbName} = host=${this.pgHost} port=${this.pgPort} dbname=${p.dbName}`)
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
${tlsLines}`;
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

  private buildUserlist(
    projects: { dbUser: string; dbPassword: string }[],
  ): string {
    const lines = projects.map((p) => `"${p.dbUser}" "${p.dbPassword}"`);

    const adminUser =
      this.config.get<string>('pgbouncer.adminUser') || 'pgbouncer_admin';
    const adminPassword =
      this.config.get<string>('pgbouncer.adminPassword') || 'pgbouncer_admin_pass';
    lines.push(`"${adminUser}" "${adminPassword}"`);

    return lines.join('\n') + '\n';
  }

  private async sendReload(): Promise<void> {
    const host = this.config.get<string>('pgbouncer.host') || 'pgbouncer';
    const port = this.config.get<number>('pgbouncer.port') || 6432;

    const pool = new Pool({
      host,
      port,
      database: 'pgbouncer',
      user: this.config.get<string>('pgbouncer.adminUser') || 'pgbouncer_admin',
      password:
        this.config.get<string>('pgbouncer.adminPassword') ||
        'pgbouncer_admin_pass',
      connectionTimeoutMillis: 5000,
    });

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
