import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit by the real client IP. The API runs behind Traefik, so the direct
 * peer is the proxy — without this, every request would share one bucket and a
 * single tenant could exhaust the limit for everyone. We read the left-most
 * X-Forwarded-For hop (the original client) and fall back to the socket IP.
 */
@Injectable()
export class ProxyThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const xff = req?.headers?.['x-forwarded-for'];
    if (typeof xff === 'string' && xff.trim().length > 0) {
      return xff.split(',')[0].trim();
    }
    if (Array.isArray(xff) && xff.length > 0) {
      return String(xff[0]).split(',')[0].trim();
    }
    return req?.ip || req?.socket?.remoteAddress || 'unknown';
  }
}
