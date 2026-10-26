import { CallHandler, ExecutionContext, HttpException, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { AdmissionService } from './admission.service';

const BYPASS = ['/api/health', '/api/metrics'];

/**
 * Runs after every guard (so a request that wakes a deactivated project has
 * already been recorded) and before the handler. Health, readiness and the
 * scrape are never gated: an overloaded process must still say so.
 */
@Injectable()
export class AdmissionInterceptor implements NestInterceptor {
  constructor(private readonly admission: AdmissionService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http' || this.admission.mode() === 'off') return next.handle();
    const http = context.switchToHttp();
    const req = http.getRequest<any>();
    const path: string = (req.originalUrl || req.url || '').split('?')[0];
    if (req.method === 'OPTIONS' || BYPASS.some((p) => path.startsWith(p))) return next.handle();

    const outcome = await this.admission.admit({
      path,
      method: req.method,
      projectId: req.apiKeyPayload?.projectId ?? null,
      userId: req.user?.sub ?? null,
    });

    const res = http.getResponse<any>();
    if (outcome.bucket) {
      res.setHeader('RateLimit-Limit', String(outcome.bucket.limit.burst));
      res.setHeader('RateLimit-Remaining', String(Math.max(0, outcome.bucket.remaining)));
      res.setHeader('RateLimit-Reset', String(Math.max(1, Math.ceil(outcome.bucket.retryAfterMs / 1000) || 1)));
    }

    if (outcome.enforced && outcome.decision === 'rate_limited') {
      const seconds = Math.max(1, Math.ceil((outcome.bucket?.retryAfterMs ?? 1000) / 1000));
      res.setHeader('Retry-After', String(seconds));
      throw new HttpException(
        { statusCode: 429, code: 'rate_limited', message: `Too many requests for this project; retry in ${seconds} s`, retryAfterSeconds: seconds },
        429,
      );
    }
    if (outcome.enforced && (outcome.decision === 'overloaded' || outcome.decision === 'draining')) {
      res.setHeader('Retry-After', '1');
      throw new HttpException(
        {
          statusCode: 503,
          code: 'overloaded',
          message: outcome.decision === 'draining' ? 'This instance is restarting; retry in a second' : 'The platform is busy; retry in a second',
          retryAfterSeconds: 1,
        },
        503,
      );
    }

    if (outcome.waitedMs > 0) res.setHeader('X-Admission-Wait-Ms', String(outcome.waitedMs));
    return next.handle().pipe(finalize(() => outcome.release()));
  }
}
