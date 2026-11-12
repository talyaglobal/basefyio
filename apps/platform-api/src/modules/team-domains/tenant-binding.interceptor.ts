import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, from, switchMap } from 'rxjs';
import { TeamDomainsService } from './team-domains.service';
import { RequestTenant } from './tenant-host.middleware';

/** Every project a request names or authenticates as: the API key's, and any in the path, body or query. */
export function projectIdsOf(req: any): string[] {
  const candidates = [
    req?.apiKeyPayload?.projectId,
    req?.params?.projectId,
    req?.body && typeof req.body === 'object' ? req.body.projectId : undefined,
    req?.query?.projectId,
  ];
  return [...new Set(candidates.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}

/**
 * On a workspace address, refuse any project that belongs to another team.
 *
 * `technoplatz.<domain>` must only ever serve technoplatz's projects: an API
 * key, or a project named in the path, body or query, that belongs to a
 * different team is refused instead of being served under the wrong name.
 * Requests on every other host never carry a tenant and pass untouched.
 *
 * An interceptor rather than a guard because it has to run after the
 * controller's own guards, which are what resolve the API key to a project.
 */
@Injectable()
export class TenantBindingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantBindingInterceptor.name);

  constructor(private readonly domains: TeamDomainsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest();
    const tenant: RequestTenant | undefined = req?.tenant;
    if (!tenant) return next.handle();
    return from(this.assertBelongs(req, tenant)).pipe(switchMap(() => next.handle()));
  }

  private async assertBelongs(req: any, tenant: RequestTenant): Promise<void> {
    for (const projectId of projectIdsOf(req)) {
      const teamId = await this.domains.teamOfProject(projectId);
      // An unknown project is left to the route, which answers 404 as usual.
      if (teamId === null || teamId === tenant.teamId) continue;
      const route = `${req.method} ${req.originalUrl ?? req.url ?? ''}`.split('?')[0];
      this.logger.warn(`Refused project ${projectId} of team ${teamId} on workspace address ${tenant.host} (${route})`);
      throw new ForbiddenException({
        code: 'WORKSPACE_MISMATCH',
        message: `This project does not belong to the workspace at ${tenant.host}. Use the project's own workspace address, or the main API address.`,
      });
    }
  }
}
