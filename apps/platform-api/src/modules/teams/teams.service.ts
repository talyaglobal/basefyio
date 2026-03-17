import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class TeamsService {
  private readonly logger = new Logger(TeamsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async createPersonalTeam(userId: string, username: string) {
    const team = await this.prisma.team.create({
      data: {
        name: `${username}'s Team`,
        slug: `personal-${username.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
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

    this.logger.log(`Personal team created for "${username}" (${team.id})`);
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

    this.logger.log(`Team "${name}" created by ${userId}`);
    return team;
  }

  async findAllForUser(userId: string) {
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId },
      include: {
        team: {
          include: {
            _count: { select: { members: true, projects: true } },
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

  async listMembers(teamId: string, userId: string) {
    await this.assertMember(teamId, userId);

    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      include: { user: { select: { id: true, username: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((m) => ({
      id: m.user.id,
      username: m.user.username,
      email: m.user.email,
      role: m.role,
      joinedAt: m.createdAt,
    }));
  }

  async sendInvite(teamId: string, ownerUserId: string, usernameOrEmail: string) {
    await this.assertOwner(teamId, ownerUserId);

    const targetUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { username: usernameOrEmail },
          { email: usernameOrEmail },
        ],
      },
    });

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { name: true },
    });

    const inviter = await this.prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { username: true },
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
        this.email
          .sendTeamInvite(
            targetUser.email,
            targetUser.username,
            inviter.username,
            team.name,
            false,
          )
          .catch(() => {});
      }

      this.logger.log(`Invite sent to "${targetUser.username}" for team ${teamId}`);
      return { message: `Invite sent to ${targetUser.username}` };
    }

    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usernameOrEmail);
    if (!isEmail) {
      throw new NotFoundException(
        `User "${usernameOrEmail}" not found. Please enter a valid email address to invite someone who doesn't have an account yet.`,
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
          inviter.username,
          team.name,
          true,
        )
        .catch(() => {});
    }

    this.logger.log(`Invite sent to email "${email}" (not registered) for team ${teamId}`);
    return { message: `Invite sent to ${email}. They will see the invite after signing up.` };
  }

  async listPendingInvites(userId: string) {
    const invites = await this.prisma.teamInvite.findMany({
      where: { invitedUserId: userId, status: 'PENDING' },
      include: {
        team: { select: { id: true, name: true, slug: true } },
        invitedBy: { select: { username: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((i) => ({
      id: i.id,
      teamId: i.team.id,
      teamName: i.team.name,
      teamSlug: i.team.slug,
      invitedBy: i.invitedBy.username,
      createdAt: i.createdAt,
    }));
  }

  async listTeamInvites(teamId: string, userId: string) {
    await this.assertMember(teamId, userId);

    const invites = await this.prisma.teamInvite.findMany({
      where: { teamId, status: 'PENDING' },
      include: {
        invitedUser: { select: { id: true, username: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return invites.map((inv) => ({
      ...inv,
      invitedUser: inv.invitedUser ?? {
        id: null,
        username: inv.invitedEmail?.split('@')[0] ?? 'unknown',
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

    return { message: 'Invite declined' };
  }

  async cancelInvite(teamId: string, inviteId: string, ownerUserId: string) {
    await this.assertOwner(teamId, ownerUserId);

    await this.prisma.teamInvite.deleteMany({
      where: { id: inviteId, teamId, status: 'PENDING' },
    });

    return { message: 'Invite cancelled' };
  }

  async removeMember(teamId: string, ownerUserId: string, targetUserId: string) {
    await this.assertOwner(teamId, ownerUserId);

    if (targetUserId === ownerUserId) {
      throw new ForbiddenException('Cannot remove yourself as owner');
    }

    await this.prisma.teamMember.deleteMany({
      where: { teamId, userId: targetUserId },
    });

    return { message: 'Member removed' };
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
