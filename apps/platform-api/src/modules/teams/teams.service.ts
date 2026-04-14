import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { QuotaService } from '../billing/quota.service';
import { UsageService } from '../billing/usage.service';
import { BillingService } from '../billing/billing.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { getDisplayName } from '../../common/utils/display-name';

@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly quota: QuotaService,
    private readonly usageService: UsageService,
    private readonly billing: BillingService,
    private readonly realtime: RealtimeEventsService,
  ) {}

  private async teamUserIds(teamId: string): Promise<string[]> {
    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  async createPersonalTeam(userId: string, displayName: string, teamSlug: string) {
    const team = await this.prisma.team.create({
      data: {
        name: `${displayName}'s Team`,
        slug: teamSlug,
        personalForUserId: userId,
        members: {
          create: { userId, role: 'OWNER' },
        },
      },
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { activeTeamId: team.id },
    });

    this.logger.log(`Personal team created for "${displayName}" (${team.id})`);
    return team;
  }

  async create(name: string, userId: string) {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const existing = await this.prisma.team.findUnique({ where: { slug } });
    if (existing) throw new ConflictException('Team name already taken');

    const team = await this.prisma.team.create({
      data: {
        name,
        slug,
        members: {
          create: { userId, role: 'OWNER' },
        },
      },
    });

    const owner = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    try {
      await this.billing.createFreeSubscription(team.id, owner?.email, name);
    } catch (err) {
      this.logger.error(`Failed to create subscription for new team ${team.id}: ${err}`);
    }

    this.logger.log(`Team "${name}" created by ${userId}`);
    return team;
  }

  async findAllForUser(userId: string) {
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId },
      include: {
        team: {
          include: {
            _count: {
              select: {
                members: true,
                projects: { where: { status: { not: 'DELETED' } } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((m) => ({
      id: m.team.id,
      name: m.team.name,
      slug: m.team.slug,
      isPersonal: !!m.team.personalForUserId,
      role: m.role,
      memberCount: m.team._count.members,
      projectCount: m.team._count.projects,
    }));
  }

  async setActiveTeam(userId: string, teamId: string) {
    const membership = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!membership) throw new ForbiddenException('Not a member of this team');

    await this.prisma.user.update({
      where: { id: userId },
      data: { activeTeamId: teamId },
    });

    await this.realtime.publish({
      entityType: 'team_member',
      action: 'updated',
      entityId: `${teamId}:${userId}`,
      actorUserId: userId,
      teamId,
      userIds: [userId],
      payload: { kind: 'active_team_changed' },
    });

    return { teamId };
  }

  async getActiveTeamId(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeTeamId: true },
    });

    if (user?.activeTeamId) return user.activeTeamId;

    const firstTeam = await this.prisma.teamMember.findFirst({
      where: { userId },
      select: { teamId: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!firstTeam) throw new NotFoundException('No team found');
    return firstTeam.teamId;
  }

  async updateTeamName(teamId: string, userId: string, name: string) {
    await this.assertOwner(teamId, userId);

    const trimmed = name.trim();
    if (!trimmed || trimmed.length < 2) {
      throw new ForbiddenException('Team name must be at least 2 characters');
    }
    if (trimmed.length > 60) {
      throw new ForbiddenException('Team name must be 60 characters or less');
    }

    const updated = await this.prisma.team.update({
      where: { id: teamId },
      data: { name: trimmed },
    });

    this.logger.log(`Team "${teamId}" renamed to "${trimmed}" by ${userId}`);
    await this.realtime.publish({
      entityType: 'team',
      action: 'updated',
      entityId: teamId,
      actorUserId: userId,
      teamId,
      userIds: await this.teamUserIds(teamId),
      payload: { name: trimmed },
    });
    return updated;
  }

  async listMembers(teamId: string, userId: string) {
    await this.assertMember(teamId, userId);

    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      include: { user: { select: { id: true, email: true, firstName: true, lastName: true, avatarUrl: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      avatarUrl: m.user.avatarUrl,
      role: m.role,
      joinedAt: m.createdAt,
    }));
  }

  async sendInvite(teamId: string, ownerUserId: string, usernameOrEmail: string) {
    await this.assertOwner(teamId, ownerUserId);
    await this.quota.assertCanInviteMember(teamId);

    const targetUser = await this.prisma.user.findFirst({
      where: { email: usernameOrEmail.toLowerCase() },
    });

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    const inviter = await this.prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { email: true, firstName: true, lastName: true },
    });

    if (targetUser) {
      if (targetUser.id === ownerUserId) {
        throw new ForbiddenException('Cannot invite yourself');
      }

      const existingMember = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: targetUser.id } },
      });
      if (existingMember) throw new ConflictException('User is already a member');

      const existingInvite = await this.prisma.teamInvite.findUnique({
        where: { teamId_invitedUserId: { teamId, invitedUserId: targetUser.id } },
      });
      if (existingInvite?.status === 'PENDING') {
        throw new ConflictException('Invite already pending');
      }

      if (existingInvite) {
        await this.prisma.teamInvite.update({
          where: { id: existingInvite.id },
          data: { status: 'PENDING', invitedById: ownerUserId },
        });
      } else {
        await this.prisma.teamInvite.create({
          data: { teamId, invitedUserId: targetUser.id, invitedById: ownerUserId },
        });
      }

      if (targetUser.email && team && inviter) {
        const inviterDisplay = getDisplayName(inviter);
        const targetDisplay = getDisplayName({ ...targetUser, email: targetUser.email });
        this.email
          .sendTeamInvite(
            targetUser.email,
            targetDisplay,
            inviterDisplay,
            team.name,
            false,
          )
          .catch(() => {});
      }

      this.logger.log(`Invite sent to "${targetUser.email}" for team ${teamId}`);
      await this.realtime.publish({
        entityType: 'team_invite',
        action: 'invite_sent',
        entityId: `${teamId}:${targetUser.id}`,
        actorUserId: ownerUserId,
        teamId,
        userIds: [targetUser.id, ...(await this.teamUserIds(teamId))],
        payload: { usernameOrEmail: targetUser.email },
      });
      return { message: `Invite sent to ${targetUser.email}` };
    }

    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usernameOrEmail);
    if (!isEmail) {
      throw new NotFoundException(
        `No account found with that email. Please enter a valid email address.`,
      );
    }

    const email = usernameOrEmail.toLowerCase();

    const existingEmailInvite = await this.prisma.teamInvite.findUnique({
      where: { teamId_invitedEmail: { teamId, invitedEmail: email } },
    });
    if (existingEmailInvite?.status === 'PENDING') {
      throw new ConflictException('Invite already pending for this email');
    }

    if (existingEmailInvite) {
      await this.prisma.teamInvite.update({
        where: { id: existingEmailInvite.id },
        data: { status: 'PENDING', invitedById: ownerUserId },
      });
    } else {
      await this.prisma.teamInvite.create({
        data: { teamId, invitedEmail: email, invitedById: ownerUserId },
      });
    }

    if (team && inviter) {
      this.email
        .sendTeamInvite(
          email,
          email.split('@')[0],
          getDisplayName(inviter),
          team.name,
          true,
        )
        .catch(() => {});
    }

    this.logger.log(`Invite sent to email "${email}" (not registered) for team ${teamId}`);
    await this.realtime.publish({
      entityType: 'team_invite',
      action: 'invite_sent',
      entityId: `${teamId}:${email}`,
      actorUserId: ownerUserId,
      teamId,
      userIds: await this.teamUserIds(teamId),
      payload: { usernameOrEmail: email },
    });
    return { message: `Invite sent to ${email}. They will see the invite after signing up.` };
  }

  async listPendingInvites(userId: string) {
    const invites = await this.prisma.teamInvite.findMany({
      where: { invitedUserId: userId, status: 'PENDING' },
      include: {
        team: { select: { id: true, name: true, slug: true } },
        invitedBy: {
          select: {
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((i) => {
      const inviterFullName = [i.invitedBy.firstName, i.invitedBy.lastName]
        .filter(Boolean)
        .join(' ')
        .trim();
      const inviterDisplayName = inviterFullName || i.invitedBy.email.split('@')[0];
      const invitedEmail = i.invitedEmail ?? i.invitedBy.email;
      const expiresAt = new Date(i.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000);
      return {
        id: i.id,
        teamId: i.team.id,
        teamName: i.team.name,
        teamSlug: i.team.slug,
        organization: i.team.name,
        invitedBy: inviterDisplayName,
        invitedByFullName: inviterFullName || null,
        invitedByEmail: i.invitedBy.email,
        invitedEmail,
        createdAt: i.createdAt,
        expiresAt,
      };
    });
  }

  async listTeamInvites(teamId: string, userId: string) {
    await this.assertMember(teamId, userId);

    const invites = await this.prisma.teamInvite.findMany({
      where: { teamId, status: 'PENDING' },
      include: {
        invitedUser: { select: { id: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((inv) => ({
      ...inv,
      invitedUser: inv.invitedUser ?? {
        id: null,
        email: inv.invitedEmail,
      },
    }));
  }

  async acceptInvite(inviteId: string, userId: string) {
    const invite = await this.prisma.teamInvite.findFirst({
      where: { id: inviteId, invitedUserId: userId, status: 'PENDING' },
    });
    if (!invite) throw new NotFoundException('Invite not found');

    await this.prisma.$transaction([
      this.prisma.teamInvite.update({
        where: { id: inviteId },
        data: { status: 'ACCEPTED' },
      }),
      this.prisma.teamMember.create({
        data: { teamId: invite.teamId, userId, role: 'MEMBER' },
      }),
    ]);

    this.usageService.incrementMemberCount(invite.teamId).catch(() => {});
    await this.realtime.publish({
      entityType: 'team_invite',
      action: 'invite_accepted',
      entityId: inviteId,
      actorUserId: userId,
      teamId: invite.teamId,
      userIds: await this.teamUserIds(invite.teamId),
      payload: { inviteId },
    });

    this.logger.log(`User ${userId} accepted invite to team ${invite.teamId}`);
    return { message: 'Invite accepted' };
  }

  async declineInvite(inviteId: string, userId: string) {
    const invite = await this.prisma.teamInvite.findFirst({
      where: { id: inviteId, invitedUserId: userId, status: 'PENDING' },
    });
    if (!invite) throw new NotFoundException('Invite not found');

    await this.prisma.teamInvite.update({
      where: { id: inviteId },
      data: { status: 'DECLINED' },
    });
    await this.realtime.publish({
      entityType: 'team_invite',
      action: 'invite_declined',
      entityId: inviteId,
      actorUserId: userId,
      userIds: [userId],
      payload: { inviteId },
    });

    return { message: 'Invite declined' };
  }

  async cancelInvite(teamId: string, inviteId: string, ownerUserId: string) {
    await this.assertOwner(teamId, ownerUserId);

    await this.prisma.teamInvite.deleteMany({
      where: { id: inviteId, teamId, status: 'PENDING' },
    });
    await this.realtime.publish({
      entityType: 'team_invite',
      action: 'deleted',
      entityId: inviteId,
      actorUserId: ownerUserId,
      teamId,
      userIds: await this.teamUserIds(teamId),
      payload: { inviteId },
    });

    return { message: 'Invite cancelled' };
  }

  async reInvite(teamId: string, inviteId: string, ownerUserId: string) {
    await this.assertOwner(teamId, ownerUserId);

    const invite = await this.prisma.teamInvite.findFirst({
      where: { id: inviteId, teamId, status: 'PENDING' },
      include: {
        invitedUser: { select: { email: true, firstName: true, lastName: true } },
      },
    });
    if (!invite) {
      throw new NotFoundException('Pending invite not found');
    }

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });
    const inviter = await this.prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { email: true, firstName: true, lastName: true },
    });
    if (!team || !inviter) {
      throw new NotFoundException('Team or inviter not found');
    }

    const targetEmail = invite.invitedUser?.email ?? invite.invitedEmail;
    if (!targetEmail) {
      throw new NotFoundException('Invite target email not found');
    }
    const targetName = invite.invitedUser
      ? getDisplayName(invite.invitedUser)
      : invite.invitedEmail?.split('@')[0] ?? 'user';
    const isEmailInvite = !invite.invitedUserId;

    this.email
      .sendTeamInvite(targetEmail, targetName, getDisplayName(inviter), team.name, isEmailInvite)
      .catch(() => {});

    return { message: `Re-invite email sent to ${targetEmail}` };
  }

  async removeMember(teamId: string, ownerUserId: string, targetUserId: string) {
    await this.assertOwner(teamId, ownerUserId);

    if (targetUserId === ownerUserId) {
      throw new ForbiddenException('Cannot remove yourself as owner');
    }

    await this.prisma.teamMember.deleteMany({
      where: { teamId, userId: targetUserId },
    });

    this.usageService.decrementMemberCount(teamId).catch(() => {});
    const recipients = await this.teamUserIds(teamId);
    await this.realtime.publish({
      entityType: 'team_member',
      action: 'member_removed',
      entityId: `${teamId}:${targetUserId}`,
      actorUserId: ownerUserId,
      teamId,
      userIds: [...recipients, targetUserId],
      payload: { targetUserId },
    });

    return { message: 'Member removed' };
  }

  async transferOwnership(teamId: string, currentOwnerId: string, newOwnerId: string) {
    await this.assertOwner(teamId, currentOwnerId);

    if (currentOwnerId === newOwnerId) {
      throw new ForbiddenException('You are already the owner');
    }

    const targetMember = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: newOwnerId } },
    });
    if (!targetMember) {
      throw new ForbiddenException('Target user is not a member of this team');
    }

    await this.prisma.$transaction([
      this.prisma.teamMember.update({
        where: { teamId_userId: { teamId, userId: currentOwnerId } },
        data: { role: 'MEMBER' },
      }),
      this.prisma.teamMember.update({
        where: { teamId_userId: { teamId, userId: newOwnerId } },
        data: { role: 'OWNER' },
      }),
    ]);

    this.logger.log(`Team ${teamId}: ownership transferred from ${currentOwnerId} to ${newOwnerId}`);
    await this.realtime.publish({
      entityType: 'team_member',
      action: 'updated',
      entityId: `${teamId}:${newOwnerId}`,
      actorUserId: currentOwnerId,
      teamId,
      userIds: await this.teamUserIds(teamId),
      payload: { kind: 'ownership_transferred', fromUserId: currentOwnerId, toUserId: newOwnerId },
    });
    return { message: 'Ownership transferred' };
  }

  async deleteTeam(teamId: string, ownerUserId: string) {
    await this.assertOwner(teamId, ownerUserId);

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        personalForUserId: true,
      },
    });
    if (!team) {
      throw new NotFoundException('Team not found');
    }
    if (team.personalForUserId) {
      throw new ForbiddenException('Personal teams cannot be deleted');
    }
    const activeProjectCount = await this.prisma.project.count({
      where: {
        teamId,
        status: { not: 'DELETED' },
      },
    });

    if (activeProjectCount > 0) {
      throw new ForbiddenException('Move or delete active projects first to remove this team');
    }

    await this.prisma.$transaction(async (tx) => {
      // Team deletion is blocked by projects.team_id FK even for soft-deleted projects.
      // Purge already soft-deleted project rows first.
      const purged = await tx.project.deleteMany({
        where: {
          teamId,
          status: 'DELETED',
        },
      });
      if (purged.count > 0) {
        this.logger.log(`Purged ${purged.count} soft-deleted project(s) before team delete (${teamId})`);
      }

      const remainingProjects = await tx.project.count({ where: { teamId } });
      if (remainingProjects > 0) {
        throw new ForbiddenException('Move or delete active projects first to remove this team');
      }

      await tx.user.updateMany({
        where: { activeTeamId: teamId },
        data: { activeTeamId: null },
      });
      await tx.team.delete({
        where: { id: teamId },
      });
    });

    return { id: team.id, name: team.name, deleted: true as const };
  }

  async linkEmailInvitesToUser(email: string, userId: string): Promise<number> {
    const pending = await this.prisma.teamInvite.findMany({
      where: { invitedEmail: email.toLowerCase(), status: 'PENDING', invitedUserId: null },
    });

    if (pending.length === 0) return 0;

    await this.prisma.teamInvite.updateMany({
      where: {
        id: { in: pending.map((i) => i.id) },
      },
      data: { invitedUserId: userId },
    });

    this.logger.log(`Linked ${pending.length} email invite(s) to user ${userId} (${email})`);
    return pending.length;
  }

  async assertMember(teamId: string, userId: string) {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this team');
    return m;
  }

  private async assertOwner(teamId: string, userId: string) {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m || m.role !== 'OWNER') {
      throw new ForbiddenException('Only the team owner can do this');
    }
  }
}
