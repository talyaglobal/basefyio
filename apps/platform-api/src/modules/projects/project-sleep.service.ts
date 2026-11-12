import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PgBouncerService } from '../pgbouncer/pgbouncer.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { ProjectActivityKind, ProjectActivityService } from './project-activity.service';

/**
 * Put quiet projects to sleep, and tell their owners.
 *
 * A project nobody calls still occupies a database, a connection slot and a
 * place in every nightly job. Sleeping one costs the customer nothing: the
 * database, the files and the users stay exactly where they are, the project
 * keeps its place in the plan, and one click in the dashboard wakes it.
 * `PAUSED` is the state for that — `ApiKeyGuard` only admits `ACTIVE`, so a
 * sleeping project stops answering the moment it is marked.
 *
 * Not `DEACTIVATED`: that state means the customer switched the project off
 * themselves, it releases the plan slot, and the platform permanently deletes
 * it fourteen days later. Falling quiet must never start a countdown to
 * deletion.
 *
 * Two things decide that a project is quiet, and it has to be both:
 *
 *   1. no API request has been counted (`ProjectUsage.lastRequestAt`), and
 *   2. nobody has worked on it in the dashboard (no activity-log entry
 *      attributed to a user).
 *
 * The second matters. Request counting only sees calls that carry a project
 * key or `x-project-id`, so a developer who spent the week building tables in
 * the dashboard would otherwise look idle and have their project shut under
 * them.
 *
 * The owner is warned first, with days to spare, and a project that is used
 * again has its warning cleared — so a project that goes quiet a second time
 * is warned a second time rather than disappearing without notice.
 */

/** Everything here is per-install, and the sweep is off until switched on. */
export interface SleepSettings {
  enabled: boolean;
  idleDays: number;
  warnDays: number;
  /** Most projects slept in one pass; the rest wait for the next day. */
  maxPerRun: number;
  /**
   * Past this many quiet days a project is put to sleep without the three-day
   * warning. A warning exists to give someone time to keep a project they
   * still want; one sent to a project nobody has touched in three months only
   * delays the saving, and the single "it is asleep" notice says the same
   * things anyway. Set it to a very large number to always warn first.
   */
  straightToSleepDays: number;
  /**
   * When request counting began. Every project's "last seen" is floored at
   * this moment, so none can look quiet until a full idle window has passed
   * since the counter went live.
   *
   * Without it the first sweep after deployment would read an empty column,
   * conclude that every project on the platform had never been called, and
   * mail every customer at once. Required: the sweep refuses to run without
   * it rather than guessing.
   */
  signalSince: Date | null;
}

/** A project young enough that nobody has had a chance to use it yet is left alone. */
const MIN_AGE_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

function parseSignalSince(raw: string | undefined): Date | null {
  if (!raw) return null;
  const at = new Date(raw);
  return isNaN(at.getTime()) ? null : at;
}

const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY_MS);

interface Candidate {
  id: string;
  name: string;
  slug: string;
  teamId: string;
  createdBy: string | null;
  createdAt: Date;
  idleWarningSentAt: Date | null;
  lastSeenAt: Date;
  idleDays: number;
}

@Injectable()
export class ProjectSleepService {
  private readonly logger = new Logger(ProjectSleepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly activity: ProjectActivityService,
    private readonly pgbouncer: PgBouncerService,
  ) {}

  settings(): SleepSettings {
    const idleDays = parseInt(process.env.PROJECT_SLEEP_IDLE_DAYS || '14', 10);
    const warnDays = parseInt(process.env.PROJECT_SLEEP_WARN_DAYS || '3', 10);
    return {
      enabled: process.env.PROJECT_SLEEP_ENABLED === 'true',
      idleDays: idleDays > 0 ? idleDays : 14,
      // The warning has to land before the sleep, and after the project has
      // actually been quiet for a while.
      warnDays: warnDays > 0 && warnDays < idleDays ? warnDays : 3,
      maxPerRun: parseInt(process.env.PROJECT_SLEEP_MAX_PER_RUN || '25', 10),
      straightToSleepDays: parseInt(process.env.PROJECT_SLEEP_STRAIGHT_TO_SLEEP_DAYS || '30', 10),
      signalSince: parseSignalSince(process.env.PROJECT_SLEEP_SIGNAL_SINCE),
    };
  }

  /** Early morning, after the nightly backups have finished. */
  @Cron('30 5 * * *')
  async sweep(): Promise<{ warned: number; slept: number; considered: number }> {
    const settings = this.settings();
    if (!settings.enabled) return { warned: 0, slept: 0, considered: 0 };
    if (!settings.signalSince) {
      this.logger.warn(
        'Idle sweep is enabled but PROJECT_SLEEP_SIGNAL_SINCE is not set; refusing to run, ' +
          'because without it every project looks unused.',
      );
      return { warned: 0, slept: 0, considered: 0 };
    }

    const now = new Date();
    let candidates: Candidate[];
    try {
      candidates = await this.findQuietProjects(now, settings);
    } catch (err: any) {
      this.logger.error(`Idle sweep could not read project activity: ${err.message}`);
      return { warned: 0, slept: 0, considered: 0 };
    }

    let warned = 0;
    let slept = 0;
    for (const project of candidates) {
      try {
        if (project.idleDays >= settings.idleDays) {
          if (slept >= settings.maxPerRun) continue;
          // Never sleep a project whose owner was not told first, unless it
          // has been quiet so long that a warning would only postpone the
          // saving — the notice it gets instead says the same things.
          if (!project.idleWarningSentAt && project.idleDays < settings.straightToSleepDays) {
            if (await this.warn(project, settings)) warned++;
            continue;
          }
          await this.sleep(project);
          slept++;
        } else if (!project.idleWarningSentAt) {
          if (await this.warn(project, settings)) warned++;
        }
      } catch (err: any) {
        this.logger.error(`Idle sweep failed on ${project.slug}: ${err.message}`);
      }
    }

    if (slept > 0) {
      // Where the saving actually lands. The pooler's configuration is built
      // from the ACTIVE projects, so until it is rewritten a sleeping project
      // keeps its pool — and with min_pool_size that is real connections and
      // real memory held open for a project nobody is calling.
      await this.pgbouncer.regenerateConfig().catch((err) =>
        this.logger.warn(`Could not rewrite the pooler configuration after sleeping projects: ${err.message}`),
      );
    }
    if (warned || slept) {
      this.logger.log(`Idle sweep: ${warned} warned, ${slept} put to sleep (${candidates.length} quiet)`);
    }
    return { warned, slept, considered: candidates.length };
  }

  /**
   * Live projects that have neither served a request nor been worked on since
   * the warning threshold. One query: the per-project subqueries this used to
   * need took minutes across a few hundred projects.
   */
  private async findQuietProjects(now: Date, settings: SleepSettings): Promise<Candidate[]> {
    const quietSince = new Date(now.getTime() - (settings.idleDays - settings.warnDays) * DAY_MS);
    const youngerThan = new Date(now.getTime() - MIN_AGE_DAYS * DAY_MS);
    const signalSince = settings.signalSince ?? now;

    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        name: string;
        slug: string;
        team_id: string;
        created_by: string | null;
        created_at: Date;
        idle_warning_sent_at: Date | null;
        last_seen: Date;
      }>
    >`
      with activity as (
        select project_id, max(created_at) as at
          from project_activity_logs
         where user_id is not null
         group by project_id
      )
      select p.id, p.name, p.slug, p.team_id, p.created_by, p.created_at,
             p.idle_warning_sent_at,
             greatest(p.created_at, ${signalSince}, coalesce(u.last_request_at, 'epoch'), coalesce(a.at, 'epoch')) as last_seen
        from projects p
        left join project_usage u on u.project_id = p.id
        left join activity a on a.project_id = p.id
       where p.status = 'ACTIVE'
         and p.created_at < ${youngerThan}
         and greatest(p.created_at, ${signalSince}, coalesce(u.last_request_at, 'epoch'), coalesce(a.at, 'epoch')) < ${quietSince}
       order by last_seen asc
    `;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      teamId: r.team_id,
      createdBy: r.created_by,
      createdAt: r.created_at,
      idleWarningSentAt: r.idle_warning_sent_at,
      lastSeenAt: r.last_seen,
      idleDays: daysBetween(r.last_seen, now),
    }));
  }

  /** The people to tell: whoever created the project, and the team's owners. */
  private async recipients(project: Candidate): Promise<string[]> {
    const members = await this.prisma.teamMember.findMany({
      where: { teamId: project.teamId, OR: [{ role: 'OWNER' }, { userId: project.createdBy ?? '' }] },
      select: { user: { select: { email: true } } },
    });
    const seen = new Set<string>();
    for (const m of members) {
      const email = m.user?.email?.trim();
      if (email) seen.add(email.toLowerCase());
    }
    return [...seen];
  }

  /** Warn, and only record the warning if at least one message was accepted. */
  private async warn(project: Candidate, settings: SleepSettings): Promise<boolean> {
    const to = await this.recipients(project);
    if (to.length === 0) {
      this.logger.warn(`No one to warn about ${project.slug}; leaving it awake`);
      return false;
    }
    const daysLeft = Math.max(1, settings.idleDays - project.idleDays);
    let delivered = 0;
    for (const address of to) {
      try {
        await this.email.sendProjectSleepWarning(
          address,
          project.name,
          project.id,
          project.idleDays,
          daysLeft,
        );
        delivered++;
      } catch (err: any) {
        this.logger.warn(`Sleep warning to ${address} failed: ${err.message}`);
      }
    }
    // A warning nobody received must not start the clock, or the project
    // would be slept without its owner ever hearing about it.
    if (delivered === 0) return false;

    await this.prisma.project.update({
      where: { id: project.id },
      data: { idleWarningSentAt: new Date() },
    });
    await this.activity.append(project.id, {
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title: 'Idle warning sent',
      detail: `No requests for ${project.idleDays} days; the project sleeps in ${daysLeft} unless it is used.`,
    });
    return true;
  }

  private async sleep(project: Candidate): Promise<void> {
    const to = await this.recipients(project);
    let delivered = 0;
    for (const address of to) {
      try {
        await this.email.sendProjectAsleep(address, project.name, project.id, project.idleDays);
        delivered++;
      } catch (err: any) {
        this.logger.warn(`Sleep notice to ${address} failed: ${err.message}`);
      }
    }

    await this.prisma.project.update({
      where: { id: project.id },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
    // An owner we cannot reach does not oblige the platform to keep running a
    // database nobody calls, but it has to be on the record rather than
    // implied by a missing e-mail.
    const unreachable = delivered === 0;
    await this.activity.append(project.id, {
      kind: ProjectActivityKind.PROJECT_UPDATED,
      title: 'Project put to sleep',
      detail:
        `No requests for ${project.idleDays} days. The database, files and users are untouched; ` +
        'reactivating the project from the dashboard brings it back as it was.' +
        (unreachable ? ' No notice could be delivered: no reachable owner address.' : ''),
    });
    this.logger.log(
      `Project ${project.slug} put to sleep after ${project.idleDays} quiet days` +
        (unreachable ? ' (nobody could be notified)' : `, ${delivered} notice(s) sent`),
    );
  }

  /**
   * What the sweep would do, without doing any of it. The root console calls
   * this before the feature is switched on, so the first run is never a
   * surprise.
   */
  async preview(): Promise<{
    settings: SleepSettings;
    wouldWarn: Array<{ slug: string; idleDays: number }>;
    wouldSleep: Array<{ slug: string; idleDays: number }>;
  }> {
    const settings = this.settings();
    const candidates = await this.findQuietProjects(new Date(), settings);
    return {
      settings,
      wouldWarn: candidates
        .filter((p) => !p.idleWarningSentAt)
        .map((p) => ({ slug: p.slug, idleDays: p.idleDays })),
      wouldSleep: candidates
        .filter((p) => p.idleWarningSentAt && p.idleDays >= settings.idleDays)
        .map((p) => ({ slug: p.slug, idleDays: p.idleDays })),
    };
  }
}
