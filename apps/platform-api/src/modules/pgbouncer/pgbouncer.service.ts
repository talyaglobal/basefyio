import {
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { Socket } from 'net';

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

    const iniContent = this.buildIni(projects);
    const userlistContent = this.buildUserlist(projects);

    await writeFile(join(this.configDir, 'pgbouncer.ini'), iniContent, 'utf-8');
    await writeFile(join(this.configDir, 'userlist.txt'), userlistContent, 'utf-8');

    this.logger.log(`PgBouncer config written: ${projects.length} project(s)`);

    await this.sendReload();
  }

  private buildIni(
    projects: { dbName: string; dbUser: string }[],
  ): string {
    const dbEntries = projects
      .map((p) => `${p.dbName} = host=${this.pgHost} port=${this.pgPort} dbname=${p.dbName}`)
      .join('\n');

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
`;
  }

  private buildUserlist(
    projects: { dbUser: string; dbPassword: string }[],
  ): string {
    const lines = projects.map((p) => `"${p.dbUser}" "${p.dbPassword}"`);

    lines.push(`"pgbouncer_admin" "pgbouncer_admin_pass"`);

    return lines.join('\n') + '\n';
  }

  private async sendReload(): Promise<void> {
    const host = this.config.get<string>('pgbouncer.host') || 'pgbouncer';
    const port = this.config.get<number>('pgbouncer.port') || 6432;

    return new Promise((resolve) => {
      const socket = new Socket();
      socket.setTimeout(3000);

      socket.on('error', () => {
        this.logger.warn('PgBouncer reload skipped (not reachable)');
        socket.destroy();
        resolve();
      });

      socket.on('timeout', () => {
        this.logger.warn('PgBouncer reload timed out');
        socket.destroy();
        resolve();
      });

      socket.connect(port, host, () => {
        socket.write('RELOAD;\n');
        socket.end();
        this.logger.log('PgBouncer RELOAD sent');
        resolve();
      });
    });
  }
}
