import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

/**
 * Usage tracking middleware — simplified for the OSS edition.
 * The commercial billing/usage-metering logic has been removed.
 * Override this class to add your own analytics tracking.
 */
@Injectable()
export class UsageTrackingMiddleware implements NestMiddleware {
  private readonly logger = new Logger(UsageTrackingMiddleware.name);

  async use(req: Request, _res: Response, next: NextFunction) {
    const path = req.originalUrl || req.url;
    if (path.startsWith('/rest/') || path.startsWith('/api/')) {
      this.logger.debug(`API request: ${req.method} ${path}`);
    }
    next();
  }
}
