import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateDataStructureDto, DataStructureKindDto } from './dto/create-data-structure.dto';
import { UpdateDataStructureDto } from './dto/update-data-structure.dto';

// Public shape returned to clients. jsonBackend is intentionally omitted.
export interface DataStructureView {
  id: string;
  projectId: string;
  name: string;
  kind: 'relational' | 'json';
  badge: 'SQL' | 'JSON';
  editorMode: 'sql' | 'js-query';
  dataEditorMode: 'row' | 'document';
  aiRecommended: boolean;
  aiReasons: unknown | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class DataStructuresService {
  constructor(private readonly prisma: PrismaService) {}

  async assertProjectMember(projectId: string, userId: string): Promise<void> {
    const project = await this.prisma.project.findUnique({
      where: { id: projectId },
      select: { teamId: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new ForbiddenException('Not a member of this project\'s team');
  }

  async list(projectId: string): Promise<DataStructureView[]> {
    const rows = await this.prisma.dataStructure.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        projectId: true,
        name: true,
        kind: true,
        aiRecommended: true,
        aiReasons: true,
        createdAt: true,
        updatedAt: true,
        // jsonBackend intentionally excluded
      },
    });
    return rows.map(toView);
  }

  async get(projectId: string, structureId: string): Promise<DataStructureView> {
    const row = await this.prisma.dataStructure.findFirst({
      where: { id: structureId, projectId },
      select: {
        id: true,
        projectId: true,
        name: true,
        kind: true,
        aiRecommended: true,
        aiReasons: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!row) throw new NotFoundException('Data structure not found');
    return toView(row);
  }

  async create(
    projectId: string,
    dto: CreateDataStructureDto,
  ): Promise<DataStructureView> {
    const name = dto.name.trim();

    const existing = await this.prisma.dataStructure.findUnique({
      where: { projectId_name: { projectId, name } },
    });
    if (existing) throw new ConflictException(`A structure named "${name}" already exists in this project`);

    // Internally pick the JSON backend. Never accepted from the client.
    const isRelational = dto.kind === DataStructureKindDto.RELATIONAL;
    const jsonBackend = isRelational ? null : 'mongodb';
    const engineType = isRelational ? 'relational' : 'mongodb';

    const row = await this.prisma.$transaction(async (tx) => {
      const ds = await tx.dataStructure.create({
        data: {
          projectId,
          name,
          kind: isRelational ? 'RELATIONAL' : 'JSON',
          jsonBackend,
        },
        select: {
          id: true,
          projectId: true,
          name: true,
          kind: true,
          aiRecommended: true,
          aiReasons: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      await tx.dataStructureStorage.create({
        data: { dataStructureId: ds.id, engineType },
      });
      return ds;
    });

    return toView(row);
  }

  async update(
    projectId: string,
    structureId: string,
    dto: UpdateDataStructureDto,
  ): Promise<DataStructureView> {
    const existing = await this.prisma.dataStructure.findFirst({
      where: { id: structureId, projectId },
      select: { id: true, kind: true },
    });
    if (!existing) throw new NotFoundException('Data structure not found');

    if (dto.name !== undefined) {
      const name = dto.name.trim();
      const conflict = await this.prisma.dataStructure.findUnique({
        where: { projectId_name: { projectId, name } },
        select: { id: true },
      });
      if (conflict && conflict.id !== structureId) {
        throw new ConflictException(`A structure named "${name}" already exists in this project`);
      }
    }

    const row = await this.prisma.dataStructure.update({
      where: { id: structureId },
      data: { ...(dto.name !== undefined && { name: dto.name.trim() }) },
      select: {
        id: true,
        projectId: true,
        name: true,
        kind: true,
        aiRecommended: true,
        aiReasons: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return toView(row);
  }

  async delete(projectId: string, structureId: string): Promise<void> {
    const existing = await this.prisma.dataStructure.findFirst({
      where: { id: structureId, projectId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Data structure not found');
    await this.prisma.dataStructure.delete({ where: { id: structureId } });
  }
}

function toView(row: {
  id: string;
  projectId: string;
  name: string;
  kind: string;
  aiRecommended: boolean;
  aiReasons: unknown;
  createdAt: Date;
  updatedAt: Date;
}): DataStructureView {
  const isRelational = row.kind === 'RELATIONAL';
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    kind: isRelational ? 'relational' : 'json',
    badge: isRelational ? 'SQL' : 'JSON',
    editorMode: isRelational ? 'sql' : 'js-query',
    dataEditorMode: isRelational ? 'row' : 'document',
    aiRecommended: row.aiRecommended,
    aiReasons: row.aiReasons ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
