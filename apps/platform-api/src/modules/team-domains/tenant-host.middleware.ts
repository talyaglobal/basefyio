import { Injectable, Logger, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { TeamDomainsService } from './team-domains.service';
import { classifyHost } from './subdomain.util';

/** Set on a request that arrived on a workspace address (`<subdomain>.<base domain>`). */
export interface RequestTenant {
  teamId: string;
  subdomain: string;
  host: string;
  /** The address is one the team gave up and is still on hold for it. */
  previous: boolean;
}

export type RequestWithTenant = Request & { tenant?: RequestTenant };

/**
 * Resolve the team behind a workspace address.
 *
 * Every host that is not a workspace address — api., app., db., storage., the
 * bare domain, internal container names, localhost — passes straight through
 * untouched, which is what keeps the existing hosts behaving exactly as before.
 * A workspace address that no team holds answers 404 here, before any route
 * runs. The binding interceptor then refuses project credentials that belong
 * to a different team.
 *
 * Only the Host header is read. The proxy forwards it unchanged, and
 * X-Forwarded-Host is something any client can set.
 */
@Injectable()
export class TenantHostMiddleware implements NestMiddleware {
  private readonly logger = new Logger(TenantHostMiddleware.name);

  constructor(private readonly domains: TeamDomainsService) {}

  use(req: RequestWithTenant, res: Response, next: NextFunction): void {
    const hostClass = classifyHost(req.headers.host, this.domains.baseDomain());
    if (hostClass.kind !== 'workspace') return next();

    this.domains
      .resolveLabel(hostClass.label)
      .then((workspace) => {
        if (!workspace) {
          res.status(404).json({
            statusCode: 404,
            code: 'WORKSPACE_NOT_FOUND',
            message: `No workspace uses the address ${hostClass.host}.`,
            timestamp: new Date().toISOString(),
          });
          return;
        }
        req.tenant = {
          teamId: workspace.teamId,
          subdomain: workspace.subdomain,
          host: hostClass.host,
          previous: workspace.previous,
        };
        next();
      })
      .catch((err: unknown) => {
        // A lookup failure must not turn into an anonymous pass-through: the
        // binding check would be skipped. Answer like any other server error.
        this.logger.error(`Workspace lookup failed for ${hostClass.host}: ${(err as Error)?.message ?? err}`);
        res.status(503).json({
          statusCode: 503,
          message: 'The workspace address could not be resolved right now. Try again shortly.',
          timestamp: new Date().toISOString(),
        });
      });
  }
}
