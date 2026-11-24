import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';

/** How long a project stays in the trash before it is deleted for good. */
export const TRASH_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How long before that the owners are told. */
export const PURGE_WARNING_BEFORE_MS = 6 * 60 * 60 * 1000;

const HOUR = 60 * 60 * 1000;

export function hoursLeft(deletedAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((deletedAt.getTime() + TRASH_RETENTION_MS - now.getTime()) / HOUR));
}

/** The name the owner knows: a trashed project carries an internal "_deleted" suffix (the dashboard strips it the same way). */
export function trashedDisplayName(name: string): string {
  return name.replace(/_(\d+_)?deleted$/, '') || name;
}

/** One key per user and deletion: a project restored and deleted again is announced again. */
export function purgeWarningKey(projectId: string, deletedAt: Date): string {
  return `trash-purge:${projectId}:${deletedAt.getTime()}`;
}

/**
 * Tells the people responsible for a project in the trash that it is about to
 * be deleted permanently (#262): a bell notification and one e-mail each, sent
 * once, about six hours before the hourly purge removes it. The recipients are
 * whoever created it and the organization's owners, the same people the idle
 * warning goes to.
 */
@Injectable()
export class ProjectTrashNoticeService {
  private readonly logger = new Logger(ProjectTrashNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  // Minute 17, away from the purge on the hour.
  @Cron('17 * * * *')
  async run(now: Date = new Date()): Promise<number> {
    const projects = await this.prisma.project.findMany({
      where: {
        status: 'DELETED',
        deletedAt: {
          gt: new Date(now.getTime() - TRASH_RETENTION_MS),
          lte: new Date(now.getTime() - (TRASH_RETENTION_MS - PURGE_WARNING_BEFORE_MS)),
        },
      },
      select: { id: true, name: true, teamId: true, createdBy: true, deletedAt: true },
    });

    let notified = 0;
    for (const project of projects) {
      if (!project.deletedAt) continue;
      try {
        notified += await this.notify(project as typeof project & { deletedAt: Date }, now);
      } catch (err: any) {
        this.logger.warn(`Purge warning for "${project.name}" failed: ${err?.message ?? err}`);
      }
    }
    if (notified > 0) this.logger.log(`Purge warning sent to ${notified} recipient(s)`);
    return notified;
  }

  private async notify(
    project: { id: string; name: string; teamId: string; createdBy: string | null; deletedAt: Date },
    now: Date,
  ): Promise<number> {
    const members = await this.prisma.teamMember.findMany({
      where: {
        teamId: project.teamId,
        OR: [{ role: 'OWNER' }, ...(project.createdBy ? [{ userId: project.createdBy }] : [])],
      },
      select: { userId: true, user: { select: { email: true } } },
    });
    const hours = hoursLeft(project.deletedAt, now);
    const name = trashedDisplayName(project.name);
    const dedupeKey = purgeWarningKey(project.id, project.deletedAt);
    const seen = new Set<string>();
    let sent = 0;

    for (const m of members) {
      if (seen.has(m.userId)) continue;
      seen.add(m.userId);
      // The notification row is the "already told" marker: a repeat run creates nothing and sends nothing.
      const { count } = await this.prisma.notification.createMany({
        data: [
          {
            userId: m.userId,
            type: 'project.purge_warning',
            title: 'Project in the trash will be deleted',
            message: `"${name}" will be deleted permanently in about ${hours} ${hours === 1 ? 'hour' : 'hours'}. Restore it from the trash to keep it.`,
            href: '/dashboard/projects?view=trash',
            dedupeKey,
          },
        ],
        skipDuplicates: true,
      });
      if (count === 0) continue;
      sent++;
      const address = m.user?.email?.trim();
      if (!address) continue;
      try {
        await this.email.sendProjectPurgeWarning(address, name, hours);
      } catch (err: any) {
        this.logger.warn(`Purge warning e-mail for "${project.name}" to ${address} failed: ${err?.message ?? err}`);
      }
    }
    return sent;
  }
}
