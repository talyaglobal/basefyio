import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { PgBouncerService } from '../pgbouncer/pgbouncer.service';

/**
 * Brings a deactivated project back when a request reaches it without an
 * API key — a public file URL or a signed URL — where ApiKeyGuard, which
 * normally does this, never runs. Same steps as the guard's: flip the status
 * (exactly once under a burst), stamp the request, note it in the activity
 * log, reopen sign-in and rewrite the pooler configuration.
 *
 * The realm and pooler services are looked up lazily so this module does not
 * have to import theirs; a build without them simply skips those steps.
 */
@Injectable()
export class ProjectWakeService {
  private readonly logger = new Logger(ProjectWakeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async wake(project: { id: string; keycloakRealm: string; status: string }): Promise<void> {
    if (project.status !== 'PAUSED') return;
    const { count } = await this.prisma.project.updateMany({
      where: { id: project.id, status: 'PAUSED' },
      data: { status: 'ACTIVE', pausedAt: null, idleWarningSentAt: null },
    });
    if (count === 0) return; // another request got there first

    await this.prisma.projectUsage
      .updateMany({ where: { projectId: project.id }, data: { lastRequestAt: new Date() } })
      .catch(() => undefined);

    await this.prisma.projectActivityLog
      .create({
        data: {
          projectId: project.id,
          kind: 'project.updated',
          title: 'Project activated by a request',
          detail:
            'It had been deactivated after a long quiet spell and a public storage request arrived, so it was brought back. ' +
            'Nothing was lost while it was deactivated.',
        },
      })
      .catch(() => undefined);

    this.logger.log(`Project ${project.id} activated by a public storage request`);

    const keycloak = this.optional(KeycloakAdminService);
    void keycloak?.enableRealm(project.keycloakRealm).catch((err: any) =>
      this.logger.warn(`Realm ${project.keycloakRealm} not re-enabled after activating ${project.id}: ${err?.message ?? err}`),
    );
    const pgbouncer = this.optional(PgBouncerService);
    void pgbouncer?.regenerateConfig().catch((err: any) =>
      this.logger.warn(`Pooler configuration not rewritten after waking ${project.id}: ${err?.message ?? err}`),
    );
  }

  private optional<T>(token: new (...args: any[]) => T): T | undefined {
    try {
      return this.moduleRef.get(token, { strict: false });
    } catch {
      return undefined;
    }
  }
}
