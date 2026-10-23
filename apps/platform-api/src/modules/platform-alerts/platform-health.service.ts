import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Pool } from 'pg';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformAlertsService } from './platform-alerts.service';

/**
 * A daily check that the platform's own records still match reality.
 *
 * Two projects were found with no database at all: their nightly backup had
 * failed every night for over four months, each failure written to the
 * project's activity log and nowhere else, so nobody was told. A backup that
 * cannot run is not a small problem — it is the moment the platform stops
 * being able to give a customer their data back — and it has to reach the
 * operator the same day.
 *
 * Every check aggregates into a single alert naming the projects, so a
 * cluster-wide fault raises one red badge in the root console rather than
 * hundreds. Runs on the elected leader only: CronLeaderService disables
 * scheduled jobs on the other replicas.
 */

/** Consecutive failed nights before a project's backups count as broken. */
const BACKUP_FAILURE_STREAK = 3;
/** How far back to read the activity log when judging that streak. */
const BACKUP_WINDOW_DAYS = 10;
/** Projects named in an alert body before it switches to a count. */
const NAMES_IN_ALERT = 12;

const AUTO_BACKUP_FAILED = 'Daily auto-backup failed';
const AUTO_BACKUP_DONE = 'Daily auto-backup completed';

/**
 * Only the one question this service asks of Keycloak. Taking it as an
 * interface behind a token keeps the admin client — which is ESM-only and
 * drags in the whole SDK — out of this file, so the checks can be unit tested
 * without standing up Keycloak.
 */
export interface RealmProbe {
  realmExists(realmName: string): Promise<boolean>;
}

export const REALM_PROBE = Symbol('REALM_PROBE');

interface LiveProject {
  id: string;
  name: string;
  slug: string;
  dbName: string;
  dbHost: string;
  dbPort: number;
  keycloakRealm: string;
}

function nameList(projects: Array<{ slug: string }>): string {
  const shown = projects.slice(0, NAMES_IN_ALERT).map((p) => p.slug);
  const rest = projects.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

@Injectable()
export class PlatformHealthService {
  private readonly logger = new Logger(PlatformHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(REALM_PROBE) private readonly keycloak: RealmProbe,
    private readonly alerts: PlatformAlertsService,
  ) {}

  /** After the 03:00 auto-backups, so the night's outcome is already recorded. */
  @Cron('0 6 * * *')
  async runDailyCheck(): Promise<void> {
    try {
      const projects = (await this.prisma.project.findMany({
        where: { status: { in: ['ACTIVE', 'PAUSED'] } },
        select: {
          id: true,
          name: true,
          slug: true,
          dbName: true,
          dbHost: true,
          dbPort: true,
          keycloakRealm: true,
        },
      })) as LiveProject[];
      if (projects.length === 0) return;

      await this.checkDatabases(projects);
      await this.checkRealms(projects);
      await this.checkBackups(projects);
    } catch (err: any) {
      // The check exists to report problems; it must never become one.
      this.logger.error(`Platform health check failed: ${err.message}`, err?.stack);
    }
  }

  /**
   * Every live project's database must exist on the cluster it claims to live
   * on. Only the shared cluster is checked: a dedicated project's database
   * lives inside its own container, which has its own health reporting.
   */
  private async checkDatabases(projects: LiveProject[]): Promise<void> {
    const sharedHost = this.config.get<string>('database.host');
    const sharedPort = this.config.get<number>('database.port');
    const shared = projects.filter((p) => p.dbHost === sharedHost && p.dbPort === sharedPort);
    if (shared.length === 0) return;

    const pool = new Pool({
      host: sharedHost,
      port: sharedPort,
      user: this.config.get('database.user'),
      password: this.config.get('database.password'),
      database: 'postgres',
      max: 1,
    });
    let present: Set<string>;
    try {
      const { rows } = await pool.query<{ datname: string }>('SELECT datname FROM pg_database');
      present = new Set(rows.map((r) => r.datname));
    } catch (err: any) {
      this.logger.warn(`Could not list databases: ${err.message}`);
      return;
    } finally {
      await pool.end().catch(() => undefined);
    }

    const missing = shared.filter((p) => !present.has(p.dbName));
    if (missing.length === 0) return;
    await this.alerts.raise({
      kind: 'project_database_missing',
      severity: 'critical',
      title: `${missing.length} live project${missing.length === 1 ? ' has' : 's have'} no database`,
      detail:
        `These projects are ACTIVE or PAUSED but the database their record names does not exist on the ` +
        `cluster, so every request against them fails and nothing can be backed up: ${nameList(missing)}. ` +
        `Either finish provisioning them or move them out of the live statuses.`,
      metadata: { projects: missing.map((p) => ({ id: p.id, slug: p.slug, dbName: p.dbName })) },
    });
  }

  /** Every live project's Keycloak realm must exist, or nobody can sign in to it. */
  private async checkRealms(projects: LiveProject[]): Promise<void> {
    const missing: LiveProject[] = [];
    for (const p of projects) {
      if (!p.keycloakRealm) continue;
      let exists: boolean;
      try {
        exists = await this.keycloak.realmExists(p.keycloakRealm);
      } catch (err: any) {
        // Keycloak being unreachable is not the same as a realm being gone;
        // stop rather than report every project as broken.
        this.logger.warn(`Realm check stopped at ${p.slug}: ${err.message}`);
        return;
      }
      if (!exists) missing.push(p);
    }
    if (missing.length === 0) return;
    await this.alerts.raise({
      kind: 'project_realm_missing',
      severity: 'critical',
      title: `${missing.length} live project${missing.length === 1 ? ' has' : 's have'} no authentication realm`,
      detail:
        `Keycloak does not serve the realm these projects name, so sign-in on them returns 404: ` +
        `${nameList(missing)}. If a realm exists in the database but is not served, suspect the realm ` +
        `lookup index before recreating anything.`,
      metadata: { projects: missing.map((p) => ({ id: p.id, slug: p.slug, realm: p.keycloakRealm })) },
    });
  }

  /**
   * A project whose last {@link BACKUP_FAILURE_STREAK} nightly backups all
   * failed, with no success since, has no recoverable copy of its data.
   */
  private async checkBackups(projects: LiveProject[]): Promise<void> {
    const since = new Date(Date.now() - BACKUP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const rows = await this.prisma.projectActivityLog.findMany({
      where: { createdAt: { gte: since }, title: { in: [AUTO_BACKUP_FAILED, AUTO_BACKUP_DONE] } },
      select: { projectId: true, title: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const failures = new Map<string, number>();
    const succeeded = new Set<string>();
    for (const row of rows) {
      // Rows arrive newest first, so the first success ends that project's streak.
      if (succeeded.has(row.projectId)) continue;
      if (row.title === AUTO_BACKUP_DONE) {
        succeeded.add(row.projectId);
        continue;
      }
      failures.set(row.projectId, (failures.get(row.projectId) ?? 0) + 1);
    }

    const byId = new Map(projects.map((p) => [p.id, p]));
    const broken = [...failures.entries()]
      .filter(([id, n]) => n >= BACKUP_FAILURE_STREAK && byId.has(id))
      .map(([id, n]) => ({ project: byId.get(id) as LiveProject, nights: n }));
    if (broken.length === 0) return;

    const worst = Math.max(...broken.map((b) => b.nights));
    await this.alerts.raise({
      kind: 'project_backup_failing',
      severity: 'critical',
      title: `Nightly backup has failed ${BACKUP_FAILURE_STREAK}+ nights running for ${broken.length} project${broken.length === 1 ? '' : 's'}`,
      detail:
        `No recoverable copy is being produced for: ${nameList(broken.map((b) => b.project))}. ` +
        `The worst has failed ${worst} of the last ${BACKUP_WINDOW_DAYS} nights. Each failure is recorded ` +
        `in the project's activity log with the reason.`,
      metadata: {
        projects: broken.map((b) => ({ id: b.project.id, slug: b.project.slug, nights: b.nights })),
      },
    });
  }
}
