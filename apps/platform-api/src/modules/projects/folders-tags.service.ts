import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';

@Injectable()
export class FoldersTagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEventsService,
  ) {}

  private async teamMemberUserIds(teamId: string): Promise<string[]> {
    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: { userId: true },
    });
    return members.map((m) => m.userId);
  }

  private async assertTeamMember(teamId: string, userId: string) {
    const member = await this.prisma.teamMember.findFirst({
      where: { teamId, userId },
    });
    if (!member) throw new ForbiddenException('Not a team member');
  }

  // ── Folders ──────────────────────────────────────────────

  async listFolders(teamId: string, userId: string) {
    await this.assertTeamMember(teamId, userId);
    return this.prisma.projectFolder.findMany({
      where: { teamId },
      include: { _count: { select: { projects: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async createFolder(
    teamId: string,
    userId: string,
    name: string,
    color = '#6366f1',
  ) {
    await this.assertTeamMember(teamId, userId);
    const folder = await this.prisma.projectFolder.create({
      data: { name, color, teamId },
    });
    const memberIds = await this.teamMemberUserIds(teamId);
    await this.realtime.publish({
      entityType: 'project_folder',
      action: 'created',
      entityId: folder.id,
      actorUserId: userId,
      teamId,
      userIds: memberIds,
      payload: { name: folder.name, color: folder.color },
    });
    return folder;
  }

  async updateFolder(
    id: string,
    userId: string,
    data: { name?: string; color?: string },
  ) {
    const folder = await this.prisma.projectFolder.findUnique({ where: { id } });
    if (!folder) throw new NotFoundException('Folder not found');
    await this.assertTeamMember(folder.teamId, userId);
    const updated = await this.prisma.projectFolder.update({ where: { id }, data });
    const memberIds = await this.teamMemberUserIds(folder.teamId);
    await this.realtime.publish({
      entityType: 'project_folder',
      action: 'updated',
      entityId: id,
      actorUserId: userId,
      teamId: folder.teamId,
      userIds: memberIds,
      payload: { name: updated.name, color: updated.color },
    });
    return updated;
  }

  async deleteFolder(id: string, userId: string) {
    const folder = await this.prisma.projectFolder.findUnique({ where: { id } });
    if (!folder) throw new NotFoundException('Folder not found');
    await this.assertTeamMember(folder.teamId, userId);
    await this.prisma.projectFolder.delete({ where: { id } });
    const memberIds = await this.teamMemberUserIds(folder.teamId);
    await this.realtime.publish({
      entityType: 'project_folder',
      action: 'deleted',
      entityId: id,
      actorUserId: userId,
      teamId: folder.teamId,
      userIds: memberIds,
      payload: { name: folder.name },
    });
    return { success: true };
  }

  // ── Tags ─────────────────────────────────────────────────

  async listTags(teamId: string, userId: string) {
    await this.assertTeamMember(teamId, userId);
    return this.prisma.projectTag.findMany({
      where: { teamId },
      include: { _count: { select: { assignments: true } } },
      orderBy: { name: 'asc' },
    });
  }

  async createTag(
    teamId: string,
    userId: string,
    name: string,
    color = '#8b5cf6',
  ) {
    await this.assertTeamMember(teamId, userId);
    const tag = await this.prisma.projectTag.upsert({
      where: { teamId_name: { teamId, name } },
      update: {},
      create: { name, color, teamId },
    });
    const memberIds = await this.teamMemberUserIds(teamId);
    await this.realtime.publish({
      entityType: 'project_tag',
      action: 'created',
      entityId: tag.id,
      actorUserId: userId,
      teamId,
      userIds: memberIds,
      payload: { name: tag.name, color: tag.color },
    });
    return tag;
  }

  async updateTag(
    id: string,
    userId: string,
    data: { name?: string; color?: string },
  ) {
    const tag = await this.prisma.projectTag.findUnique({ where: { id } });
    if (!tag) throw new NotFoundException('Tag not found');
    await this.assertTeamMember(tag.teamId, userId);
    const updated = await this.prisma.projectTag.update({ where: { id }, data });
    const memberIds = await this.teamMemberUserIds(tag.teamId);
    await this.realtime.publish({
      entityType: 'project_tag',
      action: 'updated',
      entityId: id,
      actorUserId: userId,
      teamId: tag.teamId,
      userIds: memberIds,
      payload: { name: updated.name, color: updated.color },
    });
    return updated;
  }

  async deleteTag(id: string, userId: string) {
    const tag = await this.prisma.projectTag.findUnique({ where: { id } });
    if (!tag) throw new NotFoundException('Tag not found');
    await this.assertTeamMember(tag.teamId, userId);
    await this.prisma.projectTag.delete({ where: { id } });
    const memberIds = await this.teamMemberUserIds(tag.teamId);
    await this.realtime.publish({
      entityType: 'project_tag',
      action: 'deleted',
      entityId: id,
      actorUserId: userId,
      teamId: tag.teamId,
      userIds: memberIds,
      payload: { name: tag.name },
    });
    return { success: true };
  }
}
