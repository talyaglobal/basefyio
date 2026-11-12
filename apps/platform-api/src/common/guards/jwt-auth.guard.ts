import { ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { isStreamPath, redeemStreamTicket } from '../auth/stream-ticket';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  /**
   * An event-stream GET may authenticate with a single-use `?ticket=` (see
   * common/auth/stream-ticket.ts) instead of a bearer token, because the
   * browser's EventSource cannot send headers. Everything else goes through
   * the JWT strategy exactly as before.
   */
  canActivate(context: ExecutionContext) {
    if (typeof context.getType === 'function' && context.getType() === 'http') {
      const req = context.switchToHttp().getRequest();
      const ticket = typeof req?.query?.ticket === 'string' ? req.query.ticket : '';
      const hasBearer = !!(req?.headers?.authorization || req?.headers?.Authorization);
      const path = typeof req?.path === 'string' ? req.path : String(req?.url || '').split('?')[0];
      if (ticket && !hasBearer && req?.method === 'GET' && isStreamPath(path)) {
        const user = redeemStreamTicket(ticket, path);
        if (!user) throw new UnauthorizedException('Stream ticket is invalid, expired or already used');
        req.user = user;
        return true;
      }
    }
    return super.canActivate(context);
  }
}
