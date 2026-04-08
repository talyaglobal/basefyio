import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { Prisma, UserRole } from '@prisma/client';

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

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
        await this.createRootAlert(
          'REPEATED_FAILED_PRIVILEGED_ACTIONS',
          'HIGH',
          'Repeated failed privileged actions',
          `User ${params.actorUserId} produced ${failedCount} failed privileged actions in the last 10 minutes.`,
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
      await this.createRootAlert(
        'HIGH_RISK_ROOT_ACTION',
        'CRITICAL',
        'High-risk ROOT action detected',
        `${params.action} on ${params.resourceType}:${params.resourceId || '-'}`,
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
        beforeJson: params.beforeJson ?? Prisma.JsonNull,
        afterJson: params.afterJson ?? Prisma.JsonNull,
        metadataJson: {
          latencyMs: params.latencyMs,
          metadata: params.metadataJson ?? Prisma.JsonNull,
        } as Prisma.InputJsonValue,
      },
    });

    await this.evaluateAlertRules(params, row.id);
    return row;
  }

  async listRootAlerts(limit = 100) {
    return this.prisma.rootAlert.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async markRootAlertRead(alertId: string) {
    return this.prisma.rootAlert.update({
      where: { id: alertId },
      data: { isRead: true },
    });
  }

  async listAuditLogs(limit = 200) {
    return this.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }
}

