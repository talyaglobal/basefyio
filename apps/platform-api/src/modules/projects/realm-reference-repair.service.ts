import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';

/**
 * One-time self-heal for projects whose keycloak_realm column carries a
 * legacy "_del{timestamp}" archived suffix. The old trash flow wrote that
 * suffix into the DB while the realm in Keycloak kept its original name
 * (Keycloak has no realm rename), so after a restore the project pointed at
 * a realm that never existed and the real realm stayed disabled — breaking
 * auth exports, the Auth tab, and end-user logins.
 *
 * Idempotent: once no rows match the legacy pattern this is a no-op at boot.
 */
@Injectable()
export class RealmReferenceRepairService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RealmReferenceRepairService.name);
  private attemptsLeft = 3;

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
  ) {}

  onApplicationBootstrap() {
    // Fire-and-forget so a slow/unready Keycloak never delays API boot.
    void this.runWithRetry();
  }

  private async runWithRetry(): Promise<void> {
    this.attemptsLeft -= 1;
    try {
      await this.repair();
    } catch (err: any) {
      if (this.attemptsLeft > 0) {
        this.logger.warn(
          `Realm reference repair failed (${err?.message}); retrying in 60s`,
        );
        setTimeout(() => void this.runWithRetry(), 60_000);
      } else {
        this.logger.error(`Realm reference repair gave up: ${err?.message}`);
      }
    }
  }

  private async repair(): Promise<void> {
    const broken = await this.prisma.project.findMany({
      where: { keycloakRealm: { contains: '_del' } },
      select: { id: true, slug: true, status: true, keycloakRealm: true },
    });
    const legacy = broken.filter((p) => /(_del\d+)+$/.test(p.keycloakRealm));
    if (legacy.length === 0) return;

    for (const project of legacy) {
      const stripped = project.keycloakRealm.replace(/(_del\d+)+$/, '');
      try {
        if (!(await this.keycloak.realmExists(stripped))) {
          // Historical edge: the realm genuinely carries the archived name.
          if (await this.keycloak.realmExists(project.keycloakRealm)) continue;
          this.logger.warn(
            `Realm repair: neither "${stripped}" nor "${project.keycloakRealm}" exists for project ${project.slug}`,
          );
          continue;
        }
        if (project.status === 'ACTIVE') {
          await this.keycloak.enableRealm(stripped);
        }
        await this.prisma.project.update({
          where: { id: project.id },
          data: { keycloakRealm: stripped },
        });
        this.logger.log(
          `Realm repair: ${project.slug} → "${stripped}"${project.status === 'ACTIVE' ? ' (enabled)' : ''}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `Realm repair failed for ${project.slug}: ${err?.message}`,
        );
      }
    }
  }
}
