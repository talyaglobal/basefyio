import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Rate-limit by the real client IP. The API runs behind Traefik, so the direct
 * peer is the proxy — without this, every request would share one bucket and
 * a single tenant could exhaust the limit for everyone.
 *
 * `req.ip` is Express's answer once `trust proxy` is set to the number of
 * proxies in front of the API (`TRUSTED_PROXY_HOPS`, see main.ts): the
 * right-most hop of X-Forwarded-For that a trusted proxy did not add. The
 * left-most hop, which this guard used to read, is whatever the client chose
 * to send, so a client could pick its own bucket.
 */
@Injectable()
export class ProxyThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    return req?.ip || req?.socket?.remoteAddress || 'unknown';
  }
}
