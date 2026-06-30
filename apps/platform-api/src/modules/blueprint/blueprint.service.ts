import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  buildApplicationModel,
  buildBusinessModel,
  buildDataModel,
  detectDomain,
} from './blueprint-builder';
import { AnalyzeBlueprintInput, ApplicationModel } from './blueprint.types';

/**
 * Excel/CSV → application blueprint. This slice covers the analyze → draft →
 * approve lifecycle (data-model inference + heuristic business/application
 * model). DDL generation and the runtime renderer are layered on later.
 * Re-implemented from the askin concept using our own patterns (no code copied).
 */
@Injectable()
export class BlueprintService {
  constructor(private readonly prisma: PrismaService) {}

  private async assertTeam(teamId: string, userId?: string): Promise<void> {
    if (!userId) throw new ForbiddenException('Authentication required');
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { id: true },
    });
    if (!member) throw new ForbiddenException('You are not a member of this team');
  }

  async analyze(input: AnalyzeBlueprintInput, userId?: string) {
    if (!input?.teamId) throw new BadRequestException('teamId is required');
    if (!Array.isArray(input.sheets) || input.sheets.length === 0) {
      throw new BadRequestException('at least one sheet is required');
    }
    await this.assertTeam(input.teamId, userId);

    const dataModel = buildDataModel(input);
    if (dataModel.tables.length === 0) {
      throw new BadRequestException('no usable tables found in the provided sheets');
    }
    const domain = detectDomain(dataModel);
    const businessModel = buildBusinessModel(dataModel, domain);
    const applicationModel = buildApplicationModel(dataModel, domain, input.name);

    return this.prisma.blueprint.create({
      data: {
        teamId: input.teamId,
        projectId: input.projectId ?? null,
        name: applicationModel.name,
        status: 'DRAFT',
        domain,
        dataModel: dataModel as unknown as Prisma.InputJsonValue,
        businessModel: businessModel as unknown as Prisma.InputJsonValue,
        applicationModel: applicationModel as unknown as Prisma.InputJsonValue,
        createdBy: userId ?? null,
      },
    });
  }

  async list(teamId: string, userId?: string) {
    await this.assertTeam(teamId, userId);
    return this.prisma.blueprint.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        status: true,
        domain: true,
        projectId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }

  async get(id: string, userId?: string) {
    const blueprint = await this.prisma.blueprint.findUnique({
      where: { id },
      include: { versions: { orderBy: { version: 'desc' } } },
    });
    if (!blueprint) throw new NotFoundException('Blueprint not found');
    await this.assertTeam(blueprint.teamId, userId);
    return blueprint;
  }

  /** Approve (or edit) the ApplicationModel; records an immutable version. */
  async approve(id: string, applicationModel: ApplicationModel, userId?: string) {
    const blueprint = await this.get(id, userId);
    if (!applicationModel?.name || !Array.isArray(applicationModel.tables)) {
      throw new BadRequestException('a valid applicationModel is required');
    }
    const last = await this.prisma.applicationVersion.findFirst({
      where: { blueprintId: id },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const nextVersion = (last?.version ?? 0) + 1;

    const [updated] = await this.prisma.$transaction([
      this.prisma.blueprint.update({
        where: { id: blueprint.id },
        data: {
          status: 'APPROVED',
          name: applicationModel.name,
          applicationModel: applicationModel as unknown as Prisma.InputJsonValue,
        },
      }),
      this.prisma.applicationVersion.create({
        data: {
          blueprintId: id,
          version: nextVersion,
          applicationModel: applicationModel as unknown as Prisma.InputJsonValue,
          changeSummary: nextVersion === 1 ? 'Initial approval' : 'Updated application model',
          createdBy: userId ?? null,
        },
      }),
    ]);
    return updated;
  }

  async remove(id: string, userId?: string) {
    const blueprint = await this.get(id, userId);
    await this.prisma.blueprint.delete({ where: { id: blueprint.id } });
    return { deleted: true };
  }
}
