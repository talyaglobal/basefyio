import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { OrganizationKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { TeamsService } from '../teams/teams.service';
import { BillingService } from '../billing/billing.service';
import { UsageService } from '../billing/usage.service';
import { isPublicId } from './public-id';

export const ORGANIZATION_KINDS = Object.values(OrganizationKind).filter((k) => k !== 'PERSONAL') as OrganizationKind[];

/**
 * The organization facade: new routes under /organizations with public ids,
 * kinds and plans, all delegating to the teams service so the rules — who
 * may invite, rename, see billing — stay in one place. `/teams/*` keeps
 * working unchanged for the SDK and the CLI.
 */
@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly teams: TeamsService,
    private readonly billing: BillingService,
    private readonly usage: UsageService,
  ) {}

  /** A public id or, for links that predate them, the team's uuid. */
  async resolve(publicIdOrTeamId: string): Promise<{ id: string; publicId: string | null }> {
    const team = isPublicId(publicIdOrTeamId)
      ? await this.prisma.team.findUnique({ where: { publicId: publicIdOrTeamId }, select: { id: true, publicId: true } })
      : await this.prisma.team.findUnique({ where: { id: publicIdOrTeamId }, select: { id: true, publicId: true } });
    if (!team) throw new NotFoundException('Organization not found');
    return team;
  }

  async listForUser(userId: string) {
    const teams = await this.teams.findAllForUser(userId);
    // Awake and deactivated counts per organization, for a switcher that can
    // say "3 projects · 2 deactivated" — one grouped query, not one per row.
    const grouped = await this.prisma.project.groupBy({
      by: ['teamId', 'status'],
      where: { teamId: { in: teams.map((t) => t.id) }, status: { not: 'DELETED' } },
      _count: { _all: true },
    });
    const counts = new Map<string, { awake: number; deactivated: number }>();
    for (const g of grouped) {
      const c = counts.get(g.teamId) ?? { awake: 0, deactivated: 0 };
      if (g.status === 'ACTIVE') c.awake += g._count._all;
      else c.deactivated += g._count._all;
      counts.set(g.teamId, c);
    }
    return teams.map((t) => ({
      ...t,
      organizationId: t.publicId ?? t.id,
      projects: counts.get(t.id) ?? { awake: 0, deactivated: 0 },
    }));
  }

  async create(
    userId: string,
    input: { name: string; kind?: OrganizationKind; planName?: string; successUrl?: string; cancelUrl?: string },
  ) {
    const name = input.name.trim();
    if (name.length < 2 || name.length > 60) {
      throw new BadRequestException('Name must be between 2 and 60 characters');
    }
    const kind = input.kind ?? 'COMPANY';
    if (!ORGANIZATION_KINDS.includes(kind)) {
      throw new BadRequestException('Unknown organization kind');
    }

    // A paid plan is checked before anything is created. The organization
    // starts on the free plan either way; the paid plan is applied by the
    // Stripe webhook once the checkout succeeds, never before.
    let paidPlan: string | null = null;
    if (input.planName && input.planName !== 'free') {
      const plan = await this.prisma.plan.findUnique({ where: { name: input.planName }, select: { name: true, isPublic: true } });
      if (!plan || plan.isPublic === false) throw new BadRequestException('Unknown plan');
      paidPlan = plan.name;
    }

    // The teams service creates the row with its public id, the OWNER
    // membership, the free subscription and the permission rows.
    const team = await this.teams.create(name, userId, { kind, suffixOnCollision: true });

    let checkoutUrl: string | null = null;
    if (paidPlan && input.successUrl && input.cancelUrl) {
      const session = await this.billing.createCheckoutSession(team.id, userId, paidPlan, input.successUrl, input.cancelUrl);
      checkoutUrl = session.url ?? null;
    }

    return {
      organization: this.present(team),
      checkoutRequired: paidPlan ? { planName: paidPlan } : null,
      checkoutUrl,
    };
  }

  async overview(publicIdOrTeamId: string, userId: string) {
    const { id } = await this.resolve(publicIdOrTeamId);
    await this.teams.assertMember(id, userId);
    const team = await this.prisma.team.findUnique({
      where: { id },
      include: {
        subscription: { include: { plan: { select: { name: true, displayName: true } } } },
        _count: {
          select: {
            members: true,
            projects: { where: { status: { not: 'DELETED' } } },
            invites: { where: { status: 'PENDING' } },
          },
        },
      },
    });
    if (!team) throw new NotFoundException('Organization not found');
    const awake = await this.prisma.project.count({ where: { teamId: id, status: 'ACTIVE' } });
    const deactivated = await this.prisma.project.count({ where: { teamId: id, status: { in: ['PAUSED', 'DEACTIVATED'] } } });
    const usage = await this.usage.getTeamUsage(id).catch(() => null);
    return {
      ...this.present(team),
      plan: team.subscription?.plan ? { name: team.subscription.plan.name, displayName: team.subscription.plan.displayName } : null,
      counts: {
        members: team._count.members,
        projects: team._count.projects,
        projectsAwake: awake,
        projectsDeactivated: deactivated,
        pendingInvites: team._count.invites,
      },
      usage,
    };
  }

  /** The billing routes' subscription view, addressed by public id; the same permission rules apply. */
  async billingOverview(publicIdOrTeamId: string, userId: string) {
    const { id } = await this.resolve(publicIdOrTeamId);
    return this.billing.getTeamSubscriptionForUser(id, userId);
  }

  async update(
    publicIdOrTeamId: string,
    userId: string,
    input: { name?: string; kind?: OrganizationKind; description?: string | null; websiteUrl?: string | null; logoUrl?: string | null },
  ) {
    const { id } = await this.resolve(publicIdOrTeamId);
    await this.teams.assertPermission(id, userId, 'canRenameTeam');
    const current = await this.prisma.team.findUnique({ where: { id }, select: { personalForUserId: true } });
    if (input.kind !== undefined) {
      if (current?.personalForUserId) throw new ConflictException('A personal organization keeps its kind');
      if (!ORGANIZATION_KINDS.includes(input.kind)) throw new BadRequestException('Unknown organization kind');
    }
    if (input.name !== undefined) {
      // The teams service owns renaming (slug, uniqueness, audit).
      await this.teams.updateTeamName(id, userId, input.name);
    }
    const updated = await this.prisma.team.update({
      where: { id },
      data: {
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl } : {}),
        ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      },
    });
    return this.present(updated);
  }

  async switchTo(publicIdOrTeamId: string, userId: string) {
    const { id } = await this.resolve(publicIdOrTeamId);
    return this.teams.setActiveTeam(userId, id);
  }

  async members(publicIdOrTeamId: string, userId: string) {
    const { id } = await this.resolve(publicIdOrTeamId);
    return this.teams.listMembers(id, userId);
  }

  async invites(publicIdOrTeamId: string, userId: string) {
    const { id } = await this.resolve(publicIdOrTeamId);
    return this.teams.listTeamInvites(id, userId);
  }

  async projects(publicIdOrTeamId: string, userId: string) {
    const { id } = await this.resolve(publicIdOrTeamId);
    await this.teams.assertMember(id, userId);
    return this.prisma.project.findMany({
      where: { teamId: id, status: { not: 'DELETED' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, slug: true, status: true, databaseType: true, createdAt: true, pausedAt: true },
    });
  }

  private present(team: {
    id: string;
    publicId: string | null;
    name: string;
    slug: string;
    kind: OrganizationKind;
    personalForUserId: string | null;
    description: string | null;
    websiteUrl: string | null;
    logoUrl: string | null;
    createdAt: Date;
    requireMfa: boolean;
  }) {
    return {
      id: team.id,
      organizationId: team.publicId ?? team.id,
      publicId: team.publicId,
      name: team.name,
      slug: team.slug,
      kind: team.kind,
      isPersonal: !!team.personalForUserId,
      description: team.description,
      websiteUrl: team.websiteUrl,
      logoUrl: team.logoUrl,
      requireMfa: team.requireMfa,
      createdAt: team.createdAt,
    };
  }
}
