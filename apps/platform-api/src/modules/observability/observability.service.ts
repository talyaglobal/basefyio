import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AuditLog, Prisma, User, UserRole } from '@prisma/client';

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
      audit: 'kolaybase.root_action',
      snapshot: 'before',
      note: 'No explicit before state was supplied; use action, resource, and Metadata for context.',
      action: params.action,
      resourceType: params.resourceType,
      resourceId: params.resourceId ?? null,
    };
    const defaultAfter: Prisma.InputJsonValue = {
      audit: 'kolaybase.root_action',
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
          metadata: params.metadataJson ?? Prisma.JsonNull,
        } as Prisma.InputJsonValue,
      },
    });

    await this.evaluateAlertRules(params, row.id);
    return row;
  }

  private async attachUserLabelsToAuditLogs(rows: AuditLog[]) {
    const userIds = new Set<string>();
    for (const r of rows) {
      userIds.add(r.actorUserId);
      if (r.resourceId && String(r.resourceType).toLowerCase() === 'user') {
        userIds.add(r.resourceId);
      }
    }
    if (userIds.size === 0) {
      return rows.map((r) => ({
        ...r,
        actorDisplayName: null as string | null,
        resourceDisplayName: null as string | null,
      }));
    }
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...userIds] } },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    const byId = new Map(users.map((u) => [u.id, u] as const));
    return rows.map((r) => ({
      ...r,
      actorDisplayName: formatUserLabel(byId.get(r.actorUserId)) + ` · id ${r.actorUserId}`,
      resourceDisplayName:
        r.resourceId && String(r.resourceType).toLowerCase() === 'user'
          ? formatUserLabel(byId.get(r.resourceId)) + ` · id ${r.resourceId}`
          : r.resourceId
            ? `${r.resourceType}: ${r.resourceId}`
            : null,
    }));
  }

  async listRootAlerts(limit = 100) {
    const alerts = await this.prisma.rootAlert.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const auditIds = alerts.map((a) => a.relatedAuditLogId).filter((id): id is string => !!id);
    if (auditIds.length === 0) {
      return alerts.map((a) => ({
        ...a,
        relatedActorDisplay: null as string | null,
        relatedTargetDisplay: null as string | null,
      }));
    }
    const audits = await this.prisma.auditLog.findMany({
      where: { id: { in: auditIds } },
    });
    const auditById = new Map(audits.map((x) => [x.id, x] as const));
    const userIds = new Set<string>();
    for (const a of audits) {
      userIds.add(a.actorUserId);
      if (a.resourceId && String(a.resourceType).toLowerCase() === 'user') {
        userIds.add(a.resourceId);
      }
    }
    const users =
      userIds.size > 0
        ? await this.prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, email: true, firstName: true, lastName: true },
          })
        : [];
    const byId = new Map(users.map((u) => [u.id, u] as const));
    return alerts.map((alert) => {
      const audit = alert.relatedAuditLogId ? auditById.get(alert.relatedAuditLogId) : undefined;
      let relatedActorDisplay: string | null = null;
      let relatedTargetDisplay: string | null = null;
      if (audit) {
        relatedActorDisplay =
          formatUserLabel(byId.get(audit.actorUserId)) + ` · id ${audit.actorUserId}`;
        if (audit.resourceId && String(audit.resourceType).toLowerCase() === 'user') {
          relatedTargetDisplay =
            formatUserLabel(byId.get(audit.resourceId)) + ` · id ${audit.resourceId}`;
        } else if (audit.resourceId) {
          relatedTargetDisplay = `${audit.resourceType}: ${audit.resourceId}`;
        }
      }
      return {
        ...alert,
        relatedActorDisplay,
        relatedTargetDisplay,
      };
    });
  }

  async markRootAlertRead(alertId: string) {
    return this.prisma.rootAlert.update({
      where: { id: alertId },
      data: { isRead: true },
    });
  }

  /** Upper bound for a single list response (safety). Omit `limit` to use this maximum. */
  private static readonly AUDIT_LOG_LIST_MAX = 500_000;

  async listAuditLogs(limit?: number) {
    const take =
      limit != null && Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), ObservabilityService.AUDIT_LOG_LIST_MAX)
        : ObservabilityService.AUDIT_LOG_LIST_MAX;
    const rows = await this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take,
    });
    return this.attachUserLabelsToAuditLogs(rows);
  }

  async getAuditLogById(id: string) {
    const row = await this.prisma.auditLog.findUnique({ where: { id } });
    if (!row) return null;
    const enriched = await this.attachUserLabelsToAuditLogs([row]);
    return enriched[0] ?? null;
  }
}

