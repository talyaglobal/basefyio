import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { PgBouncerService } from './pgbouncer.service';
import { projectsToClear, tlsUsersFromClients } from './db-tls-notice';

/**
 * Clears the dashboard's "turn on TLS" notice once a flagged project's database user is
 * connected to the pooler with TLS. Fails closed: when the admin console cannot be read,
 * nothing changes and one warning is logged for the run.
 */
@Injectable()
export class DbTlsNoticeService {
  private readonly logger = new Logger(DbTlsNoticeService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pgbouncer: PgBouncerService,
    private readonly leader: CronLeaderService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async tick(): Promise<void> {
    if (!this.leader.isLeader() || this.running) return;
    this.running = true;
    try {
      await this.run();
    } catch (err: any) {
      this.logger.warn(`DB TLS notice check failed: ${err?.message ?? err}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass; returns the number of notices cleared. */
  async run(): Promise<number> {
    const flagged = await this.prisma.project.findMany({
      where: { dbTlsNoticeAt: { not: null } },
      select: { id: true, dbUser: true },
    });
    if (flagged.length === 0) return 0;

    let rows: Array<Record<string, unknown>>;
    try {
      rows = await this.pgbouncer.showClients();
    } catch (err: any) {
      this.logger.warn(`DB TLS notice: pooler admin console unreachable, nothing changed (${err?.message ?? err})`);
      return 0;
    }

    const ids = projectsToClear(flagged, tlsUsersFromClients(rows));
    if (ids.length === 0) return 0;
    const res = await this.prisma.project.updateMany({
      where: { id: { in: ids }, dbTlsNoticeAt: { not: null } },
      data: { dbTlsNoticeAt: null },
    });
    this.logger.log(`DB TLS notice cleared for ${res.count} project(s) after a TLS connection was seen`);
    return res.count;
  }
}
