import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
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
      } catch (err) {
        // A valid key aimed at another project is a refusal, not a failed
        // login. Folding it into the generic 401 below would tell the caller
        // their key is wrong when it is the target that is.
        if (err instanceof ForbiddenException) throw err;
      }
    }

    throw new UnauthorizedException('Valid JWT or API key required');
  }
}
