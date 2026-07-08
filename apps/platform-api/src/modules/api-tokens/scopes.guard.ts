import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SCOPES_KEY } from './scopes.decorator';

/**
 * Enforces @Scopes(...) for platform-token requests. A dashboard-JWT user has no
 * `platformToken` and is allowed through (their access is role-gated elsewhere);
 * a token must hold every declared scope or the request is 403.
 */
@Injectable()
export class ScopesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) || [];
    if (required.length === 0) return true;

    const req = context.switchToHttp().getRequest();
    const token = req.platformToken as { scopes: string[] } | undefined;
    if (!token) return true; // authenticated dashboard user, not a scoped token

    const missing = required.filter((s) => !token.scopes.includes(s));
    if (missing.length > 0) {
      throw new ForbiddenException(`API token is missing required scope(s): ${missing.join(', ')}`);
    }
    return true;
  }
}
