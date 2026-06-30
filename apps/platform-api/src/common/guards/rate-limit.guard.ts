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
    const ip =
      (request.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      request.ip ||
      'unknown';

    const route = request.route?.path || request.url;
    const key = `rl:${route}:${ip}`;

    const current = await this.redis.get(key);
    const count = current ? parseInt(current, 10) : 0;

    if (count >= config.maxRequests) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests. Please try again later.',
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Atomically increment and set TTL on first access
    const client = this.redis.getClient();
    const newCount = await client.incr(key);
    if (newCount === 1) {
      await client.expire(key, config.windowSeconds);
    }
    return true;
  }
}
