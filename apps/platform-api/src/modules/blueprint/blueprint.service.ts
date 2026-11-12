import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectDatabaseService } from '../projects/project-database.service';
import { diffDataModels, planSchemaChanges } from '../migrations/migration-diff';
import {
  analyzeSheets,
  buildApplicationModel,
  buildBusinessModel,
  detectDomain,
  mergeDataModels,
  validateDataModel,
} from './blueprint-builder';
import {
  addForeignKey,
  createTable,
  introspectTables,
  loadIntoExistingTable,
  LoadResult,
} from './blueprint-db';
import { buildGenerationSql, describeAccess, sourceFor } from './blueprint-ddl';
import {
  AnalyzeBlueprintInput,
  ApplicationModel,
  BLUEPRINT_ACCESS_MODES,
  BlueprintAccess,
  BlueprintSourceSheet,
  DataModel,
  DataModelTable,
} from './blueprint.types';

export interface GenerateOptions {
  projectId?: string;
  /** Load the stored spreadsheet rows into the tables (default false). */
  loadData?: boolean;
  /** Row-level security for new tables (default: as last generated, else service_role). */
  access?: BlueprintAccess;
}

export interface GeneratedTableResult {
  table: string;
  created: boolean;
  reason?: string;
  rowsLoaded?: number;
  rowsSkipped?: number;
  errors?: string[];
  /** Existing tables only: schema changes waiting in Schema migrations. */
  pendingChanges?: number;
}

const json = (v: unknown) => v as Prisma.InputJsonValue;

export function isBlueprintAccess(v: unknown): v is BlueprintAccess {
  return typeof v === 'string' && (BLUEPRINT_ACCESS_MODES as readonly string[]).includes(v);
}

function pgMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

/**
 * Excel/CSV → application blueprint: analyze → draft (editable) → approve →
 * generate real tables (keys, references, access policies, data) → evolve
 * them with schema migrations after a re-sync or a draft edit.
 * Re-implemented from the askin concept using our own patterns (no code copied).
 */
@Injectable()
export class BlueprintService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projectDb: ProjectDatabaseService,
  ) {}

  private async assertTeam(teamId: string, userId?: string): Promise<void> {
    if (!userId) throw new ForbiddenException('Authentication required');
    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { id: true },
    });
    if (!member) throw new ForbiddenException('You are not a member of this team');
  }

  private sourceRowCount(sources: BlueprintSourceSheet[]): number {
    return sources.reduce((n, s) => n + s.rows.length, 0);
  }

  async analyze(input: AnalyzeBlueprintInput, userId?: string) {
    if (!input?.teamId) throw new BadRequestException('teamId is required');
    if (!Array.isArray(input.sheets) || input.sheets.length === 0) {
      throw new BadRequestException('at least one sheet is required');
    }
    await this.assertTeam(input.teamId, userId);

    const { dataModel, sources } = analyzeSheets(input);
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
        dataModel: json(dataModel),
        businessModel: json(businessModel),
        applicationModel: json(applicationModel),
        createdBy: userId ?? null,
        source: { create: { sheets: json(sources), rowCount: this.sourceRowCount(sources) } },
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
   * The blueprint plus what the draft screen needs: how many model changes
   * are not in the database yet, and how many source rows can be loaded.
   */
  async getDetail(id: string, userId?: string) {
    const blueprint = await this.get(id, userId);
    const source = await this.prisma.blueprintSource.findUnique({
      where: { blueprintId: id },
      select: { rowCount: true },
    });
    const snapshot = blueprint.generatedDataModel as unknown as DataModel | null;
    const model = blueprint.dataModel as unknown as DataModel;
    let pendingChanges = 0;
    if (snapshot) {
      try {
        pendingChanges = diffDataModels(snapshot, model).changes.length;
      } catch {
        pendingChanges = 0;
      }
    }
    return {
      ...blueprint,
      pendingChanges,
      sourceRowCount: source?.rowCount ?? null,
      generatedAccess: snapshot?.access ?? null,
    };
  }

  async getSourceSheets(id: string): Promise<BlueprintSourceSheet[] | null> {
    const source = await this.prisma.blueprintSource.findUnique({ where: { blueprintId: id } });
    return (source?.sheets as unknown as BlueprintSourceSheet[]) ?? null;
  }

  /**
   * Edit the draft: rename the blueprint, or replace the data model (table
   * and column names, types, empty values, unique, primary key, references).
   * Editing an approved, not yet generated blueprint sends it back to draft;
   * a generated one keeps its status and the edit becomes a pending migration.
   */
  async update(
    id: string,
    body: { name?: unknown; dataModel?: unknown },
    userId?: string,
  ) {
    const blueprint = await this.get(id, userId);
    if (blueprint.status === 'GENERATING') {
      throw new ConflictException('The blueprint is being generated; try again in a moment');
    }
    const data: Prisma.BlueprintUpdateInput = {};
    let name = blueprint.name;
    if (body?.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 200) {
        throw new BadRequestException('name must be 1-200 characters');
      }
      name = body.name.trim();
      data.name = name;
    }
    if (body?.dataModel !== undefined) {
      const current = blueprint.dataModel as unknown as DataModel;
      const result = validateDataModel(body.dataModel, current);
      if (!result.model) {
        throw new BadRequestException(`The data model is not valid: ${result.errors.slice(0, 10).join('; ')}`);
      }
      const model = result.model;
      const domain = detectDomain(model);
      data.dataModel = json(model);
      data.domain = domain;
      data.businessModel = json(buildBusinessModel(model, domain));
      data.applicationModel = json(buildApplicationModel(model, domain, name));
      if (!blueprint.generatedDataModel) data.status = 'DRAFT';
    } else if (data.name && blueprint.applicationModel) {
      data.applicationModel = json({ ...(blueprint.applicationModel as object), name });
    }
    await this.prisma.blueprint.update({ where: { id: blueprint.id }, data });
    return this.getDetail(id, userId);
  }

  /** The exact SQL "Generate tables" would run, for review before approving. */
  async schemaPreview(id: string, access: unknown, userId?: string) {
    const blueprint = await this.get(id, userId);
    const snapshot = blueprint.generatedDataModel as unknown as DataModel | null;
    const mode: BlueprintAccess = isBlueprintAccess(access)
      ? access
      : snapshot?.access ?? 'service_role';
    const model = blueprint.dataModel as unknown as DataModel;
    return {
      access: mode,
      accessDescription: describeAccess(mode),
      statements: buildGenerationSql(model, mode),
    };
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
          // Approving again after generation must not hide the generated state.
          status: blueprint.generatedDataModel ? 'GENERATED' : 'APPROVED',
          name: applicationModel.name,
          applicationModel: json(applicationModel),
        },
      }),
      this.prisma.applicationVersion.create({
        data: {
          blueprintId: id,
          version: nextVersion,
          applicationModel: json(applicationModel),
          changeSummary: nextVersion === 1 ? 'Initial approval' : 'Updated application model',
          createdBy: userId ?? null,
        },
      }),
    ]);
    return updated;
  }

  /**
   * Generate real relational tables in the target project's database from the
   * approved data model: natural primary keys, unique columns, foreign keys,
   * row-level security for the chosen access mode, and (optionally) the
   * spreadsheet rows. Idempotent per table: existing tables are skipped —
   * their pending column changes go through Schema migrations — but an empty
   * table this blueprint created can still receive its data.
   */
  async generate(id: string, opts: GenerateOptions, userId?: string) {
    const blueprint = await this.get(id, userId);
    const targetProjectId = opts?.projectId || blueprint.projectId || undefined;
    if (!targetProjectId) {
      throw new BadRequestException('A target projectId is required to generate');
    }
    if (!['APPROVED', 'GENERATED', 'FAILED'].includes(blueprint.status)) {
      throw new BadRequestException('Blueprint must be approved before generation');
    }
    const checked = validateDataModel(blueprint.dataModel, blueprint.dataModel as unknown as DataModel);
    if (!checked.model) {
      throw new BadRequestException(
        `The data model is not valid: ${checked.errors.slice(0, 10).join('; ')}. Fix it on the draft first.`,
      );
    }
    const model = checked.model;
    if (!model.tables.length) throw new BadRequestException('Blueprint has no tables to generate');

    // A snapshot belongs to the project it was generated into.
    const sameProject = !blueprint.projectId || blueprint.projectId === targetProjectId;
    const prevSnapshot = sameProject
      ? (blueprint.generatedDataModel as unknown as DataModel | null)
      : null;
    const access: BlueprintAccess = isBlueprintAccess(opts?.access)
      ? opts.access
      : prevSnapshot?.access ?? 'service_role';
    const loadData = opts?.loadData === true;
    const sources = loadData ? await this.getSourceSheets(id) : null;

    await this.prisma.blueprint.update({
      where: { id: blueprint.id },
      data: { status: 'GENERATING', projectId: targetProjectId },
    });

    const owned = new Map((prevSnapshot?.tables ?? []).map((t) => [t.name, t]));
    const results: GeneratedTableResult[] = [];
    const foreignKeys: Array<{
      table: string;
      column: string;
      refTable: string;
      refColumn: string;
      created: boolean;
      reason?: string;
    }> = [];
    const snapshotOf = (): DataModel => {
      const tables: DataModelTable[] = model.tables.filter((t) => owned.has(t.name)).map((t) => owned.get(t.name) as DataModelTable);
      for (const t of owned.values()) if (!tables.includes(t)) tables.push(t);
      return { version: model.version, tables, access };
    };

    try {
      await this.projectDb.withProjectDb(targetProjectId, userId, async (client) => {
        const live = await introspectTables(client, model.tables.map((t) => t.name));
        const created: DataModelTable[] = [];

        for (const table of model.tables) {
          const source = loadData ? sourceFor(table, sources) : null;
          if (live.has(table.name)) {
            const result: GeneratedTableResult = { table: table.name, created: false, reason: 'exists' };
            const pending = planSchemaChanges({
              target: { tables: [table] },
              live: new Map([[table.name, live.get(table.name)!]]),
              snapshot: { tables: owned.has(table.name) ? [owned.get(table.name)!] : [] },
            }).changes.length;
            if (pending) result.pendingChanges = pending;
            if (source && owned.has(table.name)) {
              await client.query('BEGIN');
              try {
                const load = await loadIntoExistingTable(client, table, source);
                await client.query('COMMIT');
                if ('skippedReason' in load) result.reason = `exists; data not loaded: ${load.skippedReason}`;
                else Object.assign(result, this.loadSummary(load));
              } catch (err) {
                await client.query('ROLLBACK').catch(() => undefined);
                result.reason = `exists; data not loaded: ${pgMessage(err)}`;
              }
            }
            results.push(result);
            continue;
          }

          await client.query('BEGIN');
          try {
            const load = await createTable(client, table, access, source);
            await client.query('COMMIT');
            created.push(table);
            owned.set(table.name, table);
            results.push({ table: table.name, created: true, ...(load ? this.loadSummary(load) : {}) });
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw new BadRequestException(`Failed to create table "${table.name}": ${pgMessage(err)}`);
          }
        }

        // References last, so every referenced table exists and holds its rows.
        const withFks = created.filter((t) => t.foreignKeys?.length);
        if (withFks.length) {
          await client.query('BEGIN');
          try {
            for (const table of withFks) {
              for (const fk of table.foreignKeys ?? []) {
                const r = await addForeignKey(client, table.name, fk);
                foreignKeys.push({ table: table.name, ...fk, ...r });
              }
            }
            await client.query('COMMIT');
          } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
          }
        }
      });
    } catch (e) {
      await this.prisma.blueprint.update({
        where: { id: blueprint.id },
        data: {
          status: 'FAILED',
          // Tables created before the failure are recorded, so a retry skips them.
          ...(owned.size ? { generatedDataModel: json(snapshotOf()) } : {}),
        },
      });
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      throw new BadRequestException(`Generation failed: ${pgMessage(e)}`);
    }

    await this.prisma.blueprint.update({
      where: { id: blueprint.id },
      data: { status: 'GENERATED', generatedDataModel: json(snapshotOf()) },
    });

    return {
      status: 'GENERATED',
      projectId: targetProjectId,
      tables: results,
      created: results.filter((r) => r.created).length,
      skipped: results.filter((r) => !r.created).length,
      rowsLoaded: results.reduce((n, r) => n + (r.rowsLoaded ?? 0), 0),
      rowsSkipped: results.reduce((n, r) => n + (r.rowsSkipped ?? 0), 0),
      foreignKeys,
      access,
      accessDescription: describeAccess(access),
      ...(loadData && !sources
        ? {
            dataNote:
              'No spreadsheet rows are stored for this blueprint (it predates data loading). Use "Sync from Excel" with the file once, then generate again to load the data.',
          }
        : {}),
    };
  }

  private loadSummary(load: LoadResult): Pick<GeneratedTableResult, 'rowsLoaded' | 'rowsSkipped' | 'errors'> {
    return {
      rowsLoaded: load.rowsLoaded,
      rowsSkipped: load.rowsSkipped,
      ...(load.errors.length ? { errors: load.errors } : {}),
    };
  }

  /**
   * Re-analyze new sheets into an existing blueprint. Draft edits are kept
   * (see mergeDataModels) and the stored rows are replaced. A generated
   * blueprint stays generated: the difference becomes a pending schema
   * migration. Anything else goes back to draft for a fresh approval.
   */
  async resync(
    id: string,
    input: { sheets: AnalyzeBlueprintInput['sheets']; name?: string },
    userId?: string,
  ) {
    const blueprint = await this.get(id, userId);
    if (blueprint.status === 'GENERATING') {
      throw new ConflictException('The blueprint is being generated; try again in a moment');
    }
    if (!Array.isArray(input?.sheets) || input.sheets.length === 0) {
      throw new BadRequestException('at least one sheet is required');
    }
    const analyzed = analyzeSheets({ teamId: blueprint.teamId, sheets: input.sheets });
    if (analyzed.dataModel.tables.length === 0) {
      throw new BadRequestException('no usable tables found in the provided sheets');
    }
    const nextRows = new Map(analyzed.sources.map((s) => [s.table, s.rows]));
    const { dataModel, tableNames } = mergeDataModels(
      blueprint.dataModel as unknown as DataModel,
      analyzed.dataModel,
      nextRows,
    );
    const sources: BlueprintSourceSheet[] = analyzed.sources.map((s) => ({
      ...s,
      table: tableNames.get(s.table) ?? s.table,
    }));
    const domain = detectDomain(dataModel);
    const businessModel = buildBusinessModel(dataModel, domain);
    const name = input.name?.trim() || blueprint.name;
    const applicationModel = buildApplicationModel(dataModel, domain, name);
    const rowCount = this.sourceRowCount(sources);

    await this.prisma.blueprint.update({
      where: { id: blueprint.id },
      data: {
        domain,
        dataModel: json(dataModel),
        businessModel: json(businessModel),
        applicationModel: json(applicationModel),
        status: blueprint.generatedDataModel ? 'GENERATED' : 'DRAFT',
        source: {
          upsert: {
            create: { sheets: json(sources), rowCount },
            update: { sheets: json(sources), rowCount },
          },
        },
      },
    });
    return this.getDetail(id, userId);
  }

  async remove(id: string, userId?: string) {
    const blueprint = await this.get(id, userId);
    await this.prisma.blueprint.delete({ where: { id: blueprint.id } });
    return { deleted: true };
  }
}
