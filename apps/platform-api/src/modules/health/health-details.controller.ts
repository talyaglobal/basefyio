import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { CronLeaderService } from '../cluster/cron-leader.service';
import { EmailService } from '../email/email.service';
import { buildHealthReport } from './health.controller';
import { HealthService } from './health.service';

/**
 * `GET /health/details`, root only (#136): the full health report with error
 * texts, latency, replica id and image tag. The public `GET /health` carries
 * only the status, the version and one state per check.
 */
@SkipThrottle()
@Controller('health')
@UseGuards(JwtAuthGuard, RootRoleGuard)
export class HealthDetailsController {
  constructor(
    private readonly email: EmailService,
    private readonly leader: CronLeaderService,
    private readonly health: HealthService,
  ) {}

  @Get('details')
  @Header('Cache-Control', 'no-store')
  details() {
    return buildHealthReport(this.email, this.health, this.leader);
  }
}
