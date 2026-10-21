import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { EmailService } from '../email/email.service';

/**
 * Liveness, plus the few things that fail quietly.
 *
 * The process being up is the easy half. Mail is the other: a dead provider
 * key rejected every send while the only sign was an ERROR line in a log
 * nobody reads, so password resets, team invitations and verification codes
 * all failed for weeks and a customer noticed before we did. Anything with
 * that shape — working API, silent side effect — belongs here.
 *
 * The endpoint keeps returning 200 while degraded, because Traefik and Docker
 * use it to decide whether to route traffic, and an undeliverable email is no
 * reason to take the API out of the load balancer. Read `status` rather than
 * the HTTP code.
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly email: EmailService,
    private readonly leader: CronLeaderService,
  ) {}

  @Get()
  check() {
    const mail = this.email.getDeliverability();
    const degraded = mail.state === 'failing' || mail.state === 'not-configured';

    return {
      status: degraded ? 'degraded' : 'ok',
      checks: {
        email: mail,
      },
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
}
