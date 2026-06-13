import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PostgresJsonbProvider } from './storage/postgres-jsonb.provider';
import type { PaginatedRows, StoredRow } from './storage/data-storage.provider';

interface FieldDef {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  required?: boolean;
  default?: unknown;
}

function validateData(
  data: Record<string, unknown>,
  fields: FieldDef[],
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...data };

  for (const field of fields) {
    const value = result[field.name];

    if (value === undefined || value === null) {
      if (field.default !== undefined) {
        result[field.name] = field.default;
        continue;
      }
      if (field.required) {
        throw new BadRequestException(`Field "${field.name}" is required`);
      }
      continue;
    }

    // eslint-disable-next-line valid-typeof
    const jsType = Array.isArray(value) ? 'array' : typeof value;
    if (field.type === 'array' && !Array.isArray(value)) {
      throw new BadRequestException(`Field "${field.name}" must be an array`);
    } else if (field.type !== 'array' && field.type !== 'object' && jsType !== field.type) {
      throw new BadRequestException(
        `Field "${field.name}" must be of type ${field.type}, got ${jsType}`,
      );
    }
  }

  return result;
}

export interface ListItemsOptions {
  limit?: number;
  cursor?: string;
}

@Injectable()
export class StructureItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: PostgresJsonbProvider,
  ) {}

  private async resolveStructure(projectId: string, structureId: string) {
    const ds = await this.prisma.dataStructure.findFirst({
      where: { id: structureId, projectId },
      select: { id: true, projectId: true, fields: true },
    });
    if (!ds) throw new NotFoundException('Data structure not found');
    return ds;
  }

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

  async create(
    projectId: string,
    structureId: string,
    data: Record<string, unknown>,
  ): Promise<StoredRow> {
    const ds = await this.resolveStructure(projectId, structureId);
    const fields = (ds.fields ?? []) as unknown as FieldDef[];
    const validated = validateData(data, fields);
    return this.provider.insertRow({ structureId, projectId, data: validated });
  }

  async list(
    projectId: string,
    structureId: string,
    opts: ListItemsOptions,
  ): Promise<PaginatedRows> {
    await this.resolveStructure(projectId, structureId);
    return this.provider.listRows({
      structureId,
      projectId,
      limit: opts.limit ?? 20,
      cursor: opts.cursor,
    });
  }

  async get(
    projectId: string,
    structureId: string,
    itemId: string,
  ): Promise<StoredRow> {
    await this.resolveStructure(projectId, structureId);
    const row = await this.provider.getRow({ structureId, projectId, itemId });
    if (!row) throw new NotFoundException(`Item "${itemId}" not found`);
    return row;
  }

  async update(
    projectId: string,
    structureId: string,
    itemId: string,
    data: Record<string, unknown>,
  ): Promise<StoredRow> {
    const ds = await this.resolveStructure(projectId, structureId);
    const fields = (ds.fields ?? []) as unknown as FieldDef[];
    // Validate only provided fields (partial update — skip required check for absent keys)
    const partialFields = fields.filter((f) => data[f.name] !== undefined);
    validateData(data, partialFields);

    try {
      return await this.provider.updateRow({ structureId, projectId, itemId, data });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'NOT_FOUND') {
        throw new NotFoundException(`Item "${itemId}" not found`);
      }
      throw err;
    }
  }

  async delete(
    projectId: string,
    structureId: string,
    itemId: string,
  ): Promise<{ deleted: boolean; id: string }> {
    await this.resolveStructure(projectId, structureId);
    try {
      await this.provider.deleteRow({ structureId, projectId, itemId });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'NOT_FOUND') {
        throw new NotFoundException(`Item "${itemId}" not found`);
      }
      throw err;
    }
    return { deleted: true, id: itemId };
  }
}
