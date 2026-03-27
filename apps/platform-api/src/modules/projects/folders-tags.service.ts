import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class FoldersTagsService {
  constructor(private readonly prisma: PrismaService) {}

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
    return this.prisma.projectFolder.create({
      data: { name, color, teamId },
    });
  }

  async updateFolder(
    id: string,
    userId: string,
    data: { name?: string; color?: string },
  ) {
    const folder = await this.prisma.projectFolder.findUnique({ where: { id } });
    if (!folder) throw new NotFoundException('Folder not found');
    await this.assertTeamMember(folder.teamId, userId);
    return this.prisma.projectFolder.update({ where: { id }, data });
  }

  async deleteFolder(id: string, userId: string) {
    const folder = await this.prisma.projectFolder.findUnique({ where: { id } });
    if (!folder) throw new NotFoundException('Folder not found');
    await this.assertTeamMember(folder.teamId, userId);
    await this.prisma.projectFolder.delete({ where: { id } });
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
    return this.prisma.projectTag.upsert({
      where: { teamId_name: { teamId, name } },
      update: {},
      create: { name, color, teamId },
    });
  }

  async updateTag(
    id: string,
    userId: string,
    data: { name?: string; color?: string },
  ) {
    const tag = await this.prisma.projectTag.findUnique({ where: { id } });
    if (!tag) throw new NotFoundException('Tag not found');
    await this.assertTeamMember(tag.teamId, userId);
    return this.prisma.projectTag.update({ where: { id }, data });
  }

  async deleteTag(id: string, userId: string) {
    const tag = await this.prisma.projectTag.findUnique({ where: { id } });
    if (!tag) throw new NotFoundException('Tag not found');
    await this.assertTeamMember(tag.teamId, userId);
    await this.prisma.projectTag.delete({ where: { id } });
    return { success: true };
  }
}
