import { AsyncLocalStorage } from 'async_hooks';
import { Injectable, NestMiddleware } from '@nestjs/common';

/**
 * Request-scoped record of the platform API token (`bf_pat_…`) behind the current request, if any.
 *
 * A token is made to look like its owner (`req.user.sub = ownerUserId`) so existing handlers keep
 * working. A token created for ONE team must still never reach another team the owner belongs to.
 * The guard checks the team or project named in the route; this store lets the Prisma layer apply
 * the same restriction to every membership lookup the services make (see `confineToTokenTeam`),
 * so handlers that resolve their target from a folder, blueprint or invite id are confined too.
 */
export interface TokenRequestContext {
  token?: { id: string; userId: string; teamId: string | null };
}

export const tokenContext = new AsyncLocalStorage<TokenRequestContext>();

/** The team a token-authenticated request is confined to, or undefined (no token, or an unrestricted token). */
export function currentTokenConfinement(): { userId: string; teamId: string } | undefined {
  const token = tokenContext.getStore()?.token;
  if (!token || !token.teamId) return undefined;
  return { userId: token.userId, teamId: token.teamId };
}

/** Opens an empty context per request; JwtOrPlatformTokenGuard fills it in when a token authenticates. */
@Injectable()
export class TokenContextMiddleware implements NestMiddleware {
  use(_req: unknown, _res: unknown, next: () => void) {
    tokenContext.run({}, () => next());
  }
}

/** True when `where` (at any depth) filters on `userId` equal to the given user. */
export function mentionsUser(where: unknown, userId: string, depth = 0): boolean {
  if (!where || typeof where !== 'object' || depth > 8) return false;
  if (Array.isArray(where)) return where.some((w) => mentionsUser(w, userId, depth + 1));
  for (const [key, value] of Object.entries(where as Record<string, unknown>)) {
    if (key === 'userId') {
      if (value === userId) return true;
      if (value && typeof value === 'object') {
        const v = value as Record<string, unknown>;
        if (v.equals === userId) return true;
        if (Array.isArray(v.in) && v.in.includes(userId)) return true;
      }
    }
    if (value && typeof value === 'object' && mentionsUser(value, userId, depth + 1)) return true;
  }
  return false;
}

/** The field that names the team on each confined model. */
const TEAM_FIELD: Record<string, string> = {
  TeamMember: 'teamId',
  Project: 'teamId',
  Team: 'id',
};

const CONFINED_ACTIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
]);

/**
 * Prisma middleware: while a team-restricted token is behind the request, any query on TeamMember,
 * Project or Team that filters by the token owner's userId is narrowed to the token's team. To the
 * services the owner then looks like a member of that one team only, so membership checks for any
 * other team fail exactly as they would for a non-member (403/404), and user-wide lists only show
 * that team. Queries that do not mention the owner (slug checks, lookups by id) are untouched.
 */
export async function confineToTokenTeam(
  params: { model?: string; action: string; args?: any },
  next: (params: any) => Promise<any>,
): Promise<any> {
  const confinement = currentTokenConfinement();
  if (!confinement || !params.model) return next(params);
  const field = TEAM_FIELD[params.model];
  if (!field || !CONFINED_ACTIONS.has(params.action)) return next(params);
  const args = params.args ?? {};
  if (!mentionsUser(args.where, confinement.userId)) return next(params);
  const where = args.where as Record<string, unknown>;
  const existing = where.AND === undefined ? [] : Array.isArray(where.AND) ? where.AND : [where.AND];
  return next({
    ...params,
    args: { ...args, where: { ...where, AND: [...existing, { [field]: confinement.teamId }] } },
  });
}
