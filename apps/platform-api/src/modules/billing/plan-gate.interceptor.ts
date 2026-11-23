import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { PLAN_GATE_KEY, PlanGateKind } from '../../common/decorators/plan-gate.decorator';
import { sqlGrowsDatabase } from '../sql/sql-growth';
import { PlanEnforcementService } from './plan-enforcement.service';

/**
 * Global, after the guards: routes marked with @PlanGate are checked against
 * the organization's plan limits (database size for writes, monthly active
 * users for sign-ups). Unmarked routes pay nothing but one metadata lookup.
 * A refusal is a 402 with code `plan_limit_exceeded`; in `warn` mode nothing
 * is refused. Any error while deciding admits the request.
 */
@Injectable()
export class PlanGateInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly enforcement: PlanEnforcementService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const kind = this.reflector.getAllAndOverride<PlanGateKind | undefined>(PLAN_GATE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!kind) return next.handle();

    const req = context.switchToHttp().getRequest<any>();
    if (kind === 'sql' && !sqlGrowsDatabase(req.body?.query)) return next.handle();

    const projectId = projectIdOf(req);
    if (!projectId) return next.handle();

    let refusal = null;
    try {
      const teamId = await this.enforcement.teamForProject(projectId);
      if (!teamId) return next.handle();
      refusal = kind === 'signup' ? await this.enforcement.checkSignup(teamId) : await this.enforcement.checkDbWrite(teamId);
    } catch {
      return next.handle();
    }
    if (!refusal) return next.handle();
    // A dashboard caller names the project in the URL or body: only a member of
    // its organization learns about the limit; anyone else gets the route's own answer.
    if (!req.apiKeyPayload) {
      const userId = req.user?.sub;
      const member = userId ? await this.enforcement.isTeamMember(refusal.teamId, userId).catch(() => false) : false;
      if (!member) return next.handle();
    }
    throw new HttpException(refusal.body, refusal.status);
  }
}

/** The project a request acts on: the API key's, the route's, or the SQL route's body. */
export function projectIdOf(req: any): string | null {
  const fromKey = req?.apiKeyPayload?.projectId;
  if (typeof fromKey === 'string' && fromKey) return fromKey;
  const fromParams = req?.params?.projectId;
  if (typeof fromParams === 'string' && fromParams) return fromParams;
  const fromBody = req?.body?.projectId;
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  return null;
}
