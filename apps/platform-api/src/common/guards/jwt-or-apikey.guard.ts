import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ApiKeyGuard } from './api-key.guard';

@Injectable()
export class JwtOrApiKeyGuard implements CanActivate {
  constructor(
    private readonly jwtGuard: JwtAuthGuard,
    private readonly apiKeyGuard: ApiKeyGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    if (request.headers.authorization?.startsWith('Bearer ')) {
      try {
        const result = await this.jwtGuard.canActivate(context);
        if (result) return true;
      } catch {}
    }

    if (request.headers['apikey']) {
      try {
        return await this.apiKeyGuard.canActivate(context);
      } catch {}
    }

    throw new UnauthorizedException('Valid JWT or API key required');
  }
}
