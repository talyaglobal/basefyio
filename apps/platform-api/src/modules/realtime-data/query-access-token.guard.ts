import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Lets a native EventSource client authenticate as a signed-in user.
 *
 * EventSource cannot set headers, so an end user's access token may arrive as
 * `?access_token=`. This guard copies it into the Authorization header when no
 * header is present, and nothing more: the verification itself is ApiKeyGuard's,
 * declared after this guard on the same route, so the stream verifies a token
 * exactly the way `rest/v1` does. The service key is not affected — ApiKeyGuard
 * still refuses it from the query string.
 */
@Injectable()
export class QueryAccessTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    if (!req?.headers) return true;
    const present = req.headers['authorization'] || req.headers['Authorization'];
    const token = req.query?.access_token;
    if (!present && typeof token === 'string' && token.trim()) {
      req.headers['authorization'] = `Bearer ${token.trim()}`;
    }
    return true;
  }
}
