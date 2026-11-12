import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AuditLog, Prisma, User, UserRole } from '@prisma/client';
import { AuditSinkService } from '../../common/audit/audit-sink.service';
import { toAuditEvent } from '../../common/audit/audit-event';
import {
  AuditPageDirection,
  assertAuditDateRange,
  auditKeysetQuery,
  decodeAuditCursor,
  shapeAuditPage,
} from './audit-pagination';

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

function formatUserLabel(u: Pick<User, 'id' | 'email' | 'firstName' | 'lastName'> | null | undefined): string {
  if (!u) return 'Unknown user';
  const name = [u.firstName, u.lastName].filter(Boolean).join(' ').trim();
  if (name) return `${name} (${u.email})`;
  return u.email;
}

/** A trashed project's row carries an internal `_deleted` suffix; show the name the owner gave it. */
export function displayProjectName(name: string | null | undefined, status?: string | null): string | null {
  if (!name) return null;
  return status === 'DELETED' ? name.replace(/(_\d+)?_deleted$/, '') : name;
}

/** `project:<id>` or `project:<id>/user:<sub>` — the actor recorded for API-key requests. */
export function parseProjectActor(actorUserId: string): { projectId: string; endUserId: string | null } | null {
  const m = /^project:([^/]+)(?:\/user:(.+))?$/.exec(actorUserId || '');
  return m ? { projectId: m[1], endUserId: m[2] ?? null } : null;
}

const KEY_ROLE_LABEL: Record<string, string> = {
  SERVICE_KEY: 'service key',
  ANON_KEY: 'anon key',
  ANON_KEY_USER: 'signed-in app user via anon key',
};

/**
 * One end of an audit date filter. A bare `YYYY-MM-DD` covers the whole day in
 * UTC; anything else must be a full ISO timestamp. Garbage is a 400, not the
 * 500 an Invalid Date used to cause inside the query.
 */
export function parseAuditDate(value: string, edge: 'from' | 'to'): Date {
  const v = value.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v)
    ? new Date(`${v}T${edge === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`)
    : new Date(v);
  if (isNaN(d.getTime())) {
    throw new BadRequestException(
      `${edge === 'from' ? 'dateFrom' : 'dateTo'} must be a date (YYYY-MM-DD) or an ISO 8601 timestamp`,
    );
  }
  return d;
}

/** Alert thresholds for the HTTP audit trail. */
const HTTP_ALERT_WINDOW_MS = 10 * 60 * 1000;
const HTTP_ALERT_DEDUPE_MS = 30 * 60 * 1000;
const FAILED_WRITES_THRESHOLD = 5;
const BULK_DELETES_THRESHOLD = 10;
const CRITICAL_EVENTS = new Set([
  'project.deleted.permanent',
  'team.deleted',
  'team.ownership.transferred',
]);


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
    // The message can quote a request path, which the caller controls.
    const esc = (v: string) =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = `
      <h2>${esc(title)}</h2>
      <p>${esc(message)}</p>
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

  /** Human label for any audit actor: a platform user, or a project's API key. */
  private async actorLabel(actorUserId: string): Promise<string> {
    const projectActor = parseProjectActor(actorUserId);
    if (projectActor) {
      const p = await this.prisma.project.findUnique({
        where: { id: projectActor.projectId },
        select: { name: true, status: true },
      });
      return `Project "${displayProjectName(p?.name, p?.status) ?? projectActor.projectId}" (API key)`;
    }
    const u = await this.prisma.user.findUnique({
      where: { id: actorUserId },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    return formatUserLabel(u);
  }

  /** True when an alert of this kind already names this actor inside the window. */
  private async recentlyAlerted(kind: string, actorUserId: string, windowMs: number): Promise<boolean> {
    const existing = await this.prisma.rootAlert.findFirst({
      where: {
        kind,
        createdAt: { gte: new Date(Date.now() - windowMs) },
        message: { contains: actorUserId },
      },
      select: { id: true },
    });
    return !!existing;
  }

  /**
   * Alert rules over the HTTP audit trail.
   *
   * Root alerts were only ever raised by the handful of explicit root actions,
   * so ordinary traffic — a burst of refused writes, a permanent project
   * deletion, a run of deletions — never produced one. Each rule queries only
   * when the request could trip it, and an actor is alerted at most once per
   * rule per half hour so a burst does not flood the root inboxes.
   */
  async evaluateHttpAuditAlerts(input: {
    auditLogId: string;
    actorUserId: string;
    method: string;
    path: string;
    statusCode: number;
    success: boolean;
    severity: string;
    event: string | null;
  }) {
    const method = input.method.toUpperCase();
    const write = method !== 'GET' && method !== 'HEAD';
    const since = new Date(Date.now() - HTTP_ALERT_WINDOW_MS);
    const writesOnly: Prisma.AuditLogWhereInput = {
      NOT: [{ action: { startsWith: 'GET ' } }, { action: { startsWith: 'HEAD ' } }],
    };

    if (!input.success && write) {
      const failed = await this.prisma.auditLog.count({
        where: { actorUserId: input.actorUserId, success: false, createdAt: { gte: since }, ...writesOnly },
      });
      if (
        failed >= FAILED_WRITES_THRESHOLD &&
        !(await this.recentlyAlerted('REPEATED_FAILED_PRIVILEGED_ACTIONS', input.actorUserId, HTTP_ALERT_DEDUPE_MS))
      ) {
        await this.createRootAlert(
          'REPEATED_FAILED_PRIVILEGED_ACTIONS',
          'HIGH',
          'Repeated failed privileged actions',
          `${await this.actorLabel(input.actorUserId)} (${input.actorUserId}) had ${failed} write requests refused or failing in the last 10 minutes. Latest: ${method} ${input.path} → ${input.statusCode}.`,
          input.auditLogId,
        );
      }
      return;
    }

    if (!input.success) return;

    if (input.event && CRITICAL_EVENTS.has(input.event)) {
      if (!(await this.recentlyAlerted(`HIGH_RISK_ACTION:${input.event}`, input.actorUserId, HTTP_ALERT_WINDOW_MS))) {
        await this.createRootAlert(
          `HIGH_RISK_ACTION:${input.event}`,
          'CRITICAL',
          'High-risk action',
          `${input.event} — ${method} ${input.path} by ${await this.actorLabel(input.actorUserId)} (${input.actorUserId}).`,
          input.auditLogId,
        );
      }
    }

    if (method === 'DELETE') {
      const deletes = await this.prisma.auditLog.count({
        where: {
          actorUserId: input.actorUserId,
          success: true,
          createdAt: { gte: since },
          action: { startsWith: 'DELETE ' },
        },
      });
      if (
        deletes >= BULK_DELETES_THRESHOLD &&
        !(await this.recentlyAlerted('BULK_DESTRUCTIVE_ACTIONS', input.actorUserId, HTTP_ALERT_DEDUPE_MS))
      ) {
        await this.createRootAlert(
          'BULK_DESTRUCTIVE_ACTIONS',
          'HIGH',
          'Many deletions in a short time',
          `${await this.actorLabel(input.actorUserId)} (${input.actorUserId}) deleted ${deletes} resources in the last 10 minutes.`,
          input.auditLogId,
        );
      }
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
          metadata: params.metadataJson ?? Prisma.JsonNull,
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

  /** The project an audit row is about: recorded on newer rows, else read from the URL. */
  private static auditProjectId(r: AuditLog): string | null {
    const meta = (r.metadataJson && typeof r.metadataJson === 'object' ? r.metadataJson : {}) as Record<string, unknown>;
    if (typeof meta.projectId === 'string' && meta.projectId) return meta.projectId;
    const actor = parseProjectActor(r.actorUserId);
    if (actor) return actor.projectId;
    if (String(r.resourceType).toLowerCase() === 'project' && r.resourceId) return r.resourceId;
    const url = typeof meta.url === 'string' ? meta.url : '';
    const m = /\/projects\/([0-9a-f-]{36})(?:\/|$)/i.exec(url || r.action || '');
    return m ? m[1] : null;
  }

  /**
   * Readable names for the actor, the resource, the project and its team.
   *
   * API-key requests are recorded with the project as the actor; those used to
   * read "Unknown user" here while the project's own log called them
   * "System". They now name the project and the key that was used.
   */
  private async attachUserLabelsToAuditLogs(rows: AuditLog[]) {
    const userIds = new Set<string>();
    const projectIds = new Set<string>();
    for (const r of rows) {
      const projectActor = parseProjectActor(r.actorUserId);
      if (projectActor) projectIds.add(projectActor.projectId);
      else userIds.add(r.actorUserId);
      if (r.resourceId && String(r.resourceType).toLowerCase() === 'user') {
        userIds.add(r.resourceId);
      }
      const pid = ObservabilityService.auditProjectId(r);
      if (pid) projectIds.add(pid);
    }
    const [users, projects] = await Promise.all([
      userIds.size
        ? this.prisma.user.findMany({
            where: { id: { in: [...userIds] } },
            select: { id: true, email: true, firstName: true, lastName: true },
          })
        : Promise.resolve([]),
      projectIds.size
        ? this.prisma.project.findMany({
            where: { id: { in: [...projectIds] } },
            select: { id: true, name: true, status: true, teamId: true, team: { select: { name: true } } },
          })
        : Promise.resolve([]),
    ]);
    const byId = new Map(users.map((u) => [u.id, u] as const));
    const projectById = new Map(projects.map((p) => [p.id, p] as const));

    return rows.map((r) => {
      const projectActor = parseProjectActor(r.actorUserId);
      const pid = ObservabilityService.auditProjectId(r);
      const project = pid ? projectById.get(pid) : undefined;
      let actorDisplayName: string;
      if (projectActor) {
        const ap = projectById.get(projectActor.projectId);
        const projectLabel = displayProjectName(ap?.name, ap?.status) ?? projectActor.projectId;
        const keyLabel = KEY_ROLE_LABEL[r.actorRole] ?? 'API key';
        actorDisplayName = projectActor.endUserId
          ? `Project "${projectLabel}" · app user ${projectActor.endUserId} (${keyLabel})`
          : `Project "${projectLabel}" (${keyLabel})`;
      } else {
        actorDisplayName = formatUserLabel(byId.get(r.actorUserId)) + ` · id ${r.actorUserId}`;
      }
      return {
        ...r,
        actorDisplayName,
        resourceDisplayName:
          r.resourceId && String(r.resourceType).toLowerCase() === 'user'
            ? formatUserLabel(byId.get(r.resourceId)) + ` · id ${r.resourceId}`
            : r.resourceId && String(r.resourceType).toLowerCase() === 'project' && project
              ? `project: ${displayProjectName(project.name, project.status)} (${r.resourceId})`
              : r.resourceId
                ? `${r.resourceType}: ${r.resourceId}`
                : null,
        projectId: pid,
        projectDisplayName: project ? displayProjectName(project.name, project.status) : null,
        projectDeleted: project ? project.status === 'DELETED' : pid ? true : false,
        teamId: project?.teamId ?? null,
        teamDisplayName: project?.team?.name ?? null,
      };
    });
  }

  /**
   * Actor ids whose user or project matches a free-text search, so the audit
   * search finds "faruk", "faruk@…" or a project name and not only a raw UUID.
   */
  private async actorIdsMatching(q: string): Promise<{ userIds: string[]; projectIds: string[] }> {
    const parts = q.split(/\s+/).filter(Boolean).slice(0, 4);
    const [users, projects] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          OR: [
            { email: { contains: q, mode: 'insensitive' } },
            { firstName: { contains: q, mode: 'insensitive' } },
            { lastName: { contains: q, mode: 'insensitive' } },
            // "Faruk Karagol": every word matches the first or the last name.
            ...(parts.length > 1
              ? [
                  {
                    AND: parts.map((p) => ({
                      OR: [
                        { firstName: { contains: p, mode: 'insensitive' as const } },
                        { lastName: { contains: p, mode: 'insensitive' as const } },
                      ],
                    })),
                  },
                ]
              : []),
          ],
        },
        select: { id: true },
        take: 200,
      }),
      this.prisma.project.findMany({
        where: { name: { contains: q, mode: 'insensitive' } },
        select: { id: true },
        take: 50,
      }),
    ]);
    return { userIds: users.map((u) => u.id), projectIds: projects.map((p) => p.id) };
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

  private static readonly AUDIT_PAGE_MAX = 100;

  async listAuditLogs(opts: {
    page?: number;
    limit?: number;
    search?: string;
    severity?: string;
    success?: string;
    dateFrom?: string;
    dateTo?: string;
    /** Keyset paging (see audit-pagination.ts); `page` keeps OFFSET paging for older callers. */
    direction?: AuditPageDirection;
    cursor?: string;
  } = {}) {
    const page = Number.isFinite(opts.page) ? Math.max(opts.page as number, 1) : 1;
    const take = Math.min(
      Math.max(Number.isFinite(opts.limit) ? (opts.limit as number) : 50, 1),
      ObservabilityService.AUDIT_PAGE_MAX,
    );
    const skip = (page - 1) * take;
    const fromDate = opts.dateFrom ? parseAuditDate(opts.dateFrom, 'from') : null;
    const toDate = opts.dateTo ? parseAuditDate(opts.dateTo, 'to') : null;
    assertAuditDateRange(fromDate, toDate);

    const where: Record<string, unknown> = {};
    const andConditions: Record<string, unknown>[] = [];

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

    // Date range: a day (YYYY-MM-DD, whole day in UTC) or an exact ISO timestamp.
    if (fromDate) {
      andConditions.push({ createdAt: { gte: fromDate } });
    }
    if (toDate) {
      andConditions.push({ createdAt: { lte: toDate } });
    }

    // Search: action, trace, resource, domain event, and the actor by id, email,
    // name — or, for API-key requests, by the project's name.
    if (opts.search?.trim()) {
      const q = opts.search.trim().slice(0, 200);
      const { userIds, projectIds } = await this.actorIdsMatching(q);
      andConditions.push({
        OR: [
          { action: { contains: q, mode: 'insensitive' } },
          { traceId: { contains: q, mode: 'insensitive' } },
          { actorUserId: { contains: q, mode: 'insensitive' } },
          { resourceType: { contains: q, mode: 'insensitive' } },
          { resourceId: { contains: q, mode: 'insensitive' } },
          { metadataJson: { path: ['event'], string_contains: q } },
          ...(userIds.length ? [{ actorUserId: { in: userIds } }] : []),
          ...projectIds.flatMap((id) => [
            { actorUserId: { startsWith: `project:${id}` } },
            { metadataJson: { path: ['projectId'], equals: id } },
            { action: { contains: `/projects/${id}` } },
          ]),
        ],
      });
    }

    const filtered = andConditions.length > 0;
    if (filtered) {
      where.AND = andConditions;
    }

    if (opts.direction) {
      // Keyset paging: constant cost per page, unaffected by rows written meanwhile.
      const keyset = auditKeysetQuery(opts.direction, opts.cursor ? decodeAuditCursor(opts.cursor) : null);
      const pageWhere = keyset.where ? { AND: [...andConditions, keyset.where] } : where;
      const [fetched, count] = await Promise.all([
        this.prisma.auditLog.findMany({ where: pageWhere, orderBy: keyset.orderBy, take: take + 1 }),
        this.countAuditLogs(where, filtered),
      ]);
      const shaped = shapeAuditPage(opts.direction, fetched, take);
      const enriched = await this.attachUserLabelsToAuditLogs(shaped.rows);
      return {
        data: enriched,
        total: count.total,
        totalIsEstimate: count.estimate,
        limit: take,
        totalPages: Math.max(1, Math.ceil(count.total / take)),
        direction: opts.direction,
        hasNext: shaped.hasNext,
        hasPrev: shaped.hasPrev,
        nextCursor: shaped.nextCursor,
        prevCursor: shaped.prevCursor,
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        skip,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    const enriched = await this.attachUserLabelsToAuditLogs(rows);
    return {
      data: enriched,
      total,
      page,
      limit: take,
      totalPages: Math.ceil(total / take),
    };
  }

  /**
   * Row count for the audit list. Unfiltered, an exact COUNT(*) over the whole
   * table took seconds on every page; the planner's estimate is shown instead
   * (marked as such) once the table is large.
   */
  private async countAuditLogs(
    where: Record<string, unknown>,
    filtered: boolean,
  ): Promise<{ total: number; estimate: boolean }> {
    if (!filtered) {
      try {
        const rows = await this.prisma.$queryRaw<Array<{ estimate: number | bigint | null }>>`
          SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = to_regclass('audit_logs')`;
        const estimate = Number(rows[0]?.estimate ?? -1);
        if (Number.isFinite(estimate) && estimate >= ObservabilityService.AUDIT_EXACT_COUNT_BELOW) {
          return { total: estimate, estimate: true };
        }
      } catch (err: any) {
        this.logger.debug(`Audit row estimate unavailable: ${err?.message || err}`);
      }
    }
    return { total: await this.prisma.auditLog.count({ where }), estimate: false };
  }

  /** Below this many rows an exact count is cheap enough to always run. */
  private static readonly AUDIT_EXACT_COUNT_BELOW = 100_000;

  async getAuditLogById(id: string) {
    const row = await this.prisma.auditLog.findUnique({ where: { id } });
    if (!row) return null;
    const enriched = await this.attachUserLabelsToAuditLogs([row]);
    return enriched[0] ?? null;
  }
}

