import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ApiTokensService } from './api-tokens.service';
import { isPlatformToken } from './platform-token.util';

/**
 * Accepts EITHER a dashboard Keycloak JWT (full access, role-gated as before) OR a
 * platform API token (`bf_pat_…`, limited to its scopes — enforced by ScopesGuard).
 * A token request is made to look like the owner user (`req.user.sub = userId`) so
 * existing handlers + team-membership checks work unchanged.
 */
@Injectable()
export class JwtOrPlatformTokenGuard extends JwtAuthGuard {
  constructor(private readonly tokens: ApiTokensService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = (req.headers?.authorization || req.headers?.Authorization) as string | undefined;
    const bearer =
      typeof header === 'string' && /^bearer /i.test(header)
        ? header.replace(/^bearer /i, '').trim()
        : '';

    if (isPlatformToken(bearer)) {
      let verified;
      try {
        verified = await this.tokens.verify(bearer);
      } catch {
        throw new UnauthorizedException('Invalid or expired API token');
      }
      req.user = { sub: verified.userId, email: '', roles: [] };
      req.platformToken = {
        id: verified.id,
        userId: verified.userId,
        teamId: verified.teamId,
        scopes: verified.scopes,
      };
      return true;
    }

    // Not a platform token → fall back to the Keycloak JWT strategy.
    return (await super.canActivate(context)) as boolean;
  }
}
