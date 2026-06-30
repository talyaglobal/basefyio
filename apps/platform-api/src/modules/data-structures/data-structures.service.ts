import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateDataStructureDto, DataStructureKindDto } from './dto/create-data-structure.dto';

// Public shape returned to clients. jsonBackend is intentionally omitted.
export interface DataStructureView {
  id: string;
  projectId: string;
  name: string;
  kind: 'relational' | 'json';
  badge: 'SQL' | 'JSON';
  editorMode: 'sql' | 'js-query';
  dataEditorMode: 'row' | 'document';
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
        createdAt: true,
        updatedAt: true,
        // jsonBackend intentionally excluded
      },
    });
    return rows.map(toView);
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
    const jsonBackend = dto.kind === DataStructureKindDto.JSON ? 'mongodb' : null;

    const row = await this.prisma.dataStructure.create({
      data: {
        projectId,
        name,
        kind: dto.kind === DataStructureKindDto.RELATIONAL ? 'RELATIONAL' : 'JSON',
        jsonBackend,
      },
      select: {
        id: true,
        projectId: true,
        name: true,
        kind: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return toView(row);
  }
}

function toView(row: {
  id: string;
  projectId: string;
  name: string;
  kind: string;
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
