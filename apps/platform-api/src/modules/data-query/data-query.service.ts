import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  parseJsQuery,
  validateAggregation,
  QueryValidationError,
} from '@basefyio/data-engine';
import type { EntityAggregation, ParsedJsQuery } from '@basefyio/data-engine';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import { DataEngineService } from '../data-engine/data-engine.service';
import { CollectionService } from '../projects/collection.service';
import {
  filterAstToLegacyFilter,
  selectPathsToLegacyProjection,
  sortClausesToLegacySort,
} from './filter-ast-to-legacy';

// ── Wire shapes (shared with admin-ui) ─────────────────────

export interface DataQueryField {
  name: string;
  dataTypeId: number;
}

export interface DataQueryResult {
  rows: Record<string, unknown>[];
  fields: DataQueryField[];
  rowCount: number;
  duration: number;
  page: number;
  limit: number;
  paginated: boolean;
  total: number | null;
  totalIsApprox?: boolean;
  target: 'entity' | 'collection';
  entity: string;
  action: 'find' | 'count' | 'aggregate';
}

export interface DataQueryCapabilities {
  engineAvailable: boolean;
  queryModes: ('js' | 'aggregation')[];
  capabilities: {
    transactions: boolean;
    fullTextSearch: boolean;
    vectorSearch: boolean;
    ttl: boolean;
    aggregationPipeline: boolean;
  } | null;
}

export interface SavedQueryItem {
  id: string;
  name: string;
  mode: string;
  entity: string | null;
  source: string;
  createdAt: string;
}

interface Paging {
  page: number;
  limit: number;
  offset: number;
  paginated: boolean;
}

const ENGINE_UNAVAILABLE_MESSAGE =
  'Data Engine is not available on this deployment';

@Injectable()
export class DataQueryService {
  private readonly logger = new Logger(DataQueryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ProjectActivityService,
    private readonly dataEngine: DataEngineService,
    private readonly collections: CollectionService,
  ) {}

  // ── JS query execution ─────────────────────────────────

  async executeJs(
    projectId: string,
    source: string,
    userId?: string,
    opts?: { page?: number; limit?: number },
  ): Promise<DataQueryResult> {
    await this.getProjectWithAccess(projectId, userId);

    const startTime = Date.now();
    try {
      let parsed: ParsedJsQuery;
      try {
        parsed = parseJsQuery(source);
      } catch (err: any) {
        if (this.isQueryValidationError(err)) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }

      const paging = this.resolvePaging(parsed, opts);

      const entityDef = await this.prisma.entityDefinition.findUnique({
        where: {
          projectId_logicalName: { projectId, logicalName: parsed.entity },
        },
      });

      let result: DataQueryResult;
      if (entityDef) {
        result = await this.runEntityQuery(projectId, parsed, paging, startTime);
      } else if (await this.collectionExists(projectId, parsed.entity, userId)) {
        result = await this.runCollectionQuery(
          projectId,
          parsed,
          paging,
          userId,
          startTime,
        );
      } else {
        throw new BadRequestException(
          `No entity or collection named "${parsed.entity}" exists in this project`,
        );
      }

      await this.logSuccess(projectId, userId, source, result);
      return result;
    } catch (err: any) {
      await this.logFailure(projectId, userId, source, err);
      throw this.toHttpError(err);
    }
  }

  // ── Aggregation execution ──────────────────────────────

  async executeAggregation(
    projectId: string,
    entity: string,
    pipeline: unknown[],
    userId?: string,
  ): Promise<DataQueryResult> {
    await this.getProjectWithAccess(projectId, userId);

    const engine = this.dataEngine.getEngine();
    if (!engine) {
      throw new BadRequestException(ENGINE_UNAVAILABLE_MESSAGE);
    }
    if (!engine.capabilities().aggregationPipeline) {
      throw new BadRequestException(
        'Aggregation pipelines are not supported by the current data plane yet',
      );
    }

    // Activity preview for aggregations is the pipeline JSON itself.
    const sourceText = JSON.stringify({ entity, pipeline });
    const startTime = Date.now();
    try {
      let aggregation: EntityAggregation;
      try {
        aggregation = validateAggregation(entity, pipeline);
      } catch (err: any) {
        if (this.isQueryValidationError(err)) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }

      const pageResult = await engine.aggregate(projectId, aggregation);
      const rows = pageResult.data as Record<string, unknown>[];
      const result: DataQueryResult = {
        rows,
        fields: this.collectFields(rows),
        rowCount: rows.length,
        duration: Date.now() - startTime,
        page: 1,
        limit: rows.length,
        paginated: false,
        total: pageResult.total ?? null,
        totalIsApprox: false,
        target: 'entity',
        entity,
        action: 'aggregate',
      };

      await this.logSuccess(projectId, userId, sourceText, result);
      return result;
    } catch (err: any) {
      await this.logFailure(projectId, userId, sourceText, err);
      throw this.toHttpError(err);
    }
  }

  // ── Capabilities ───────────────────────────────────────

  async getCapabilities(
    projectId: string,
    userId?: string,
  ): Promise<DataQueryCapabilities> {
    await this.getProjectWithAccess(projectId, userId);

    // The capability flags MUST come from the live engine instance — the
    // runtime provider can silently differ from the configured one.
    const engine = this.dataEngine.getEngine();
    if (!engine) {
      // 'js' always works: NoSQL collections do not require the engine.
      return { engineAvailable: false, queryModes: ['js'], capabilities: null };
    }

    const caps = engine.capabilities();
    const capabilities = {
      transactions: caps.transactions,
      fullTextSearch: caps.fullTextSearch,
      vectorSearch: caps.vectorSearch,
      ttl: caps.ttl,
      aggregationPipeline: caps.aggregationPipeline,
    };
    const queryModes: ('js' | 'aggregation')[] = ['js'];
    if (capabilities.aggregationPipeline) {
      queryModes.push('aggregation');
    }
    return { engineAvailable: true, queryModes, capabilities };
  }

  // ── Saved queries ──────────────────────────────────────

  async listSavedQueries(
    projectId: string,
    userId?: string,
  ): Promise<SavedQueryItem[]> {
    await this.getProjectWithAccess(projectId, userId);

    const rows = await this.prisma.savedDataQuery.findMany({
      where: { projectId },
      orderBy: { name: 'asc' },
    });
    return rows.map((row) => this.mapSavedQuery(row));
  }

  async createSavedQuery(
    projectId: string,
    data: { name: string; source: string; entity?: string; mode?: 'js' | 'aggregation' },
    userId?: string,
  ): Promise<SavedQueryItem> {
    await this.getProjectWithAccess(projectId, userId);

    try {
      const row = await this.prisma.savedDataQuery.create({
        data: {
          projectId,
          name: data.name,
          mode: data.mode ?? 'js',
          entity: data.entity ?? null,
          // The "sql" column predates the js dialect; it stores the query
          // text for all modes.
          sql: data.source,
          createdBy: userId || 'sdk',
        },
      });
      return this.mapSavedQuery(row);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new BadRequestException(
          'A saved query with this name already exists',
        );
      }
      throw err;
    }
  }

  async deleteSavedQuery(
    projectId: string,
    id: string,
    userId?: string,
  ): Promise<{ message: string }> {
    await this.getProjectWithAccess(projectId, userId);

    const row = await this.prisma.savedDataQuery.findUnique({ where: { id } });
    if (!row || row.projectId !== projectId) {
      throw new NotFoundException('Saved query not found');
    }
    await this.prisma.savedDataQuery.delete({ where: { id } });
    return { message: 'Saved query deleted' };
  }

  // ── Target execution ───────────────────────────────────

  private async runEntityQuery(
    projectId: string,
    parsed: ParsedJsQuery,
    paging: Paging,
    startTime: number,
  ): Promise<DataQueryResult> {
    if (!this.dataEngine.isAvailable()) {
      throw new BadRequestException(ENGINE_UNAVAILABLE_MESSAGE);
    }

    let col: Awaited<ReturnType<DataEngineService['getEntityCollection']>>;
    try {
      col = await this.dataEngine.getEntityCollection(projectId, parsed.entity);
    } catch (err: any) {
      throw new BadRequestException(
        err?.message === 'Data Engine not available'
          ? ENGINE_UNAVAILABLE_MESSAGE
          : `Query error: ${err?.message ?? 'Failed to resolve entity collection'}`,
      );
    }

    if (parsed.action === 'count') {
      const count = await col.count(parsed.query.filter);
      return this.buildCountResult(parsed.entity, 'entity', count, startTime);
    }

    const pageResult = await col.query({
      entity: parsed.entity,
      filter: parsed.query.filter,
      sort: parsed.query.sort,
      select: parsed.query.select,
      limit: paging.limit,
      offset: paging.offset,
    });

    const rows = pageResult.data as unknown as Record<string, unknown>[];
    return this.buildFindResult(
      parsed.entity,
      'entity',
      rows,
      pageResult.total ?? null,
      paging,
      startTime,
    );
  }

  private async runCollectionQuery(
    projectId: string,
    parsed: ParsedJsQuery,
    paging: Paging,
    userId: string | undefined,
    startTime: number,
  ): Promise<DataQueryResult> {
    const filter = filterAstToLegacyFilter(parsed.query.filter);

    if (parsed.action === 'count') {
      const { count } = await this.collections.countDocuments(
        projectId,
        parsed.entity,
        filter,
        userId,
      );
      return this.buildCountResult(parsed.entity, 'collection', count, startTime);
    }

    const result = await this.collections.findDocuments(
      projectId,
      parsed.entity,
      {
        filter,
        sort: sortClausesToLegacySort(parsed.query.sort),
        project: selectPathsToLegacyProjection(parsed.query.select),
        limit: paging.limit,
        offset: paging.offset,
      },
      userId,
    );

    // Flatten the storage envelope so the result grid shows document fields
    // as columns; the envelope columns win on name collisions.
    const rows = result.data.map((doc) => ({
      ...(doc.data as Record<string, unknown>),
      id: doc.id,
      created_at: doc.created_at,
      updated_at: doc.updated_at,
    }));

    return this.buildFindResult(
      parsed.entity,
      'collection',
      rows,
      result.total ?? null,
      paging,
      startTime,
    );
  }

  private async collectionExists(
    projectId: string,
    name: string,
    userId?: string,
  ): Promise<boolean> {
    const collections = await this.collections.listCollections(projectId, userId);
    return collections.some((c) => c.name === name);
  }

  // ── Access ─────────────────────────────────────────────

  private async getProjectWithAccess(projectId: string, userId?: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
    });
    if (!project) throw new NotFoundException('Project not found');

    if (userId) {
      const member = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId: project.teamId, userId } },
      });
      if (!member) throw new ForbiddenException('Not a member of this team');
    }

    return project;
  }

  // ── Result shaping ─────────────────────────────────────

  private resolvePaging(
    parsed: ParsedJsQuery,
    opts?: { page?: number; limit?: number },
  ): Paging {
    const q = parsed.query;
    if (q.limit !== undefined || q.offset !== undefined) {
      // Explicit .limit()/.skip() in the query text wins — no server-side
      // pagination. When only .skip() is given, a default page size of 50
      // keeps the scan bounded.
      const limit = Math.min(q.limit ?? 50, 1000);
      return { page: 1, limit, offset: q.offset ?? 0, paginated: false };
    }
    const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 1000);
    const page = Math.max(1, opts?.page ?? 1);
    return { page, limit, offset: (page - 1) * limit, paginated: true };
  }

  private buildFindResult(
    entity: string,
    target: 'entity' | 'collection',
    rows: Record<string, unknown>[],
    total: number | null,
    paging: Paging,
    startTime: number,
  ): DataQueryResult {
    return {
      rows,
      fields: this.collectFields(rows),
      rowCount: rows.length,
      duration: Date.now() - startTime,
      page: paging.page,
      limit: paging.limit,
      paginated: paging.paginated,
      total,
      totalIsApprox: false,
      target,
      entity,
      action: 'find',
    };
  }

  private buildCountResult(
    entity: string,
    target: 'entity' | 'collection',
    count: number,
    startTime: number,
  ): DataQueryResult {
    return {
      rows: [{ count }],
      fields: [{ name: 'count', dataTypeId: 0 }],
      rowCount: 1,
      duration: Date.now() - startTime,
      page: 1,
      limit: 1,
      paginated: false,
      total: null,
      totalIsApprox: false,
      target,
      entity,
      action: 'count',
    };
  }

  /** Union of row keys over the returned rows, in first-seen order. */
  private collectFields(rows: Record<string, unknown>[]): DataQueryField[] {
    const seen = new Set<string>();
    const fields: DataQueryField[] = [];
    for (const row of rows) {
      for (const name of Object.keys(row)) {
        if (!seen.has(name)) {
          seen.add(name);
          fields.push({ name, dataTypeId: 0 });
        }
      }
    }
    return fields;
  }

  // ── Errors & activity ──────────────────────────────────

  private isQueryValidationError(err: unknown): boolean {
    return (
      err instanceof QueryValidationError ||
      (err as { code?: string } | null)?.code === 'QUERY_VALIDATION_FAILED'
    );
  }

  private toHttpError(err: any): Error {
    if (err instanceof HttpException) return err;
    if (this.isQueryValidationError(err)) {
      return new BadRequestException(err.message);
    }
    return new BadRequestException(
      `Query error: ${err?.message ?? 'Unknown error'}`,
    );
  }

  private preview(source: string): string {
    const compact = source.replace(/\s+/g, ' ').trim();
    return `${compact.slice(0, 240)}${compact.length > 240 ? '…' : ''}`;
  }

  /** Activity logging must never break the response — append() swallows its own errors. */
  private async logSuccess(
    projectId: string,
    userId: string | undefined,
    source: string,
    result: DataQueryResult,
  ): Promise<void> {
    await this.activity.append(projectId, {
      userId: userId || undefined,
      kind: ProjectActivityKind.DATA_QUERY_EXECUTED,
      title: `Data query executed (${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}, ${result.duration}ms)`,
      detail: this.preview(source),
      metadata: { rowCount: result.rowCount, duration: result.duration },
    });
  }

  private async logFailure(
    projectId: string,
    userId: string | undefined,
    source: string,
    err: any,
  ): Promise<void> {
    await this.activity.append(projectId, {
      userId: userId || undefined,
      kind: ProjectActivityKind.DATA_QUERY_FAILED,
      title: 'Data query failed',
      detail: `${this.preview(source)} — ${err?.message ?? 'Unknown error'}`,
    });
  }

  private mapSavedQuery(row: {
    id: string;
    name: string;
    mode: string;
    entity: string | null;
    sql: string | null;
    createdAt: Date;
  }): SavedQueryItem {
    return {
      id: row.id,
      name: row.name,
      mode: row.mode,
      entity: row.entity ?? null,
      source: row.sql ?? '',
      createdAt: row.createdAt.toISOString(),
    };
  }
}
