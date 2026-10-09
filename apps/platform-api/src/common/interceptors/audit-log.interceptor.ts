import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { Observable, tap, catchError, throwError } from 'rxjs';

@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AuditLog');
  private static readonly prisma = new PrismaClient();

  private getActorRole(user: any): string {
    const roles = Array.isArray(user?.roles) ? user.roles : [];
    if (roles.includes('ROOT')) return 'ROOT';
    if (roles.includes('ADMIN')) return 'ADMIN';
    if (roles.includes('USER')) return 'USER';
    return 'UNKNOWN';
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

  private normalizeResourceType(url: string): string {
    const clean = (url || '').split('?')[0];
    const parts = clean.split('/').filter(Boolean);
    if (parts.length === 0) return 'system';
    if (parts[0] === 'api' && parts[1]) return parts[1];
    return parts[0];
  }

  private async persistAudit(input: {
    traceId: string;
    actorUserId: string;
    actorRole: string;
    action: string;
    resourceType: string;
    success: boolean;
    latencyMs: number;
    metadataJson?: Record<string, unknown>;
  }) {
    const path = (input.metadataJson?.url as string | undefined) || '';
    const method = (input.metadataJson?.method as string | undefined) || '';
    const statusCode = input.metadataJson?.statusCode as number | undefined;

    const beforeSnapshot: Prisma.InputJsonValue = {
      audit: 'basefyio.http',
      snapshot: 'before',
      note: 'HTTP access audit: no domain entity diff; request context is recorded in After.',
      action: input.action,
      resourceType: input.resourceType,
    };

    const afterSnapshot: Prisma.InputJsonValue = {
      audit: 'basefyio.http',
      snapshot: 'after',
      method,
      path,
      statusCode: statusCode ?? null,
      latencyMs: input.latencyMs,
      success: input.success,
    };

    try {
      await AuditLogInterceptor.prisma.auditLog.create({
        data: {
          traceId: input.traceId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          action: input.action,
          resourceType: input.resourceType,
          resourceId: null,
          severity: input.success ? 'LOW' : 'HIGH',
          success: input.success,
          beforeJson: beforeSnapshot,
          afterJson: afterSnapshot,
          metadataJson: {
            latencyMs: input.latencyMs,
            method: input.metadataJson?.method,
            url: input.metadataJson?.url,
            statusCode: input.metadataJson?.statusCode,
          } as Prisma.InputJsonValue,
        },
      });
    } catch (err: any) {
      this.logger.warn(`Failed to persist audit log: ${err?.message || err}`);
    }
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const { method, url, user } = request;
    const keyActor = this.resolveApiKeyActor(request);
    const actorUserId = user?.sub ?? keyActor?.actorUserId;
    const shouldAudit = method !== 'OPTIONS' && !!actorUserId;
    const traceId = request?.traceId || 'unknown';
    const actorRole = user?.sub ? this.getActorRole(user) : (keyActor?.actorRole ?? 'UNKNOWN');
    const resourceType = this.normalizeResourceType(url);
    const action = `${method} ${url.split('?')[0]}`;
    const now = Date.now();

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - now;
        this.logger.log(
          `${method} ${url} — user=${actorUserId ?? 'anonymous'} — ${duration}ms`,
        );
        if (shouldAudit) {
          void this.persistAudit({
            traceId,
            actorUserId: actorUserId as string,
            actorRole,
            action,
            resourceType,
            success: true,
            latencyMs: duration,
            metadataJson: {
              method,
              url: url.split('?')[0],
              statusCode: response?.statusCode,
            },
          });
        }
      }),
      catchError((err) => {
        const duration = Date.now() - now;
        if (shouldAudit) {
          void this.persistAudit({
            traceId,
            actorUserId: actorUserId as string,
            actorRole,
            action,
            resourceType,
            success: false,
            latencyMs: duration,
            metadataJson: {
              method,
              url: url.split('?')[0],
              statusCode: response?.statusCode,
            },
          });
        }
        return throwError(() => err);
      }),
    );
  }
}
