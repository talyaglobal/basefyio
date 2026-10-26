import { Controller, Get, Header, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { EmailService } from '../email/email.service';
import { drainState } from '../../common/utils/drain-state';
import { releaseStage } from '../../common/utils/release-stage';
import { HealthService } from './health.service';

type ReadinessBody =
  | { ready: true }
  | { ready: false; reason: 'draining' | 'database'; detail?: string };

/**
 * Liveness, readiness, and the few things that fail quietly.
 *
 * The process being up is the easy half. Mail is the other: a dead provider
 * key rejected every send while the only sign was an ERROR line in a log
 * nobody reads, so password resets, team invitations and verification codes
 * all failed for weeks and a customer noticed before we did. Anything with
 * that shape — working API, silent side effect — belongs here, next to the
 * dependencies the API cannot serve without.
 *
 * `GET /health` keeps returning 200 while degraded, because Docker's
 * healthcheck uses it to decide whether to restart the container, and an
 * undeliverable e-mail or an unreachable Keycloak is no reason to restart the
 * API. Read `status` rather than the HTTP code.
 *
 * `GET /health/ready` is the one that says whether to send traffic here: 503
 * while the process is draining or the platform database does not answer,
 * 200 otherwise. The proxy and, later, the load balancer use this route.
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly email: EmailService,
    private readonly leader: CronLeaderService,
    private readonly health: HealthService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async check() {
    const mail = this.email.getDeliverability();
    const deps = await this.health.all();
    const dependencyFailing = Object.values(deps).some((c) => c.state === 'failing');
    const degraded =
      mail.state === 'failing' || mail.state === 'not-configured' || dependencyFailing;

    return {
      status: degraded ? 'degraded' : 'ok',
      // The stage the product is in, so the CLI and the dashboard say the
      // same word as the API's own e-mails and invoices.
      release: { stage: releaseStage() },
      checks: {
        email: mail,
        ...deps,
      },
      ...(drainState.isDraining() ? { draining: true } : {}),
      // Which replica answered, and whether it is the one running the scheduled
      // jobs. Behind the proxy several replicas share one hostname, so this is
      // how an operator tells them apart; with one replica it names the build.
      instance: {
        id: this.leader.getInstanceId(),
        role: this.leader.getRole(),
        imageTag: process.env.IMAGE_TAG || 'unknown',
      },
    };
  }

  // `passthrough` so the status can be set here while Nest still sends the
  // body. Returning the Express response object itself would hand a cyclic
  // structure to the global serializer, which recurses until the stack
  // overflows and the process dies — on a route every balancer polls.
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  async ready(@Res({ passthrough: true }) res: Response): Promise<ReadinessBody> {
    if (drainState.isDraining()) {
      res.status(503);
      return { ready: false, reason: 'draining' };
    }
    const database = await this.health.database();
    if (database.state !== 'ok') {
      res.status(503);
      return { ready: false, reason: 'database', detail: database.detail };
    }
    res.status(200);
    return { ready: true };
  }
}
