import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import { RedisService } from '../../modules/redis/redis.service';

export const RATE_LIMIT_KEY = 'rateLimit';

/**
 * Decorator: @RateLimit(maxRequests, windowSeconds)
 * Apply to a controller method to enforce per-IP rate limiting via Redis.
 */
export const RateLimit = (maxRequests: number, windowSeconds: number) =>
  SetMetadata(RATE_LIMIT_KEY, { maxRequests, windowSeconds });

/**
 * Count the hit and start the window on the first hit, in one step. Done as
 * two commands, a crash between INCR and EXPIRE left a counter with no expiry
 * — a client locked out of sign-in until someone noticed.
 */
const COUNT_HIT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.reflector.get<{ maxRequests: number; windowSeconds: number }>(
      RATE_LIMIT_KEY,
      context.getHandler(),
    );
    if (!config) return true;

    const request = context.switchToHttp().getRequest();
    // Express's view of the client behind the trusted proxies (`trust proxy`
    // in main.ts), never the left-most X-Forwarded-For hop the client supplies.
    const ip = request.ip || request.socket?.remoteAddress || 'unknown';

    const route = request.route?.path || request.url;
    const key = `rl:${route}:${ip}`;

    const count = Number(
      await this.redis.getClient().eval(COUNT_HIT, 1, key, String(config.windowSeconds)),
    );

    if (count > config.maxRequests) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests. Please try again later.',
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
