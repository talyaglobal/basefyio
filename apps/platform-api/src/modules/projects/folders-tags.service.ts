import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';

/** Longest folder or tag name accepted on create / rename. */
export const FOLDER_TAG_NAME_MAX = 64;

/**
 * Trim a folder / tag name and reject an empty or oversized one, so a blank
 * "Create" no longer stores a nameless folder.
 */
export function normalizeFolderTagName(raw: unknown, kind: 'Folder' | 'Tag'): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new BadRequestException(`${kind} name is required`);
  if (name.length > FOLDER_TAG_NAME_MAX) {
    throw new BadRequestException(
      `${kind} name must be at most ${FOLDER_TAG_NAME_MAX} characters`,
    );
  }
  return name;
}

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

  /**
   * Serialises folder / tag writes of one team inside the surrounding
   * transaction. Without it two requests from a double-clicked "Create" both
   * passed the duplicate check and stored two folders with the same name.
   */
  private async lockTeamNames(
    tx: Pick<PrismaService, '$executeRaw'>,
    kind: 'folder' | 'tag',
    teamId: string,
  ) {
    const key = `project_${kind}_names:${teamId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
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
    const folderName = normalizeFolderTagName(name, 'Folder');
    await this.assertTeamMember(teamId, userId);
    // Folder names are unique per team (case-insensitive). Checked under a
    // team-scoped lock so concurrent creates cannot both slip past the check.
    const folder = await this.prisma.$transaction(async (tx) => {
      await this.lockTeamNames(tx, 'folder', teamId);
      const existing = await tx.projectFolder.findFirst({
        where: { teamId, name: { equals: folderName, mode: 'insensitive' } },
        select: { name: true },
      });
      if (existing) {
        throw new ConflictException(
          `A folder named "${existing.name}" already exists in this team`,
        );
      }
      return tx.projectFolder.create({
        data: { name: folderName, color: color || '#6366f1', teamId },
      });
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
    const patch: { name?: string; color?: string } = {};
    if (data.color !== undefined) patch.color = data.color;
    if (data.name !== undefined) patch.name = normalizeFolderTagName(data.name, 'Folder');
    const renaming =
      patch.name !== undefined && patch.name.toLowerCase() !== folder.name.trim().toLowerCase();
    const updated = await this.prisma.$transaction(async (tx) => {
      if (renaming) {
        await this.lockTeamNames(tx, 'folder', folder.teamId);
        const clash = await tx.projectFolder.findFirst({
          where: {
            teamId: folder.teamId,
            id: { not: id },
            name: { equals: patch.name!, mode: 'insensitive' },
          },
          select: { name: true },
        });
        if (clash) {
          throw new ConflictException(
            `A folder named "${clash.name}" already exists in this team`,
          );
        }
      }
      return tx.projectFolder.update({ where: { id }, data: patch });
    });
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
    const tagName = normalizeFolderTagName(name, 'Tag');
    await this.assertTeamMember(teamId, userId);
    // Creating a tag that already exists (any letter case) returns the
    // existing one, so a repeated or double-clicked create stays idempotent.
    const tag = await this.prisma.$transaction(async (tx) => {
      await this.lockTeamNames(tx, 'tag', teamId);
      const existing = await tx.projectTag.findFirst({
        where: { teamId, name: { equals: tagName, mode: 'insensitive' } },
      });
      if (existing) return existing;
      return tx.projectTag.create({
        data: { name: tagName, color: color || '#8b5cf6', teamId },
      });
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
    const patch: { name?: string; color?: string } = {};
    if (data.color !== undefined) patch.color = data.color;
    if (data.name !== undefined) patch.name = normalizeFolderTagName(data.name, 'Tag');
    const renaming =
      patch.name !== undefined && patch.name.toLowerCase() !== tag.name.trim().toLowerCase();
    const updated = await this.prisma.$transaction(async (tx) => {
      if (renaming) {
        await this.lockTeamNames(tx, 'tag', tag.teamId);
        const clash = await tx.projectTag.findFirst({
          where: {
            teamId: tag.teamId,
            id: { not: id },
            name: { equals: patch.name!, mode: 'insensitive' },
          },
          select: { name: true },
        });
        // Previously a rename onto an existing tag hit the unique index and
        // surfaced as a 500.
        if (clash) {
          throw new ConflictException(`A tag named "${clash.name}" already exists in this team`);
        }
      }
      return tx.projectTag.update({ where: { id }, data: patch });
    });
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
