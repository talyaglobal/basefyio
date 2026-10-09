import {
  CallHandler,
  Controller,
  ExecutionContext,
  Get,
  Header,
  Injectable,
  NestInterceptor,
  Req,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

/**
 * Feeds the metrics counters from every request.
 *
 * Registered globally next to the audit interceptor. It records on both the
 * success and the error path, because a deployment where only the successes
 * are counted looks healthiest exactly when it is failing.
 */
@Injectable()
export class MetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    const started = Date.now();

    const record = (status: number) =>
      this.metrics.observeRequest(req?.method ?? 'UNKNOWN', status, Date.now() - started);

    return next.handle().pipe(
      tap({
        next: () => record(res?.statusCode ?? 200),
        error: (err) => record(err?.status ?? err?.statusCode ?? 500),
      }),
    );
  }
}

/**
 * The scrape endpoint.
 *
 * Metrics are operational data, not public: the series below are harmless on
 * their own, but a scrape endpoint tends to accumulate detail, and one that
 * started out open is never closed afterwards. So it requires a bearer token
 * from METRICS_TOKEN and refuses when that is unset — an operator who wants
 * metrics sets a token, and an install that never configured one does not
 * quietly publish them.
 */
@SkipThrottle()
@Controller('metrics')
export class MetricsController {
  private readonly logger = new Logger(MetricsController.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  scrape(@Req() req: Request): string {
    const expected = this.config.get<string>('METRICS_TOKEN');
    if (!expected) {
      throw new UnauthorizedException(
        'Metrics are not published: set METRICS_TOKEN and scrape with it as a bearer token.',
      );
    }

    const header = req.headers.authorization ?? '';
    const presented = /^bearer /i.test(header) ? header.slice(7).trim() : '';
    if (!presented || !timingSafeEqual(presented, expected)) {
      throw new UnauthorizedException('Invalid metrics token');
    }

    return this.metrics.render();
  }
}

/**
 * Compares without leaking the answer through how long it took.
 *
 * Node's own timingSafeEqual throws on a length mismatch, which is itself a
 * signal, so the lengths are folded into the same constant-time comparison.
 */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}
