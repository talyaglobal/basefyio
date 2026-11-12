import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { Observable, tap, catchError, throwError } from 'rxjs';
import { AuditSinkService } from '../audit/audit-sink.service';
import { toAuditEvent } from '../audit/audit-event';
import {
  clientIp,
  describeHttpRequest,
  shouldPersistHttpAudit,
  statusFromError,
  userAgent,
} from '../audit/http-audit-classifier';
import { ObservabilityService } from '../../modules/observability/observability.service';

const KNOWN_ROLES = ['ROOT', 'ADMIN', 'USER'] as const;
const ROLE_CACHE_TTL_MS = 5 * 60 * 1000;
const ROLE_CACHE_MAX = 5000;

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AuditLog');
  private static readonly prisma = new PrismaClient();
  /** userId → platform role, so a request does not cost a lookup each time. */
  private static readonly roleCache = new Map<string, { role: string; at: number }>();

  /**
   * The forwarder and the alert rules are optional so the interceptor still
   * constructs on its own (tests, and the integration spec that overrides it).
   */
  constructor(
    @Optional() private readonly auditSink?: AuditSinkService,
    @Optional() private readonly observability?: ObservabilityService,
  ) {}

  private roleFromClaims(user: any): string | null {
    const roles = Array.isArray(user?.roles) ? user.roles : [];
    for (const r of KNOWN_ROLES) if (roles.includes(r)) return r;
    return null;
  }

  /**
   * The platform role of a dashboard user or API-token owner.
   *
   * The JWT carries Keycloak realm roles (offline_access, default-roles-…),
   * not the platform role, so every actor — ROOT included — was recorded as
   * UNKNOWN. The role lives on the user row; it is cached briefly.
   */
  private async resolveActorRole(user: any): Promise<string> {
    const fromClaims = this.roleFromClaims(user);
    if (fromClaims) return fromClaims;
    const id = typeof user?.sub === 'string' ? user.sub : '';
    if (!id) return 'UNKNOWN';
    const cache = AuditLogInterceptor.roleCache;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < ROLE_CACHE_TTL_MS) return hit.role;
    try {
      const row = await AuditLogInterceptor.prisma.user.findUnique({
        where: { id },
        select: { role: true },
      });
      const role = row?.role ? String(row.role) : 'UNKNOWN';
      if (cache.size >= ROLE_CACHE_MAX) cache.clear();
      cache.set(id, { role, at: Date.now() });
      return role;
    } catch {
      return 'UNKNOWN';
    }
  }

  /**
   * Who made this request, for requests that carry an API key instead of a
   * dashboard session.
   *
   * These were not recorded at all: the audit log kept only requests with a
   * JWT user, so everything the SDK and every key-authed caller did was
   * invisible — including, before the keys were bound to their project, a key
   * reaching another tenant. An attack over the public key left no trace.
   *
   * There is no platform user behind a key, so the project stands in as the
   * actor and the role says which key was used and whether an end user had
   * signed in behind it.
   */
  private resolveApiKeyActor(
    request: any,
  ): { actorUserId: string; actorRole: string; projectId: string } | null {
    const key = request?.apiKeyPayload;
    if (!key?.projectId) return null;

    const sub =
      key.jwtClaims && typeof key.jwtClaims.sub === 'string' ? key.jwtClaims.sub : undefined;
    const role =
      key.role === 'service'
        ? 'SERVICE_KEY'
        : key.dbRole === 'authenticated'
          ? 'ANON_KEY_USER'
          : 'ANON_KEY';

    return {
      actorUserId: sub ? `project:${key.projectId}/user:${sub}` : `project:${key.projectId}`,
      actorRole: role,
      projectId: key.projectId,
    };
  }

  private async persistAudit(input: {
    traceId: string;
    actorUserId: string;
    actorRole: string | Promise<string>;
    method: string;
    path: string;
    routePattern: string | null;
    params: Record<string, unknown> | null;
    statusCode: number;
    success: boolean;
    latencyMs: number;
    body?: unknown;
    responseBody?: unknown;
    ip: string | null;
    userAgent: string | null;
    authMethod: string;
    apiTokenId?: string | null;
    keyProjectId?: string | null;
  }) {
    const actorRole = await input.actorRole;
    const action = `${input.method} ${input.path}`;
    const d = describeHttpRequest({
      method: input.method,
      path: input.path,
      routePattern: input.routePattern,
      params: input.params,
      statusCode: input.statusCode,
      success: input.success,
      body: input.body,
      responseBody: input.responseBody,
    });
    const projectId = d.projectId ?? input.keyProjectId ?? null;

    const persist = shouldPersistHttpAudit(input.method, input.path, input.success);
    let row: { id: string; createdAt: Date } | null = null;
    if (persist) {
      const beforeSnapshot: Prisma.InputJsonValue = {
        audit: 'basefyio.http',
        snapshot: 'before',
        note: 'Recorded from the HTTP request; the fields changed are listed in After.',
        event: d.event,
        action,
        resourceType: d.resourceType,
        resourceId: d.resourceId,
      };
      const afterSnapshot: Prisma.InputJsonValue = {
        audit: 'basefyio.http',
        snapshot: 'after',
        event: d.event,
        method: input.method,
        path: input.path,
        statusCode: input.statusCode,
        latencyMs: input.latencyMs,
        success: input.success,
        ...(d.fields ? { fields: d.fields } : {}),
        ...(d.changes ? { changes: d.changes as Prisma.InputJsonValue } : {}),
      };
      try {
        row = await AuditLogInterceptor.prisma.auditLog.create({
          data: {
            traceId: input.traceId,
            actorUserId: input.actorUserId,
            actorRole,
            action,
            resourceType: d.resourceType,
            resourceId: d.resourceId,
            severity: d.severity,
            success: input.success,
            beforeJson: beforeSnapshot,
            afterJson: afterSnapshot,
            metadataJson: {
              latencyMs: input.latencyMs,
              method: input.method,
              url: input.path,
              statusCode: input.statusCode,
              event: d.event,
              route: input.routePattern,
              projectId,
              ip: input.ip,
              userAgent: input.userAgent,
              authMethod: input.authMethod,
              ...(input.apiTokenId ? { apiTokenId: input.apiTokenId } : {}),
            } as Prisma.InputJsonValue,
          },
        });
      } catch (err: any) {
        this.logger.warn(`Failed to persist audit log: ${err?.message || err}`);
      }
    }

    // Forwarded whether or not the row was written: when the database is the
    // thing that failed, the external copy is the only record left.
    try {
      this.auditSink?.enqueue(
        toAuditEvent({
          id: row?.id,
          createdAt: row?.createdAt,
          source: 'http',
          traceId: input.traceId,
          actorUserId: input.actorUserId,
          actorRole,
          action,
          resourceType: d.resourceType,
          resourceId: d.resourceId,
          severity: d.severity,
          success: input.success,
          latencyMs: input.latencyMs,
          method: input.method,
          path: input.path,
          statusCode: input.statusCode,
          event: d.event,
          projectId,
          ip: input.ip,
          userAgent: input.userAgent,
        }),
      );
    } catch (err: any) {
      this.logger.warn(`Failed to forward audit event: ${err?.message || err}`);
    }

    if (row && this.observability) {
      try {
        await this.observability.evaluateHttpAuditAlerts({
          auditLogId: row.id,
          actorUserId: input.actorUserId,
          method: input.method,
          path: input.path,
          statusCode: input.statusCode,
          success: input.success,
          severity: d.severity,
          event: d.event,
        });
      } catch (err: any) {
        this.logger.warn(`Audit alert evaluation failed: ${err?.message || err}`);
      }
    }
  }

  /**
   * Calls `done` with the status the client actually received.
   *
   * The interceptor runs before the response is written: on an error the
   * exception filter sets the status afterwards, so `response.statusCode` still
   * held the route's default 200/201 and every failure was stored with it. A
   * real HTTP response reports its final status on `finish`; anything else
   * (tests, non-HTTP adapters) falls back to the status derived here.
   */
  private whenResponseDone(
    response: any,
    fallbackStatus: number,
    done: (statusCode: number, fromWire: boolean) => void,
  ) {
    let called = false;
    const once = (statusCode: number, fromWire: boolean) => {
      if (called) return;
      called = true;
      done(statusCode, fromWire);
    };
    const canListen =
      response && typeof response.once === 'function' && !response.writableFinished;
    if (!canListen) {
      once(fallbackStatus, false);
      return;
    }
    response.once('finish', () => once(Number(response.statusCode) || fallbackStatus, true));
    response.once('close', () =>
      once(response.headersSent ? Number(response.statusCode) || fallbackStatus : fallbackStatus, response.headersSent),
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (typeof context.getType === 'function' && context.getType() !== 'http') {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const { method, url, user } = request;
    const keyActor = this.resolveApiKeyActor(request);
    const actorUserId = user?.sub ?? keyActor?.actorUserId;
    const shouldAudit = method !== 'OPTIONS' && !!actorUserId;
    const traceId = request?.traceId || 'unknown';
    const path = String(url || '').split('?')[0];
    const now = Date.now();

    // One row per request, even if a handler's observable emits more than once.
    let recorded = false;
    const record = (success: boolean, fallbackStatus: number, responseBody?: unknown) => {
      if (!shouldAudit || recorded) return;
      recorded = true;
      const actorRole = user?.sub
        ? this.resolveActorRole(user)
        : Promise.resolve(keyActor?.actorRole ?? 'UNKNOWN');
      this.whenResponseDone(response, fallbackStatus, (statusCode, fromWire) => {
        void this.persistAudit({
          traceId,
          actorUserId: actorUserId as string,
          actorRole,
          method,
          path,
          routePattern: typeof request?.route?.path === 'string' ? request.route.path : null,
          params: request?.params ?? null,
          statusCode,
          // A handler that writes its own response (@Res) can answer 4xx
          // without throwing; the status on the wire is the truth.
          success: success && (!fromWire || statusCode < 400),
          latencyMs: Date.now() - now,
          body: request?.body,
          responseBody,
          ip: clientIp(request),
          userAgent: userAgent(request),
          authMethod: request?.platformToken
            ? 'api_token'
            : user?.sub
              ? 'session'
              : (keyActor?.actorRole ?? 'unknown').toLowerCase(),
          apiTokenId: request?.platformToken?.id ?? null,
          keyProjectId: keyActor?.projectId ?? null,
        }).catch((err) => this.logger.warn(`Audit write failed: ${err?.message || err}`));
      });
    };

    return next.handle().pipe(
      tap((body) => {
        const duration = Date.now() - now;
        // The path only: a query string can carry a stream credential.
        this.logger.log(
          `${method} ${path} — user=${actorUserId ?? 'anonymous'} — ${duration}ms`,
        );
        record(true, Number(response?.statusCode) || 200, body);
      }),
      catchError((err) => {
        record(false, statusFromError(err));
        return throwError(() => err);
      }),
    );
  }
}
