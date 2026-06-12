import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import OpenAI from 'openai';
import { PrismaService } from '../../prisma/prisma.service';
import { AnalyzeBlueprintDto } from './dto/analyze-blueprint.dto';
import { BLUEPRINT_GENERATE_QUEUE } from '../queue/queue.module';

// ---------------------------------------------------------------------------
// Inline types (avoids monorepo linking complexity)
// ---------------------------------------------------------------------------

interface DataModelField {
  name: string;
  type: string;
  nullable: boolean;
  unique: boolean;
  primaryKey: boolean;
  description: string;
}

interface DataModelTable {
  name: string;
  displayName: string;
  description: string;
  sourceSheet: string;
  fields: DataModelField[];
}

interface DataModel {
  tables: DataModelTable[];
  version: number;
}

interface BusinessModelActor {
  name: string;
  role: string;
}

interface BusinessModelObject {
  name: string;
  table: string;
}

interface BusinessModel {
  actors: BusinessModelActor[];
  objects: BusinessModelObject[];
  processes: unknown[];
  metrics: unknown[];
  domain: string;
}

// ---------------------------------------------------------------------------
// Inline BusinessModel validation (no external deps)
// ---------------------------------------------------------------------------

function isValidBusinessModel(v: unknown): v is BusinessModel {
  if (!v || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    Array.isArray(obj['actors']) &&
    Array.isArray(obj['objects']) &&
    Array.isArray(obj['processes']) &&
    Array.isArray(obj['metrics']) &&
    typeof obj['domain'] === 'string'
  );
}

// ---------------------------------------------------------------------------
// Domain template defaults
// ---------------------------------------------------------------------------

const DOMAIN_TEMPLATE_DEFAULTS: Record<string, Record<string, unknown>> = {
  crm: {
    defaultViews: ['pipeline', 'contacts', 'activities'],
    features: ['lead-scoring', 'email-integration'],
  },
  inventory: {
    defaultViews: ['stock-levels', 'products', 'warehouses'],
    features: ['low-stock-alerts', 'reorder-points'],
  },
  orders: {
    defaultViews: ['orders', 'invoices', 'shipments'],
    features: ['order-tracking', 'invoice-generation'],
  },
  generic: {
    defaultViews: ['dashboard', 'tables'],
    features: [],
  },
};

// ---------------------------------------------------------------------------
// Inline deriveApplicationModel (15 lines)
// ---------------------------------------------------------------------------

function deriveApplicationModel(
  businessModel: BusinessModel,
  templateDefaults: Record<string, unknown>,
  options: { aiGenerated: boolean },
): Record<string, unknown> {
  return {
    name: `${businessModel.domain.charAt(0).toUpperCase() + businessModel.domain.slice(1)} App`,
    domain: businessModel.domain,
    actors: businessModel.actors,
    objects: businessModel.objects,
    processes: businessModel.processes,
    metrics: businessModel.metrics,
    templateDefaults,
    aiGenerated: options.aiGenerated,
    version: 1,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class BlueprintService {
  private readonly logger = new Logger(BlueprintService.name);
  private openai: OpenAI | null = null;
  private readonly openaiKey: string | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config?: ConfigService,
    @InjectQueue(BLUEPRINT_GENERATE_QUEUE)
    private readonly generateQueue?: Queue,
  ) {
    const apiKey = config?.get<string>('openai.apiKey');
    this.openaiKey = apiKey;
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private detectDomain(dataModel: DataModel): string {
    const names = dataModel.tables.map((t) => t.name.toLowerCase());

    const crmKeywords = ['customers', 'contacts', 'leads', 'deals', 'activities'];
    const inventoryKeywords = ['products', 'inventory', 'stock', 'warehouse', 'items'];
    const orderKeywords = ['orders', 'order_items', 'shipments', 'invoices'];

    if (names.some((n) => crmKeywords.includes(n))) return 'crm';
    if (names.some((n) => inventoryKeywords.includes(n))) return 'inventory';
    if (names.some((n) => orderKeywords.includes(n))) return 'orders';
    return 'generic';
  }

  private genericFallback(dataModel: DataModel, domain: string): BusinessModel {
    return {
      actors: [
        { name: 'Admin', role: 'admin' },
        { name: 'User', role: 'user' },
      ],
      objects: dataModel.tables.map((t) => ({ name: t.displayName, table: t.name })),
      processes: [],
      metrics: [],
      domain,
    };
  }

  private async callAiBusinessModel(
    dataModel: DataModel,
    domain: string,
  ): Promise<BusinessModel> {
    if (!this.openai) {
      return this.genericFallback(dataModel, domain);
    }

    const systemPrompt = `You are a business analyst. Given a data model, produce a BusinessModel JSON with:
- actors: array of {name, role} (system roles/users)
- objects: array of {name, table} (business entities)
- processes: array of business processes (can be empty)
- metrics: array of KPIs (can be empty)
- domain: the detected domain (${domain})

Respond ONLY with valid JSON.`;

    const userPrompt = `Data model tables: ${dataModel.tables.map((t) => t.name).join(', ')}
Domain: ${domain}

Produce the BusinessModel JSON.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        response_format: { type: 'json_object' },
        max_tokens: 1024,
        temperature: 0.3,
      });

      const raw = response.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(raw);
      const candidate = { ...parsed, domain };

      if (!isValidBusinessModel(candidate)) {
        this.logger.warn('AI returned invalid BusinessModel, using fallback');
        return this.genericFallback(dataModel, domain);
      }

      return candidate;
    } catch (err: any) {
      this.logger.error('OpenAI API error in callAiBusinessModel', err?.message);
      return this.genericFallback(dataModel, domain);
    }
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  async analyze(userId: string, dto: AnalyzeBlueprintDto) {
    // 1. Filter excluded sheets
    const activeSheets = dto.sheets.filter(
      (s) => !(dto.excludeSheets ?? []).includes(s.sheet),
    );

    // 2. Derive DataModel: one table per sheet, one field per header
    const tables: DataModelTable[] = activeSheets.map((s) => ({
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

    const dataModel: DataModel = { tables, version: 1 };

    // 3. Domain detection + AI business model
    const domain = this.detectDomain(dataModel);
    const businessModel = await this.callAiBusinessModel(dataModel, domain);
    const domainIntelligence = {
      domain,
      tableCount: dataModel.tables.length,
      detectedAt: new Date().toISOString(),
    };

    // 4. Derive application model
    const templateDefaults = DOMAIN_TEMPLATE_DEFAULTS[domain] ?? DOMAIN_TEMPLATE_DEFAULTS['generic'];
    const applicationModel = deriveApplicationModel(businessModel, templateDefaults, {
      aiGenerated: !!this.openaiKey,
    });

    // 5. Create Blueprint row + ApplicationVersion in transaction
    const blueprint = await (this.prisma as any).blueprint.create({
      data: {
        teamId: dto.teamId,
        status: 'draft',
        dataModel,
        domainIntelligence,
        businessModel,
        uiModel: { pages: [], version: 1 },
        createdBy: userId,
      },
    });

    const version = await (this.prisma as any).applicationVersion.create({
      data: {
        blueprintId: blueprint.id,
        version: 1,
        applicationModel,
        changeSummary: 'Initial AI analysis',
        aiGenerated: !!this.openaiKey,
        createdBy: userId,
      },
    });

    await (this.prisma as any).blueprint.update({
      where: { id: blueprint.id },
      data: { currentVersionId: version.id },
    });

    return {
      blueprintId: blueprint.id,
      status: blueprint.status,
      domain,
      businessModel: {
        actorCount: businessModel.actors.length,
        objectCount: businessModel.objects.length,
        processCount: businessModel.processes.length,
      },
      applicationModelName: applicationModel['name'],
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

  async approve(
    userId: string,
    blueprintId: string,
    applicationModelUpdate: Record<string, unknown>,
  ) {
    const bp = await (this.prisma as any).blueprint.findUnique({
      where: { id: blueprintId },
    });
    if (!bp) throw new NotFoundException('Blueprint not found');

    // Load current version to get version number
    const currentVersion = bp.currentVersionId
      ? await (this.prisma as any).applicationVersion.findUnique({
          where: { id: bp.currentVersionId },
        })
      : null;
    const nextVersion = (currentVersion?.version ?? 0) + 1;

    // Create new ApplicationVersion
    const newVersion = await (this.prisma as any).applicationVersion.create({
      data: {
        blueprintId,
        version: nextVersion,
        applicationModel: applicationModelUpdate,
        changeSummary: 'Manual approval edit',
        aiGenerated: false,
        createdBy: userId,
      },
    });

    // Regen UIModel inline (dashboard + list/form/detail per table)
    const dataModel = bp.dataModel as { tables: Array<{ name: string; displayName: string }> };
    const pages: unknown[] = [
      {
        type: 'dashboard',
        label: 'Dashboard',
        widgets: (dataModel.tables ?? []).slice(0, 4).map((t: any) => `count:${t.name}`),
      },
      ...(dataModel.tables ?? []).flatMap((t: any) => [
        { type: 'list', table: t.name, label: t.displayName, search: true },
        { type: 'form', table: t.name, label: `New ${t.displayName}` },
        { type: 'detail', table: t.name, label: t.displayName },
      ]),
    ];
    const uiModel = { pages, version: 1 };

    // Update Blueprint: currentVersionId + uiModel + status → approved
    const updated = await (this.prisma as any).blueprint.update({
      where: { id: blueprintId },
      data: { currentVersionId: newVersion.id, uiModel, status: 'approved' },
    });

    return {
      blueprintId: updated.id,
      status: updated.status,
      versionId: newVersion.id,
      version: nextVersion,
      uiModel,
    };
  }

  // ---------------------------------------------------------------------------
  // Sprint 4: build-package endpoint
  // ---------------------------------------------------------------------------

  async getBuildPackageForProject(projectId: string) {
    const blueprint = await (this.prisma as any).blueprint.findFirst({
      where: { projectId, status: { in: ['generated', 'approved'] } },
      orderBy: { updatedAt: 'desc' },
    });
    if (!blueprint) throw new NotFoundException(`No generated blueprint for project ${projectId}`);

    const uiModelWithBp = blueprint.uiModel as Record<string, unknown>;
    // The processor embeds buildPackage in uiModel; extract it or build minimal response
    const buildPackage = uiModelWithBp?.buildPackage ?? {
      version: 1,
      projectId,
      blueprintId: blueprint.id,
      generatedAt: blueprint.updatedAt,
      dataModel: blueprint.dataModel,
      businessModel: blueprint.businessModel,
      uiModel: blueprint.uiModel,
      applicationModel: {},
      ddl: [],
    };
    return buildPackage;
  }

  async generate(userId: string, blueprintId: string) {
    const bp = await (this.prisma as any).blueprint.findUnique({ where: { id: blueprintId } });
    if (!bp) throw new NotFoundException('Blueprint not found');
    if (!['approved', 'draft'].includes(bp.status)) {
      throw new BadRequestException(`Blueprint is in status '${bp.status}', expected approved or draft`);
    }

    const job = await this.generateQueue!.add(
      'generate',
      { blueprintId, userId },
      { attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
    );

    await (this.prisma as any).blueprint.update({
      where: { id: blueprintId },
      data: { status: 'queued' },
    });

    return { blueprintId, jobId: job.id, status: 'queued' };
  }

  async getGenerateStatus(blueprintId: string) {
    const bp = await (this.prisma as any).blueprint.findUnique({
      where: { id: blueprintId },
      select: { id: true, status: true, projectId: true, updatedAt: true },
    });
    if (!bp) throw new NotFoundException('Blueprint not found');
    return bp;
  }

  // ---------------------------------------------------------------------------
  // Sprint 5: save dashboard widget
  // ---------------------------------------------------------------------------

  async saveWidget(
    userId: string,
    dto: {
      blueprintId: string;
      widgetLabel: string;
      chartHint: 'table' | 'bar' | 'line' | 'pie';
      sql: string;
      columns: string[];
      sampleData: Record<string, unknown>[];
    },
  ): Promise<{ blueprintId: string; versionId: string; version: number }> {
    const bp = await (this.prisma as any).blueprint.findUnique({ where: { id: dto.blueprintId } });
    if (!bp) throw new NotFoundException('Blueprint not found');

    // Load current app model version
    const currentVersion = bp.currentVersionId
      ? await (this.prisma as any).applicationVersion.findUnique({ where: { id: bp.currentVersionId } })
      : null;
    const nextVersionNum = (currentVersion?.version ?? 0) + 1;

    // Add widget to uiModel dashboard
    const currentUiModel = (bp.uiModel ?? {}) as Record<string, unknown>;
    const currentPages = (currentUiModel.pages as unknown[]) ?? [];

    // Find or create dashboard page
    const dashboardPageIdx = (currentPages as Array<{ type: string }>).findIndex((p) => p.type === 'dashboard');
    const newWidget = {
      type: 'chart',
      chartHint: dto.chartHint,
      label: dto.widgetLabel,
      sql: dto.sql,
      columns: dto.columns,
      sampleData: dto.sampleData.slice(0, 5),
    };

    let updatedPages: unknown[];
    if (dashboardPageIdx >= 0) {
      updatedPages = currentPages.map((p, i) => {
        if (i !== dashboardPageIdx) return p;
        const page = p as Record<string, unknown>;
        const widgets = (page.widgets as unknown[]) ?? [];
        return { ...page, widgets: [...widgets, newWidget] };
      });
    } else {
      // Create a new dashboard page with this widget
      updatedPages = [
        { type: 'dashboard', label: 'Dashboard', widgets: [newWidget] },
        ...currentPages,
      ];
    }

    const updatedUiModel = { ...currentUiModel, pages: updatedPages };

    // Create new ApplicationVersion
    const appModel = (currentVersion?.applicationModel ?? {}) as Record<string, unknown>;
    const newVersion = await (this.prisma as any).applicationVersion.create({
      data: {
        blueprintId: dto.blueprintId,
        version: nextVersionNum,
        applicationModel: appModel,
        changeSummary: `Added dashboard widget: ${dto.widgetLabel}`,
        aiGenerated: false,
        createdBy: userId,
      },
    });

    // Update Blueprint uiModel + currentVersionId
    await (this.prisma as any).blueprint.update({
      where: { id: dto.blueprintId },
      data: { uiModel: updatedUiModel, currentVersionId: newVersion.id },
    });

    return { blueprintId: dto.blueprintId, versionId: newVersion.id, version: nextVersionNum };
  }
}
