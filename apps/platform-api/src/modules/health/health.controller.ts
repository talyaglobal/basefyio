import { Controller, Get, Header, Logger, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Response } from 'express';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { EmailService } from '../email/email.service';
import { drainState } from '../../common/utils/drain-state';
import { releaseStage } from '../../common/utils/release-stage';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const PLATFORM_VERSION: string = require('../../../package.json').version;
import { HealthService } from './health.service';

type ReadinessBody =
  | { ready: true }
  | { ready: false; reason: 'draining' | 'database' };

/** The whole picture: error details, latency, which replica answered and the image it runs. */
export async function buildHealthReport(email: EmailService, health: HealthService, leader: CronLeaderService) {
  const mail = email.getDeliverability();
  const deps = await health.all();
  const dependencyFailing = Object.values(deps).some((c) => c.state === 'failing');
  const degraded = mail.state === 'failing' || mail.state === 'not-configured' || dependencyFailing;

  return {
    status: degraded ? 'degraded' : 'ok',
    // The stage the product is in, so the CLI and the dashboard say the
    // same word as the API's own e-mails and invoices.
    release: { stage: releaseStage(), version: PLATFORM_VERSION },
    checks: {
      email: mail,
      ...deps,
    },
    ...(drainState.isDraining() ? { draining: true as const } : {}),
    // Which replica answered, and whether it is the one running the scheduled
    // jobs. Behind the proxy several replicas share one hostname, so this is
    // how an operator tells them apart; with one replica it names the build.
    instance: {
      id: leader.getInstanceId(),
      role: leader.getRole(),
      imageTag: process.env.IMAGE_TAG || 'unknown',
    },
  };
}

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
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly email: EmailService,
    private readonly leader: CronLeaderService,
    private readonly health: HealthService,
  ) {}

  /**
   * Public: whether the platform is up, which version runs, and one word per
   * check (#136). Error texts, which replica answered and the image tag are
   * internal and stay on `GET /health/details`.
   */
  @Get()
  @Header('Cache-Control', 'no-store')
  async check() {
    const full = await buildHealthReport(this.email, this.health, this.leader);
    const checks = Object.fromEntries(
      Object.entries(full.checks).map(([name, c]) => [name, { state: (c as { state: string }).state }]),
    );
    return {
      status: full.status,
      release: full.release,
      checks,
      ...(full.draining ? { draining: true } : {}),
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
      // The error text stays in the log; the route is public (#136).
      this.logger.warn(`Not ready: platform database ${database.detail ?? 'did not answer'}`);
      return { ready: false, reason: 'database' };
    }
    res.status(200);
    return { ready: true };
  }
}
