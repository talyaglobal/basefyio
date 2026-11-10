import { Injectable, Logger, Optional } from '@nestjs/common';
import { escapeLike } from '../../common/utils/escape-like';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AuditLog, Prisma, User, UserRole } from '@prisma/client';
import { AuditSinkService } from '../../common/audit/audit-sink.service';
import { toAuditEvent } from '../../common/audit/audit-event';

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

function formatUserLabel(u: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'> | null | undefined): string {
  if (!u) return 'Unknown user';
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (name) return `${name} (${u.email})`;
  return u.email;
}


interface CaptureRootActionParams {
  traceId: string;
  actorUserId: string;
  actorRole?: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  severity?: Severity;
  success: boolean;
  latencyMs: number;
  beforeJson?: Prisma.InputJsonValue | null;
  afterJson?: Prisma.InputJsonValue | null;
  metadataJson?: Prisma.InputJsonValue | null;
}

@Injectable()
export class ObservabilityService {
  private readonly logger = new Logger(ObservabilityService.name);
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    @Optional() private readonly auditSink?: AuditSinkService,
  ) {}

  private incrementMetric(key: string) {
    this.counters.set(key, (this.counters.get(key) || 0) + 1);
  }

  private async createRootAlert(
    kind: string,
    severity: Severity,
    title: string,
    message: string,
    relatedAuditLogId?: string,
  ) {
    const alert = await this.prisma.rootAlert.create({
      data: {
        kind,
        severity,
        title,
        message,
        relatedAuditLogId: relatedAuditLogId || null,
      },
    });

    const roots = await this.prisma.user.findMany({
      where: { role: UserRole.ROOT },
      select: { email: true },
    });
    const html = `
      <h2>${title}</h2>
      <p>${message}</p>
      <p><strong>Severity:</strong> ${severity}</p>
      <p><strong>Alert Id:</strong> ${alert.id}</p>
      <p><strong>Time:</strong> ${new Date(alert.createdAt).toISOString()}</p>
    `;
    await Promise.all(
      roots
        .map((u) => u.email)
        .filter((v): v is string => !!v)
        .map((to) =>
          this.email.sendRawHtml(to, `[ROOT Alert] ${title}`, html).catch(() => null),
        ),
    );
  }

  private async evaluateAlertRules(params: CaptureRootActionParams, auditLogId: string) {
    if (!params.success) {
      const since = new Date(Date.now() - 10 * 60 * 1000);
      const failedCount = await this.prisma.auditLog.count({
        where: {
          actorUserId: params.actorUserId,
          success: false,
          createdAt: { gte: since },
        },
      });
      if (failedCount >= 3) {
        const actor = await this.prisma.user.findUnique({
          where: { id: params.actorUserId },
          select: { id: true, email: true, firstName: true, lastName: true },
        });
        const actorLabel = formatUserLabel(actor);
        await this.createRootAlert(
          'REPEATED_FAILED_PRIVILEGED_ACTIONS',
          'HIGH',
          'Repeated failed privileged actions',
          `${actorLabel} (${params.actorUserId}) produced ${failedCount} failed privileged actions in the last 10 minutes.`,
          auditLogId,
        );
      }
      return;
    }

    const highRiskAction =
      params.action === 'AUTH_ROLE_UPDATED_TO_ROOT' ||
      params.action === 'BILLING_PLAN_DELETED' ||
      params.action === 'AUTH_USER_DEACTIVATED';
    if (highRiskAction) {
      const ids = [params.actorUserId, params.resourceId].filter((x): x is string => !!x);
      const users = await this.prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, email: true, firstName: true, lastName: true },
      });
      const byId = new Map(users.map((u) => [u.id, u] as const));
      const actorLabel = formatUserLabel(byId.get(params.actorUserId));
      const resourcePart =
        params.resourceType?.toLowerCase() === 'user' && params.resourceId
          ? `${formatUserLabel(byId.get(params.resourceId))} (${params.resourceId})`
          : `${params.resourceType}:${params.resourceId || '-'}`;
      await this.createRootAlert(
        'HIGH_RISK_ROOT_ACTION',
        'CRITICAL',
        'High-risk ROOT action detected',
        `${params.action} — by ${actorLabel} (${params.actorUserId}) on ${resourcePart}`,
        auditLogId,
      );
    }
  }

  async captureRootAction(params: CaptureRootActionParams) {
    const actor = await this.prisma.user.findUnique({
      where: { id: params.actorUserId },
      select: { role: true },
    });
    const actorRole = params.actorRole || actor?.role || 'UNKNOWN';
    if (actorRole !== UserRole.ROOT) {
      return null;
    }

    this.incrementMetric(`root_action_total:${params.action}:${params.success ? 'success' : 'fail'}`);
    this.incrementMetric(`root_action_latency_bucket_ms:${Math.ceil(params.latencyMs / 100) * 100}`);
    if (!params.success) {
      this.incrementMetric('root_action_failed_total');
    }

    const defaultBefore: Prisma.InputJsonValue = {
      audit: 'basefyio.root_action',
      snapshot: 'before',
      note: 'No explicit before state was supplied; use action, resource, and Metadata for context.',
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId ?? null,
    };
    const defaultAfter: Prisma.InputJsonValue = {
      audit: 'basefyio.root_action',
      snapshot: 'after',
      success: params.success,
      latencyMs: params.latencyMs,
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId ?? null,
    };

    const row = await this.prisma.auditLog.create({
      data: {
        traceId: params.traceId,
        actorUserId: params.actorUserId,
        actorRole,
        action: params.action,
        resourceType: params.resourceType,
        resourceId: params.resourceId || null,
        severity: params.severity || 'MEDIUM',
        success: params.success,
        beforeJson: params.beforeJson != null ? params.beforeJson : defaultBefore,
        afterJson: params.afterJson != null ? params.afterJson : defaultAfter,
        metadataJson: {
          latencyMs: params.latencyMs,
          // an absent value is left out; Prisma.JsonNull inside a JSON object is stored as the string "JsonNull"
          ...(params.metadataJson != null ? { metadata: params.metadataJson } : {}),
        } as Prisma.InputJsonValue,
      },
    });

    try {
      this.auditSink?.enqueue(
        toAuditEvent({
          id: row.id,
          createdAt: row.createdAt,
          source: 'root_action',
          traceId: row.traceId,
          actorUserId: row.actorUserId,
          actorRole: row.actorRole,
          action: row.action,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          severity: row.severity,
          success: row.success,
          latencyMs: params.latencyMs,
        }),
      );
    } catch (err: any) {
      this.logger.warn(`Failed to forward root action audit: ${err?.message || err}`);
    }

    await this.evaluateAlertRules(params, row.id);
    return row;
  }

  /**
   * Readable actor and target labels for audit rows: users by name, project-key actors
   * ("project:<id>[/user:<sub>]") and team/project targets by their names, never a bare id.
   */
  private async entityLabels(rows: Array<Pick<AuditLog, 'actorUserId' | 'resourceType' | 'resourceId'>>) {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const keyActor = (id: string | null | undefined) => /^project:([0-9a-f-]{36})(?:\/user:(.+))?$/i.exec(id ?? '');
    const kind = (t: string | null | undefined) => String(t ?? '').toLowerCase();
    const userIds = new Set<string>();
    const teamIds = new Set<string>();
    const projectIds = new Set<string>();
    for (const r of rows) {
      const k = keyActor(r.actorUserId);
      if (k) {
        projectIds.add(k[1]);
        if (k[2]) userIds.add(k[2]);
      } else if (r.actorUserId) userIds.add(r.actorUserId);
      if (!r.resourceId) continue;
      const t = kind(r.resourceType);
      if (t === 'user') userIds.add(r.resourceId);
      else if (t === 'team' && uuid.test(r.resourceId)) teamIds.add(r.resourceId);
      else if ((t === 'project' || t === 'projects') && uuid.test(r.resourceId)) projectIds.add(r.resourceId);
    }
    const [users, teams, projects] = await Promise.all([
      userIds.size
        ? this.prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, email: true, firstName: true, lastName: true },
          })
        : [],
      teamIds.size
        ? this.prisma.team.findMany({ where: { id: { in: [...teamIds] } }, select: { id: true, name: true } })
        : [],
      projectIds.size
        ? this.prisma.project.findMany({ where: { id: { in: [...projectIds] } }, select: { id: true, name: true } })
        : [],
    ]);
    const userBy = new Map(users.map((u) => [u.id, u] as const));
    const teamBy = new Map(teams.map((t) => [t.id, t.name] as const));
    const projectBy = new Map(projects.map((p) => [p.id, p.name] as const));
    const userLabel = (id: string) => formatUserLabel(userBy.get(id)) + ` · id ${id}`;
    return {
      actor: (id: string): string => {
        const k = keyActor(id);
        if (!k) return userLabel(id);
        const via = k[2] ? ` (as ${formatUserLabel(userBy.get(k[2]))})` : '';
        return `Project key · ${projectBy.get(k[1]) ?? 'deleted project'}${via}`;
      },
      resource: (type: string | null | undefined, id: string | null | undefined): string | null => {
        if (!id) return null;
        const t = kind(type);
        if (t === 'user') return userLabel(id);
        if (t === 'team') return `Team: ${teamBy.get(id) ?? id}`;
        if (t === 'project' || t === 'projects') return `Project: ${projectBy.get(id) ?? id}`;
        return `${type}: ${id}`;
      },
    };
  }

  private async attachUserLabelsToAuditLogs(rows: AuditLog[]) {
    if (rows.length === 0) return [];
    const labels = await this.entityLabels(rows);
    return rows.map((r) => ({
      ...r,
      actorDisplayName: labels.actor(r.actorUserId),
      resourceDisplayName: labels.resource(r.resourceType, r.resourceId),
    }));
  }

  async listRootAlerts(limit = 100) {
    const alerts = await this.prisma.rootAlert.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const auditIds = alerts.map((a) => a.relatedAuditLogId).filter((id): id is string => !!id);
    const audits = auditIds.length
      ? await this.prisma.auditLog.findMany({ where: { id: { in: auditIds } } })
      : [];
    const auditById = new Map(audits.map((x) => [x.id, x] as const));
    const labels = audits.length ? await this.entityLabels(audits) : null;
    return alerts.map((alert) => {
      const audit = alert.relatedAuditLogId ? auditById.get(alert.relatedAuditLogId) : undefined;
      return {
        ...alert,
        relatedActorDisplay: audit && labels ? labels.actor(audit.actorUserId) : null,
        relatedTargetDisplay: audit && labels ? labels.resource(audit.resourceType, audit.resourceId) : null,
      };
    });
  }

  async markRootAlertRead(alertId: string) {
    return this.prisma.rootAlert.update({
      where: { id: alertId },
      data: { isRead: true },
    });
  }

  private static readonly AUDIT_PAGE_MAX = 100;

  async listAuditLogs(opts: {
    page?: number;
    limit?: number;
    search?: string;
    severity?: string;
    success?: string;
    dateFrom?: string;
    dateTo?: string;
    /** Snapshot cut-off from the first page: rows written since do not shift later pages. */
    asOf?: string;
  } = {}) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), ObservabilityService.AUDIT_PAGE_MAX);
    const asOfDate = opts.asOf ? new Date(opts.asOf) : new Date();
    const asOf = Number.isNaN(asOfDate.getTime()) ? new Date() : asOfDate;

    const where: Record<string, unknown> = {};
    const andConditions: Record<string, unknown>[] = [{ createdAt: { lte: asOf } }];

    // Severity filter
    if (opts.severity && opts.severity !== 'ALL') {
      andConditions.push({ severity: opts.severity });
    }

    // Success filter
    if (opts.success === 'SUCCESS') {
      andConditions.push({ success: true });
    } else if (opts.success === 'FAILED') {
      andConditions.push({ success: false });
    }

    // Date range
    if (opts.dateFrom) {
      andConditions.push({ createdAt: { gte: new Date(`${opts.dateFrom}T00:00:00Z`) } });
    }
    if (opts.dateTo) {
      andConditions.push({ createdAt: { lte: new Date(`${opts.dateTo}T23:59:59.999Z`) } });
    }

    // Search (action, traceId, actorUserId, resourceType, resourceId)
    if (opts.search?.trim()) {
      const q = escapeLike(opts.search.trim());
      andConditions.push({
        OR: [
          { action: { contains: q, mode: 'insensitive' } },
          { traceId: { contains: q, mode: 'insensitive' } },
          { actorUserId: { contains: q, mode: 'insensitive' } },
          { resourceType: { contains: q, mode: 'insensitive' } },
          { resourceId: { contains: q, mode: 'insensitive' } },
        ],
      });
    }

    if (andConditions.length > 0) {
      where.AND = andConditions;
    }

    const total = await this.prisma.auditLog.count({ where });
    const totalPages = Math.ceil(total / take);
    const page = Math.min(Math.max(opts.page ?? 1, 1), Math.max(totalPages, 1));
    const skip = (page - 1) * take;
    // A deep offset walks every skipped row; in the second half read from the oldest end instead.
    const fromOldest = skip > total / 2;
    const size = Math.min(take, total - skip);
    let rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: fromOldest ? 'asc' : 'desc' },
      take: Math.max(size, 0),
      skip: fromOldest ? total - skip - size : skip,
    });
    if (fromOldest) rows = rows.reverse();

    const enriched = await this.attachUserLabelsToAuditLogs(rows);
    return {
      data: enriched,
      total,
      page,
      limit: take,
      totalPages,
      asOf: asOf.toISOString(),
    };
  }

  async getAuditLogById(id: string) {
    const row = await this.prisma.auditLog.findUnique({ where: { id } });
    if (!row) return null;
    const enriched = await this.attachUserLabelsToAuditLogs([row]);
    return enriched[0] ?? null;
  }
}

