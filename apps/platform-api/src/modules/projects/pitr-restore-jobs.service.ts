import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { randomBytes } from 'crypto';
import { hostname } from 'os';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformAlertsService } from '../platform-alerts/platform-alerts.service';
import {
  PitrRestoreError,
  PitrRestorePhase,
  ProjectPitrService,
  restoreTimeoutMs,
} from './project-pitr.service';
import { ProjectActivityKind, ProjectActivityService } from './project-activity.service';

export type PitrRestoreStatus = 'queued' | 'running' | 'succeeded' | 'failed';

/** What the API returns for a restore job. The operator `error` column is never included. */
export interface PitrRestoreJobView {
  jobId: string;
  projectId: string;
  status: PitrRestoreStatus;
  phase: string;
  message: string | null;
  targetTime: string;
  method: string | null;
  exact: boolean | null;
  restoredTo: string | null;
  queuePosition: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** One key for every restore decision, so admission and claiming never race across replicas. */
const PITR_JOB_LOCK_KEY = 257_257_001;

/** A running job refreshes its heartbeat this often… */
const HEARTBEAT_MS = 30_000;
/** …and one that has been quiet this long belongs to a process that died. */
const HEARTBEAT_STALE_MS = 3 * 60_000;

const intFromEnv = (name: string, fallback: number) => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/**
 * Limits, read on every call so an operator can change them without a build:
 *  - PITR_RESTORE_ENABLED=false     refuse new restores (503); running ones finish.
 *  - PITR_RESTORE_MAX_CONCURRENT    restores running at once, cluster-wide (1).
 *  - PITR_RESTORE_MAX_QUEUED        restores waiting, cluster-wide (5).
 *  - PITR_RESTORE_MAX_PER_HOUR      restores one project may request per hour (3).
 *  - PITR_RESTORE_QUEUE_MAX_MINUTES a job still waiting after this fails (120).
 */
export const pitrLimits = () => ({
  enabled: !/^(false|off|0|no)$/i.test(process.env.PITR_RESTORE_ENABLED ?? ''),
  maxConcurrent: intFromEnv('PITR_RESTORE_MAX_CONCURRENT', 1),
  maxQueued: intFromEnv('PITR_RESTORE_MAX_QUEUED', 5),
  maxPerHour: intFromEnv('PITR_RESTORE_MAX_PER_HOUR', 3),
  queueMaxMs: intFromEnv('PITR_RESTORE_QUEUE_MAX_MINUTES', 120) * 60_000,
});

type JobRow = {
  id: string;
  projectId: string;
  requestedBy: string | null;
  targetTime: Date;
  status: string;
  phase: string;
  message: string | null;
  method: string | null;
  exact: boolean | null;
  restoredTo: Date | null;
  runId: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

class PitrTimeoutError extends Error {
  constructor() {
    super('restore timed out');
    this.name = 'PitrTimeoutError';
  }
}

class PitrShutdownError extends Error {
  constructor() {
    super('platform restart');
    this.name = 'PitrShutdownError';
  }
}

/**
 * Point-in-time restores as background jobs (#257).
 *
 * A restore downloads a full physical copy of the cluster, replays WAL in a
 * throwaway instance and only then writes into the project's database — many
 * minutes of work. Run inside the request it outlived every proxy timeout
 * (status 0 after 65 s, 500, 502), and each retry started another full copy
 * beside the first on the volume the live cluster writes to.
 *
 * Now the request only validates and queues (202 + job id). Jobs live in
 * Postgres so any replica can answer the status poll; admission and claiming
 * run under one advisory lock, which is what makes "one per project" and the
 * cluster-wide cap hold with several replicas. The replica that claims a job
 * runs it, refreshes its heartbeat, and stops it at the hard deadline.
 */
@Injectable()
export class PitrRestoreJobsService implements OnApplicationShutdown {
  private readonly logger = new Logger(PitrRestoreJobsService.name);
  private readonly workerId = `${hostname()}-${randomBytes(4).toString('hex')}`;
  /** Jobs this process is running, with the controller that stops each. */
  private readonly running = new Map<string, AbortController>();
  private pumping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pitr: ProjectPitrService,
    private readonly activity: ProjectActivityService,
    private readonly alerts: PlatformAlertsService,
  ) {}

  // ── Requests ───────────────────────────────────────────────────────────────

  /** Validate and queue a restore. Answers at once; the work runs in the background. */
  async start(projectId: string, userId: string, targetTime: string): Promise<PitrRestoreJobView> {
    const limits = pitrLimits();
    const project = await this.pitr.loadProjectForMember(projectId, userId);
    if (!limits.enabled) {
      throw new ServiceUnavailableException(
        'Point-in-time recovery is paused by the platform team right now. Your database was not changed; please try again later or contact support.',
      );
    }
    const target = await this.pitr.validateRestoreTarget(project, targetTime);

    const job = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${PITR_JOB_LOCK_KEY})`);

      const active = await tx.pitrRestoreJob.findFirst({
        where: { projectId, status: { in: ['queued', 'running'] } },
        orderBy: { createdAt: 'desc' },
      });
      if (active) {
        throw new ConflictException({
          statusCode: HttpStatus.CONFLICT,
          message: 'A point-in-time restore is already in progress for this project. Wait for it to finish.',
          details: { jobId: active.id },
        });
      }

      const recent = await tx.pitrRestoreJob.count({
        where: { projectId, createdAt: { gte: new Date(Date.now() - 60 * 60_000) } },
      });
      if (recent >= limits.maxPerHour) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: `A project can start at most ${limits.maxPerHour} point-in-time restores per hour. Try again later.`,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      const queued = await tx.pitrRestoreJob.count({ where: { status: 'queued' } });
      if (queued >= limits.maxQueued) {
        throw new ServiceUnavailableException(
          'Too many point-in-time restores are waiting right now. Your database was not changed; please try again in a few minutes.',
        );
      }

      return tx.pitrRestoreJob.create({
        data: {
          projectId,
          requestedBy: userId,
          targetTime: target,
          status: 'queued',
          phase: 'waiting',
          message: 'Waiting for a free restore slot',
        },
      });
    });

    this.logger.log(`PITR restore ${job.id} queued for project ${projectId} → ${target.toISOString()}`);
    // Start it now when a slot is free rather than at the next pump.
    void this.pump().catch((err) => this.logger.warn(`PITR pump failed: ${err?.message}`));
    return this.view(job, await this.queuePosition(job));
  }

  /** One job of this project. */
  async get(projectId: string, jobId: string, userId: string): Promise<PitrRestoreJobView> {
    await this.pitr.loadProjectForMember(projectId, userId);
    const job = await this.prisma.pitrRestoreJob.findFirst({ where: { id: jobId, projectId } });
    if (!job) throw new NotFoundException('Restore job not found');
    return this.view(job, await this.queuePosition(job));
  }

  /** The project's newest restore job, so a reloaded dashboard can pick an active one back up. */
  async latest(projectId: string, userId: string): Promise<{ job: PitrRestoreJobView | null }> {
    await this.pitr.loadProjectForMember(projectId, userId);
    const job = await this.prisma.pitrRestoreJob.findFirst({
      where: { projectId },
      orderBy: { createdAt: 'desc' },
    });
    return { job: job ? this.view(job, await this.queuePosition(job)) : null };
  }

  // ── Scheduling ─────────────────────────────────────────────────────────────

  /**
   * Fail jobs whose process died or that waited too long, then start queued
   * ones while the cluster-wide cap allows. Runs on the cron leader and right
   * after each request; the lock makes concurrent pumps harmless.
   */
  @Cron(CronExpression.EVERY_30_SECONDS)
  async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await this.reapStale();
      for (;;) {
        const job = await this.claimNext();
        if (!job) break;
        void this.run(job);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Mark dead and over-waited jobs failed, and clean up what a dead run left behind. */
  async reapStale(): Promise<number> {
    const now = Date.now();
    const limits = pitrLimits();
    const dead = await this.prisma.pitrRestoreJob.findMany({
      where: {
        OR: [
          {
            status: 'running',
            OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: new Date(now - HEARTBEAT_STALE_MS) } }],
          },
          { status: 'queued', createdAt: { lt: new Date(now - limits.queueMaxMs) } },
        ],
      },
    });
    for (const job of dead) {
      if (this.running.has(job.id)) continue;
      const wasRunning = job.status === 'running';
      const message = wasRunning
        ? 'The restore was interrupted by a platform restart before it finished. ' +
          (job.phase === 'restoring'
            ? 'Writing into your database had started; check your data or start the restore again.'
            : 'Your database was not changed. Start it again.')
        : 'The restore waited too long for a free slot and was cancelled. Your database was not changed.';
      const updated = await this.prisma.pitrRestoreJob.updateMany({
        where: { id: job.id, status: job.status },
        data: {
          status: 'failed',
          message,
          error: wasRunning ? `heartbeat stale (worker ${job.phase})` : 'queue wait exceeded',
          finishedAt: new Date(),
        },
      });
      if (updated.count && job.runId) await this.pitr.cleanupRun(job.runId).catch(() => undefined);
      if (updated.count) this.logger.warn(`PITR restore ${job.id} failed by the reaper: ${message}`);
    }
    return dead.length;
  }

  /** Take the oldest queued job when the cap allows, atomically across replicas. */
  async claimNext(): Promise<JobRow | null> {
    const limits = pitrLimits();
    if (!limits.enabled) return null;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(${PITR_JOB_LOCK_KEY})`);
      const runningNow = await tx.pitrRestoreJob.count({ where: { status: 'running' } });
      if (runningNow >= limits.maxConcurrent) return null;
      const next = await tx.pitrRestoreJob.findFirst({
        where: { status: 'queued' },
        orderBy: { createdAt: 'asc' },
      });
      if (!next) return null;
      const now = new Date();
      return tx.pitrRestoreJob.update({
        where: { id: next.id },
        data: {
          status: 'running',
          phase: 'preparing',
          message: 'Starting the restore',
          workerId: this.workerId,
          startedAt: now,
          heartbeatAt: now,
        },
      });
    });
  }

  /** Run one claimed job to its end. Never throws: every outcome lands on the row. */
  async run(job: JobRow): Promise<void> {
    const controller = new AbortController();
    this.running.set(job.id, controller);
    const timeoutMs = restoreTimeoutMs();
    const deadline = setTimeout(() => controller.abort(new PitrTimeoutError()), timeoutMs);
    deadline.unref();
    const heartbeat = setInterval(() => {
      void this.prisma.pitrRestoreJob
        .updateMany({ where: { id: job.id, status: 'running' }, data: { heartbeatAt: new Date() } })
        .catch(() => undefined);
    }, HEARTBEAT_MS);
    heartbeat.unref();
    let phase: PitrRestorePhase = 'preparing';

    try {
      const project = await this.pitr.loadProject(job.projectId);
      if (!project) throw new PitrRestoreError('The project no longer exists.', 'project gone', false);

      const result = await this.pitr.executeRestore(project, job.targetTime, job.requestedBy, {
        signal: controller.signal,
        phase: async (p, message) => {
          phase = p;
          await this.prisma.pitrRestoreJob
            .updateMany({
              where: { id: job.id, status: 'running' },
              data: { phase: p, message, heartbeatAt: new Date() },
            })
            .catch(() => undefined);
        },
        onRun: async (runId) => {
          await this.prisma.pitrRestoreJob
            .updateMany({ where: { id: job.id }, data: { runId } })
            .catch(() => undefined);
        },
      });

      await this.prisma.pitrRestoreJob.update({
        where: { id: job.id },
        data: {
          status: 'succeeded',
          phase: 'done',
          message: result.message,
          method: result.method,
          exact: result.exact,
          restoredTo: new Date(result.restoredTo),
          finishedAt: new Date(),
        },
      });
      this.logger.log(`PITR restore ${job.id} succeeded (${result.method})`);
    } catch (caught: any) {
      // Aborting removes the throwaway mid-probe, so the error that surfaces is
      // often Docker's "no such container"; the abort reason is the real cause.
      // An object-by-object load is never aborted, so its own error wins there.
      const err =
        controller.signal.aborted && !(caught instanceof PitrRestoreError) ? controller.signal.reason : caught;
      const { message, detail, alert } = this.describeFailure(err, phase, timeoutMs);
      this.logger.error(`PITR restore ${job.id} for project ${job.projectId} failed: ${detail}`);
      await this.prisma.pitrRestoreJob
        .update({
          where: { id: job.id },
          data: { status: 'failed', message, error: detail.slice(0, 8000), finishedAt: new Date() },
        })
        .catch((e) => this.logger.error(`Could not record PITR failure for ${job.id}: ${e?.message}`));
      await this.activity
        .append(job.projectId, {
          userId: job.requestedBy ?? undefined,
          kind: ProjectActivityKind.PROJECT_PITR_FAILED,
          title: 'Point-in-time recovery failed',
          detail: message,
          metadata: { jobId: job.id, targetTime: job.targetTime.toISOString(), phase },
        })
        .catch(() => undefined);
      if (alert) {
        await this.alerts
          .raise({
            kind: 'pitr_restore_failed',
            severity: 'warning',
            title: 'A point-in-time restore failed',
            detail: `Project ${job.projectId}, job ${job.id}, phase ${phase}: ${detail.slice(0, 1000)}`,
            metadata: { projectId: job.projectId, jobId: job.id, phase },
          })
          .catch(() => undefined);
      }
    } finally {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      this.running.delete(job.id);
      // A slot just freed up.
      void this.pump().catch(() => undefined);
    }
  }

  /** Turn any failure into a message for the dashboard and a detail for the operator. */
  describeFailure(
    err: unknown,
    phase: PitrRestorePhase,
    timeoutMs: number,
  ): { message: string; detail: string; alert: boolean } {
    const minutes = Math.round(timeoutMs / 60_000);
    const untouched = phase !== 'restoring';
    if (err instanceof PitrTimeoutError || (err as any)?.name === 'PitrTimeoutError') {
      return {
        message: `The restore did not finish within ${minutes} minutes and was stopped. ${
          untouched ? 'Your database was not changed.' : 'The write was rolled back, so your database was not changed.'
        }`,
        detail: `timed out after ${minutes} min in phase ${phase}`,
        alert: true,
      };
    }
    if (err instanceof PitrShutdownError || (err as any)?.name === 'PitrShutdownError') {
      return {
        message: 'The restore was interrupted by a platform restart. Your database was not changed. Start it again.',
        detail: `stopped by shutdown in phase ${phase}`,
        alert: false,
      };
    }
    if (err instanceof PitrRestoreError) {
      return { message: err.userMessage, detail: err.detail, alert: err.alert };
    }
    if (err instanceof HttpException) {
      const res = err.getResponse() as any;
      const message = typeof res === 'string' ? res : String(res?.message ?? err.message);
      return { message, detail: message, alert: err.getStatus() >= 500 };
    }
    const detail = String((err as any)?.message ?? err);
    return {
      message: `The restore failed while ${PHASE_VERB[phase]}. ${
        untouched ? 'Your database was not changed. ' : ''
      }Our team has been notified.`,
      detail,
      alert: true,
    };
  }

  /** Stop this process's runs on shutdown so they clean up instead of leaking scratch. */
  onApplicationShutdown(): void {
    for (const controller of this.running.values()) controller.abort(new PitrShutdownError());
  }

  // ── Views ──────────────────────────────────────────────────────────────────

  private async queuePosition(job: JobRow): Promise<number | null> {
    if (job.status !== 'queued') return null;
    const ahead = await this.prisma.pitrRestoreJob.count({
      where: { status: 'queued', createdAt: { lt: job.createdAt } },
    });
    return ahead + 1;
  }

  view(job: JobRow, queuePosition: number | null = null): PitrRestoreJobView {
    return {
      jobId: job.id,
      projectId: job.projectId,
      status: job.status as PitrRestoreStatus,
      phase: job.phase,
      message: job.message,
      targetTime: job.targetTime.toISOString(),
      method: job.method,
      exact: job.exact,
      restoredTo: job.restoredTo ? job.restoredTo.toISOString() : null,
      queuePosition,
      createdAt: job.createdAt.toISOString(),
      startedAt: job.startedAt ? job.startedAt.toISOString() : null,
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    };
  }
}

const PHASE_VERB: Record<PitrRestorePhase, string> = {
  waiting: 'waiting to start',
  preparing: 'preparing',
  downloading: 'downloading the backup',
  replaying: 'replaying the change log',
  extracting: 'extracting your database',
  restoring: 'writing into your database',
  done: 'finishing',
};
