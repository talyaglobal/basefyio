import { Injectable, Logger, OnApplicationBootstrap, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { BillingService } from '../billing/billing.service';
import { BootTaskService } from '../cluster/boot-task.service';
import { getDisplayName } from '../../common/utils/display-name';
import { ensureDefaultRolePermissions } from '../teams/role-permissions';
import { newPublicId } from './public-id';

export interface PersonalOrganizationInput {
  userId: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  /** A paid plan chosen at sign-up; the free plan is attached otherwise. */
  planName?: string | null;
}

/** The name every personal organization gets, from whatever name the user has. */
export function personalOrganizationName(user: { firstName?: string | null; lastName?: string | null; email: string }): string {
  return `${getDisplayName(user)}'s Organization`;
}

/**
 * The one place a personal organization is created.
 *
 * Sign-up and the profile bootstrap used to each create the personal team
 * with their own copy of the code — one of them never seeded the role
 * permissions — and a third copy sat unused in the teams service. One
 * routine now does it: the row, its public id, the OWNER membership, the
 * active-team pointer, the subscription and the permission rows, idempotent
 * on the user id so a retried sign-up cannot create two.
 */
@Injectable()
export class OrganizationsCoreService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrganizationsCoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    @Optional() private readonly bootTasks?: BootTaskService,
  ) {}

  async ensurePersonalOrganization(input: PersonalOrganizationInput) {
    const existing = await this.prisma.team.findUnique({ where: { personalForUserId: input.userId } });
    if (existing) {
      await this.completeIfMissing(existing.id, input.userId);
      return existing;
    }

    const name = personalOrganizationName(input);
    const emailSlug = input.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const slug = `personal-${emailSlug}-${input.userId.slice(0, 8)}`;

    const team = await this.prisma.team.create({
      data: {
        name,
        slug,
        personalForUserId: input.userId,
        publicId: newPublicId(),
        kind: 'PERSONAL',
        organizationMigratedAt: new Date(),
        members: { create: { userId: input.userId, role: 'OWNER' } },
      },
    });

    await this.prisma.user.update({ where: { id: input.userId }, data: { activeTeamId: team.id } });
    await ensureDefaultRolePermissions(this.prisma, team.id);

    try {
      if (input.planName && input.planName !== 'free') {
        await this.billing.createSubscriptionWithPlan(team.id, input.planName, input.email, name);
      } else {
        await this.billing.createFreeSubscription(team.id, input.email, name);
      }
    } catch (err) {
      this.logger.error(`Failed to create the subscription for organization ${team.id}: ${err}`);
    }

    this.logger.log(`Personal organization created for ${input.userId} (${team.id})`);
    return team;
  }

  /** Give an existing row what a new one gets: a public id and the permission rows. */
  private async completeIfMissing(teamId: string, userId: string): Promise<void> {
    const team = await this.prisma.team.findUnique({ where: { id: teamId }, select: { publicId: true } });
    if (team && !team.publicId) {
      await this.prisma.team.update({ where: { id: teamId }, data: { publicId: newPublicId() } });
    }
    await ensureDefaultRolePermissions(this.prisma, teamId);
    await this.prisma.user.updateMany({ where: { id: userId, activeTeamId: null }, data: { activeTeamId: teamId } });
  }

  /**
   * The additive half of the silent migration, at boot: every team gets a
   * public id, every user a personal organization, every team its permission
   * rows. Names are never changed here — that is the script's job, run once
   * and reported. Runs on one replica.
   */
  async onApplicationBootstrap(): Promise<void> {
    void (async () => {
      if (!((await this.bootTasks?.claim('organizations-self-check')) ?? true)) return;
      try {
        const report = await this.addWhatIsMissing();
        if (report.publicIds + report.personal + report.permissions > 0) {
          this.logger.log(
            `Organizations self-check: ${report.publicIds} public id(s), ${report.personal} personal organization(s), ${report.permissions} permission set(s) added`,
          );
        }
      } catch (err: any) {
        this.logger.warn(`Organizations self-check skipped: ${err?.message ?? err}`);
      }
    })();
  }

  async addWhatIsMissing(): Promise<{ publicIds: number; personal: number; permissions: number }> {
    let publicIds = 0;
    const withoutId = await this.prisma.team.findMany({ where: { publicId: null }, select: { id: true } });
    for (const t of withoutId) {
      await this.prisma.team.update({ where: { id: t.id }, data: { publicId: newPublicId() } });
      publicIds++;
    }

    // A team that is someone's personal team is a personal organization; the
    // column default (COMPANY) is wrong for rows that predate the column.
    await this.prisma.team.updateMany({
      where: { personalForUserId: { not: null }, kind: { not: 'PERSONAL' } },
      data: { kind: 'PERSONAL' },
    });

    let personal = 0;
    const users = await this.prisma.user.findMany({
      where: { personalTeam: null },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    for (const u of users) {
      await this.ensurePersonalOrganization({ userId: u.id, email: u.email, firstName: u.firstName, lastName: u.lastName });
      personal++;
    }

    let permissions = 0;
    const teams = await this.prisma.team.findMany({ select: { id: true, _count: { select: { rolePermissions: true } } } });
    for (const t of teams) {
      if (t._count.rolePermissions >= 2) continue;
      await ensureDefaultRolePermissions(this.prisma, t.id);
      permissions++;
    }

    return { publicIds, personal, permissions };
  }
}
