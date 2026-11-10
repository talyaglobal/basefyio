import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CollectionService } from '../projects/collection.service';
import { InferredType } from '../data-import/lib/type-inferrer';
import {
  RESERVED_COLUMNS,
  buildApplicationModel,
  buildBusinessModel,
  buildDataModel,
  detectDomain,
} from './blueprint-builder';
import {
  AnalyzeBlueprintInput,
  ApplicationModel,
  DataModel,
  UpdateBlueprintInput,
} from './blueprint.types';

/** Map inferred logical types to Postgres column types. */
const PG_TYPE: Record<InferredType, string> = {
  boolean: 'BOOLEAN',
  integer: 'INTEGER',
  bigint: 'BIGINT',
  numeric: 'NUMERIC',
  uuid: 'UUID',
  date: 'DATE',
  timestamptz: 'TIMESTAMPTZ',
  jsonb: 'JSONB',
  text: 'TEXT',
};

const IDENT_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/** Validate an edited data model (names are SQL identifiers later) and drop any unknown fields. */
export function sanitizeDataModel(input: unknown): DataModel {
  const tablesIn = (input as DataModel | undefined)?.tables;
  if (!Array.isArray(tablesIn) || tablesIn.length === 0) {
    throw new BadRequestException('dataModel needs at least one table');
  }
  const tableNames = new Set<string>();
  const tables = tablesIn.map((t) => {
    const tname = String(t?.name ?? '');
    if (!IDENT_RE.test(tname)) {
      throw new BadRequestException(`Invalid table name "${tname}": use lowercase letters, digits and underscores`);
    }
    if (tableNames.has(tname)) throw new BadRequestException(`Duplicate table name "${tname}"`);
    tableNames.add(tname);
    if (!Array.isArray(t.columns) || t.columns.length === 0) {
      throw new BadRequestException(`Table "${tname}" needs at least one column`);
    }
    const colNames = new Set<string>();
    const columns = t.columns.map((c) => {
      const cname = String(c?.name ?? '');
      if (!IDENT_RE.test(cname)) {
        throw new BadRequestException(`Invalid column name "${cname}" in "${tname}": use lowercase letters, digits and underscores`);
      }
      if (RESERVED_COLUMNS.has(cname)) {
        throw new BadRequestException(`Column "${cname}" in "${tname}" is added automatically; pick another name`);
      }
      if (colNames.has(cname)) throw new BadRequestException(`Duplicate column "${cname}" in "${tname}"`);
      colNames.add(cname);
      if (!Object.prototype.hasOwnProperty.call(PG_TYPE, c.type)) {
        throw new BadRequestException(`Unknown type "${String(c.type)}" for "${tname}.${cname}"`);
      }
      return {
        name: cname,
        originalName: String(c.originalName ?? cname),
        type: c.type,
        nullable: c.nullable !== false,
        sampleValues: Array.isArray(c.sampleValues) ? c.sampleValues.slice(0, 5).map(String) : [],
      };
    });
    return { name: tname, label: String(t.label || tname), columns };
  });
  const warnings = (input as DataModel).warnings;
  return Array.isArray(warnings) ? { tables, warnings: warnings.map(String) } : { tables };
}

/**
 * Excel/CSV → application blueprint. This slice covers the analyze → draft →
 * approve lifecycle (data-model inference + heuristic business/application
 * model). DDL generation and the runtime renderer are layered on later.
 * Re-implemented from the askin concept using our own patterns (no code copied).
 */
@Injectable()
export class BlueprintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collections: CollectionService,
  ) {}

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

  /**
   * Edit the data model by hand (table/column names, types, nullability) and/or
   * rename the app. The application model is rebuilt from the edited tables, so
   * a draft must be approved again; a generated blueprint stays migratable.
   */
  async update(id: string, input: UpdateBlueprintInput, userId?: string) {
    const blueprint = await this.get(id, userId);
    if (blueprint.status === 'GENERATING') {
      throw new BadRequestException('Tables are being generated; try again in a moment');
    }
    if (input?.dataModel === undefined && input?.name === undefined) {
      throw new BadRequestException('dataModel or name is required');
    }
    const name = input.name?.trim() || blueprint.name;
    if (input.dataModel === undefined) {
      return this.prisma.blueprint.update({ where: { id: blueprint.id }, data: { name } });
    }
    const dataModel = sanitizeDataModel(input.dataModel);
    const domain = detectDomain(dataModel);
    const applicationModel = buildApplicationModel(dataModel, domain, name);
    return this.prisma.blueprint.update({
      where: { id: blueprint.id },
      data: {
        name: applicationModel.name,
        domain,
        dataModel: dataModel as unknown as Prisma.InputJsonValue,
        businessModel: buildBusinessModel(dataModel, domain) as unknown as Prisma.InputJsonValue,
        applicationModel: applicationModel as unknown as Prisma.InputJsonValue,
        status: blueprint.generatedDataModel ? 'APPROVED' : 'DRAFT',
      },
    });
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

  /**
   * Generate real relational tables in the target project's database from the
   * approved data model. Idempotent per table (skips ones that already exist).
   * The created tables appear in the project's existing Data/Tables views.
   */
  async generate(id: string, projectId: string | undefined, userId?: string) {
    const blueprint = await this.get(id, userId);
    const targetProjectId = projectId || blueprint.projectId || undefined;
    if (!targetProjectId) {
      throw new BadRequestException('A target projectId is required to generate');
    }
    if (blueprint.status !== 'APPROVED' && blueprint.status !== 'GENERATED') {
      throw new BadRequestException('Blueprint must be approved before generation');
    }
    const dataModel = blueprint.dataModel as unknown as DataModel;
    if (!dataModel?.tables?.length) {
      throw new BadRequestException('Blueprint has no tables to generate');
    }

    await this.prisma.blueprint.update({
      where: { id: blueprint.id },
      data: { status: 'GENERATING', projectId: targetProjectId },
    });

    const results: Array<{ table: string; created: boolean; reason?: string }> = [];
    try {
      for (const table of dataModel.tables) {
        const columns = table.columns.map((c) => ({
          name: c.name,
          type: PG_TYPE[c.type] ?? 'TEXT',
          nullable: c.nullable,
        }));
        const res = await this.collections.createRelationalTable(
          targetProjectId,
          table.name,
          columns,
          userId,
        );
        results.push({ table: table.name, ...res });
      }
      await this.prisma.blueprint.update({
        where: { id: blueprint.id },
        data: {
          status: 'GENERATED',
          generatedDataModel: dataModel as unknown as Prisma.InputJsonValue,
        },
      });
      return {
        status: 'GENERATED',
        projectId: targetProjectId,
        tables: results,
        created: results.filter((r) => r.created).length,
        skipped: results.filter((r) => !r.created).length,
      };
    } catch (e) {
      await this.prisma.blueprint.update({
        where: { id: blueprint.id },
        data: { status: 'FAILED' },
      });
      throw e;
    }
  }

  /**
   * Re-analyze new sheets into an existing blueprint, updating its data model
   * (so a schema migration can be planned against the generated snapshot).
   */
  async resync(
    id: string,
    input: { sheets: AnalyzeBlueprintInput['sheets']; name?: string },
    userId?: string,
  ) {
    const blueprint = await this.get(id, userId);
    if (!Array.isArray(input?.sheets) || input.sheets.length === 0) {
      throw new BadRequestException('at least one sheet is required');
    }
    const dataModel = buildDataModel({ teamId: blueprint.teamId, sheets: input.sheets });
    if (dataModel.tables.length === 0) {
      throw new BadRequestException('no usable tables found in the provided sheets');
    }
    const domain = detectDomain(dataModel);
    const businessModel = buildBusinessModel(dataModel, domain);
    const applicationModel = buildApplicationModel(dataModel, domain, input.name || blueprint.name);

    return this.prisma.blueprint.update({
      where: { id: blueprint.id },
      data: {
        domain,
        dataModel: dataModel as unknown as Prisma.InputJsonValue,
        businessModel: businessModel as unknown as Prisma.InputJsonValue,
        applicationModel: applicationModel as unknown as Prisma.InputJsonValue,
        // Keep it actionable: if already generated, it stays migratable.
        status: blueprint.generatedDataModel ? 'APPROVED' : 'DRAFT',
      },
    });
  }

  async remove(id: string, userId?: string) {
    const blueprint = await this.get(id, userId);
    await this.prisma.blueprint.delete({ where: { id: blueprint.id } });
    return { deleted: true };
  }
}
