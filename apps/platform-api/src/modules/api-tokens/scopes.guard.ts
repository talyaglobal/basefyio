import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JWT_ONLY_KEY, SCOPES_KEY } from './scopes.decorator';

/**
 * The scope rule for a platform-token request, shared by JwtOrPlatformTokenGuard and ScopesGuard.
 * Fails closed: a token is refused on a route marked @JwtOnly() AND on a route that declares no
 * @Scopes at all — a token is made to look like its owner, so a route without a declared scope
 * would otherwise hand it the owner's full power.
 */
export function assertTokenScopes(
  reflector: Reflector,
  context: ExecutionContext,
  tokenScopes: string[],
): void {
  const targets = [context.getHandler(), context.getClass()];
  if (reflector.getAllAndOverride<boolean>(JWT_ONLY_KEY, targets)) {
    throw new ForbiddenException(
      'API tokens are not accepted on this route; it needs a dashboard session.',
    );
  }
  const required = reflector.getAllAndOverride<string[]>(SCOPES_KEY, targets) || [];
  if (required.length === 0) {
    throw new ForbiddenException(
      'API tokens are not accepted on this route; it needs a dashboard session.',
    );
  }
  const missing = required.filter((s) => !tokenScopes.includes(s));
  if (missing.length > 0) {
    throw new ForbiddenException(`API token is missing required scope(s): ${missing.join(', ')}`);
  }
}

/**
 * Enforces @Scopes(...) for platform-token requests. A dashboard-JWT user has no `platformToken`
 * and is allowed through (their access is role-gated elsewhere). JwtOrPlatformTokenGuard applies
 * the same rule itself, so a controller that forgets this guard still fails closed.
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const token = req.platformToken as { scopes: string[] } | undefined;
    if (!token) return true; // authenticated dashboard user, not a scoped token
    assertTokenScopes(this.reflector, context, token.scopes);
    return true;
  }
}
