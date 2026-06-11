import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyzeBlueprintDto } from './dto/analyze-blueprint.dto';

@Injectable()
export class BlueprintService {
  constructor(private readonly prisma: PrismaService) {}

  async analyze(userId: string, dto: AnalyzeBlueprintDto) {
    // 1. Filter excluded sheets
    const activeSheets = dto.sheets.filter(
      (s) => !(dto.excludeSheets ?? []).includes(s.sheet),
    );

    // 2. Derive DataModel: one table per sheet, one field per header
    const tables = activeSheets.map((s) => ({
      name: s.sheet.toLowerCase().replace(/\s+/g, '_'),
      displayName: s.sheet,
      description: '',
      sourceSheet: s.sheet,
      fields: s.headers.map((h) => ({
        name: h.toLowerCase().replace(/\s+/g, '_'),
        type: 'string' as const,
        nullable: true,
        unique: false,
        primaryKey: false,
        description: h,
      })),
    }));

    const dataModel = { tables, version: 1 };

    // 3. Create Blueprint row
    const blueprint = await (this.prisma as any).blueprint.create({
      data: {
        teamId: dto.teamId,
        status: 'draft',
        dataModel,
        domainIntelligence: {},
        businessModel: { actors: [], objects: tables.map((t) => ({ name: t.displayName, table: t.name })), processes: [], metrics: [] },
        uiModel: { pages: [], version: 1 },
        createdBy: userId,
      },
    });

    return {
      blueprintId: blueprint.id,
      status: blueprint.status,
      dataModel: {
        tableCount: tables.length,
        tables: tables.map((t) => ({ name: t.name, displayName: t.displayName, fieldCount: t.fields.length })),
      },
      message: 'Blueprint created. Approve and call /blueprints/:id/generate to create your app.',
    };
  }

  async getBlueprint(userId: string, blueprintId: string) {
    const blueprint = await (this.prisma as any).blueprint.findUnique({
      where: { id: blueprintId },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });
    if (!blueprint) throw new NotFoundException('Blueprint not found');
    return blueprint;
  }
}
