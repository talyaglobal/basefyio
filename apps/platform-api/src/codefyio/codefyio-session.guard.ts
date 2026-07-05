import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { CodefyioJwtService } from './codefyio-jwt.service';

/**
 * Guards the authed adapter routes: requires a valid adapter session token
 * (issued by /auth/exchange) and attaches the resolved account to the request.
 * EventSource cannot set headers, so a `?token=` query param is accepted too.
 */
@Injectable()
export class CodefyioSessionGuard implements CanActivate {
  constructor(private readonly jwt: CodefyioJwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const header = (req.headers?.authorization || req.headers?.Authorization) as string | undefined;
    let token: string | undefined;
    if (header && /^bearer /i.test(header)) token = header.replace(/^bearer /i, '').trim();
    if (!token && typeof req.query?.token === 'string') token = req.query.token;
    if (!token) throw new UnauthorizedException('Missing adapter session token');
    req.codefyioSession = this.jwt.verifySession(token);
    return true;
  }
}
