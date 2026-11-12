import { Controller, Get, Header, Optional, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { EmailService } from '../email/email.service';
import { bearerToken, timingSafeEqual } from './metrics.controller';

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
 *
 * The route is public, so anyone gets the verdict and nothing else. The
 * provider's own words about why mail fails and which build and replica
 * answered are operator detail: they come back only with the operator token
 * (`Authorization: Bearer $METRICS_TOKEN`, the one `/api/metrics` takes), or
 * for everyone when an install opts in with HEALTH_PUBLIC_DETAIL=true.
 */
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly email: EmailService,
    private readonly leader: CronLeaderService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  check(@Req() req?: Request) {
    const mail = this.email.getDeliverability();
    const degraded = mail.state === 'failing' || mail.state === 'not-configured';
    const status = degraded ? 'degraded' : 'ok';

    if (!this.showsDetail(req)) {
      return {
        status,
        checks: {
          email: { state: mail.state, ...(mail.checkedAt ? { checkedAt: mail.checkedAt } : {}) },
        },
      };
    }

    return {
      status,
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

  private showsDetail(req?: Request): boolean {
    if (String(this.config?.get<string>('HEALTH_PUBLIC_DETAIL') ?? '').toLowerCase() === 'true') return true;
    const expected = this.config?.get<string>('METRICS_TOKEN');
    if (!expected) return false;
    const presented = bearerToken(req);
    return !!presented && timingSafeEqual(presented, expected);
  }
}
