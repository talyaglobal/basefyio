import { ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard, bearerOf } from '../../common/guards/jwt-auth.guard';
import { tokenContext } from '../../common/request-context/token-context';
import { ApiTokensService } from './api-tokens.service';
import { isPlatformToken } from './platform-token.util';
import { assertTokenScopes } from './scopes.guard';

/**
 * Accepts EITHER a dashboard Keycloak JWT (full access, role-gated as before) OR a platform API
 * token (`bf_pat_…`). For a token the guard itself enforces, in order:
 *
 *  1. scopes — fail closed: @JwtOnly() routes and routes without @Scopes refuse every token (403),
 *     a token missing a declared scope gets 403 (same rule as ScopesGuard);
 *  2. team confinement — a token created for one team gets 403 on any project or team of another
 *     team named in the route params, query or body (`projectId`, `teamId`, `projects/:id`,
 *     `teams/:id`), and the request context narrows every owner-membership lookup the services
 *     make to that team (see common/request-context/token-context.ts).
 *
 * A token request is then made to look like the owner user (`req.user.sub = userId`, no roles) so
 * handlers and their team-membership / role checks work unchanged.
 */
@Injectable()
export class JwtOrPlatformTokenGuard extends JwtAuthGuard {
  constructor(
    private readonly tokens: ApiTokensService,
    private readonly reflector: Reflector,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const bearer = bearerOf(req);

    if (!isPlatformToken(bearer)) {
      // Not a platform token → the Keycloak JWT strategy, unchanged.
      return (await super.canActivate(context)) as boolean;
    }

    let verified;
    try {
      verified = await this.tokens.verify(bearer);
    } catch {
      throw new UnauthorizedException('Invalid or expired API token');
    }

    assertTokenScopes(this.reflector, context, verified.scopes);
    await this.tokens.assertWithinTeam(verified, tokenTargets(context, req));

    req.user = { sub: verified.userId, email: await this.tokens.ownerEmail(verified.userId), roles: [] };
    req.platformToken = {
      id: verified.id,
      userId: verified.userId,
      teamId: verified.teamId,
      scopes: verified.scopes,
    };
    const store = tokenContext.getStore();
    if (store) {
      store.token = { id: verified.id, userId: verified.userId, teamId: verified.teamId };
    } else if (verified.teamId) {
      // Without the request context the membership lookups could not be confined: refuse.
      throw new ForbiddenException('This API token is limited to one team and cannot be used on this route.');
    }
    return true;
  }
}

function pathOf(target: object): string {
  const p = Reflect.getMetadata(PATH_METADATA, target);
  return Array.isArray(p) ? String(p[0] ?? '') : String(p ?? '');
}

function strings(...values: unknown[]): string[] {
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** The projects and teams a request names, read from the route template, params, query and body. */
export function tokenTargets(
  context: ExecutionContext,
  req: { params?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown },
): { projectIds: string[]; teamIds: string[] } {
  const params = req.params ?? {};
  const query = req.query ?? {};
  const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
  const projectIds = strings(params.projectId, query.projectId, body.projectId);
  const teamIds = strings(params.teamId, query.teamId, body.teamId);

  // `projects/:id` and `teams/:id` name a project / team through the generic `id` parameter.
  const template = `${pathOf(context.getClass())}/${pathOf(context.getHandler())}`
    .split('/')
    .filter(Boolean);
  template.forEach((segment, i) => {
    if (!segment.startsWith(':') || i === 0) return;
    const name = segment.slice(1);
    const value = params[name];
    if (typeof value !== 'string' || !value) return;
    if (template[i - 1] === 'projects' && name === 'id') projectIds.push(value);
    if (template[i - 1] === 'teams' && name === 'id') teamIds.push(value);
  });
  return { projectIds, teamIds };
}
