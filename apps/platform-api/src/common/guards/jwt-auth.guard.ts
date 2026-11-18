import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { isPlatformToken } from '../../modules/api-tokens/platform-token.util';

/** The `Bearer …` value of the request, or ''. */
export function bearerOf(req: { headers?: Record<string, unknown> }): string {
  const header = (req?.headers?.authorization || req?.headers?.Authorization) as string | undefined;
  return typeof header === 'string' && /^bearer /i.test(header) ? header.replace(/^bearer /i, '').trim() : '';
}

/**
 * Dashboard session (Keycloak JWT) only. A platform API token (`bf_pat_…`) is refused with 403 and
 * a clear reason instead of the strategy's generic 401: the credential is valid, this route just
 * does not take it. Routes that accept tokens use JwtOrPlatformTokenGuard instead.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  canActivate(context: ExecutionContext) {
    if (isPlatformToken(bearerOf(context.switchToHttp().getRequest()))) {
      throw new ForbiddenException('API tokens are not accepted on this route; it needs a dashboard session.');
    }
    return super.canActivate(context);
  }
}
