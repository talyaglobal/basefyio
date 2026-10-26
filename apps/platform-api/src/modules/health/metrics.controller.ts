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
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { Observable, finalize, tap } from 'rxjs';
import { MetricsService } from './metrics.service';
import { MetricsCollectorService } from './metrics-collector.service';

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
    const routeClass = classifyRoute(req?.originalUrl ?? req?.url ?? '');
    this.metrics.inflight(1);

    const record = (status: number) =>
      this.metrics.observeRequest(req?.method ?? 'UNKNOWN', status, Date.now() - started, routeClass);

    return next.handle().pipe(
      tap({
        next: () => record(res?.statusCode ?? 200),
        error: (err) => record(err?.status ?? err?.statusCode ?? 500),
      }),
      finalize(() => this.metrics.inflight(-1)),
    );
  }
}

/**
 * Which surface a request belongs to, from its path prefix only — never the
 * path itself, which carries tenant table and bucket names.
 */
export function classifyRoute(url: string): string {
  const path = url.replace(/^\/api\//, '/').split('?')[0];
  if (path.startsWith('/rest/')) return 'rest';
  if (path.startsWith('/sql')) return 'sql';
  if (path.startsWith('/auth') || path.includes('/auth/')) return 'auth';
  if (path.startsWith('/storage') || path.includes('/storage/')) return 'storage';
  if (path.startsWith('/realtime') || path.includes('/realtime/')) return 'realtime';
  if (path.startsWith('/admin/')) return 'admin';
  if (path.startsWith('/health') || path.startsWith('/metrics')) return 'other';
  if (
    path.startsWith('/projects') ||
    path.startsWith('/teams') ||
    path.startsWith('/billing') ||
    path.startsWith('/organizations') ||
    path.startsWith('/feedback')
  ) {
    return 'dashboard';
  }
  return 'other';
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
    // Optional so the controller can be built by hand in a test with no
    // collector; the scrape then carries the in-process series only.
    @Optional() private readonly collector?: MetricsCollectorService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(@Req() req: Request): Promise<string> {
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

    // Gauges that describe the platform rather than this process — projects
    // by status, queue depths, dependency reachability — are read at scrape
    // time, bounded by the collector's own timeouts and cache.
    await this.collector?.refresh().catch(() => undefined);
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
