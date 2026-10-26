import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Redirect,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { PlatformStatusService, IncidentInput, SampleInput } from './platform-status.service';
import { StatusSubscriptionsService } from './status-subscriptions.service';

/** An external monitor's batch, or Uptime Kuma's webhook body (mapped by monitor name). */
interface SamplesBody {
  vantage?: string;
  samples?: SampleInput[];
  heartbeat?: { status?: number; time?: string; msg?: string; ping?: number | null };
  monitor?: { name?: string; url?: string };
}

function bearerMatches(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ') || !expected) return false;
  const a = createHash('sha256').update(header.slice(7).trim()).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

@Controller('platform-status')
export class PlatformStatusController {
  constructor(
    private readonly status: PlatformStatusService,
    private readonly subscriptions: StatusSubscriptionsService,
  ) {}

  /** Public: what the status page shows. Cached 30 s. */
  @Get('public')
  publicStatus() {
    return this.status.publicStatus();
  }

  /** Public: one calendar month of history (days, monthly figures, incidents). Defaults to the current month. */
  @Get('history')
  history(@Query('month') month?: string) {
    return this.status.history(month);
  }

  /** Public: ask for incident mail. The address gets a confirmation link first. */
  @Post('subscriptions')
  subscribe(@Body() body: { email?: string }) {
    return this.subscriptions.subscribe(body?.email);
  }

  /** The link in the confirmation mail; lands on the status page. */
  @Get('subscriptions/confirm')
  @Redirect()
  async confirmSubscription(@Query('token') token?: string) {
    const ok = await this.subscriptions.confirm(token);
    return { url: `${this.subscriptions.statusPageUrl()}?subscribed=${ok ? '1' : '0'}`, statusCode: 302 };
  }

  /** The link at the foot of every incident mail. */
  @Get('subscriptions/unsubscribe')
  @Redirect()
  async unsubscribe(@Query('token') token?: string) {
    const ok = await this.subscriptions.unsubscribe(token);
    return { url: `${this.subscriptions.statusPageUrl()}?unsubscribed=${ok ? '1' : '0'}`, statusCode: 302 };
  }

  /** Any signed-in user: the month's availability line for the billing page. */
  @UseGuards(JwtAuthGuard)
  @Get('availability')
  availability() {
    return this.status.availabilityForBilling();
  }

  /** External vantage points: the same probes, run from a machine that does not share the platform's fate. */
  @Post('samples')
  async samples(@Headers('authorization') authorization: string | undefined, @Body() body: SamplesBody) {
    this.assertProbeToken(authorization);
    if (body?.heartbeat && body?.monitor) {
      // Uptime Kuma: the monitor's name is the probe (api, dashboard, auth, database, storage, realtime).
      const probe = String(body.monitor.name ?? '').trim().toLowerCase();
      const recorded = await this.status.recordSamples('external', [
        {
          probe,
          ok: body.heartbeat.status === 1,
          ts: body.heartbeat.time,
          latencyMs: typeof body.heartbeat.ping === 'number' ? body.heartbeat.ping : null,
          detail: body.heartbeat.msg ?? null,
        },
      ]);
      return { recorded };
    }
    const recorded = await this.status.recordSamples(body?.vantage ?? '', Array.isArray(body?.samples) ? body.samples : []);
    return { recorded };
  }

  /** The deploy workflow (or anything with the token): a marker on the timeline. */
  @Post('deploys')
  async deploys(@Headers('authorization') authorization: string | undefined, @Body() body: { imageTag?: string; note?: string }) {
    this.assertProbeToken(authorization);
    await this.status.recordDeploy(String(body?.imageTag ?? ''), body?.note ?? null);
    return { recorded: true };
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('console')
  consoleStatus() {
    return this.status.consoleStatus();
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Post('incidents')
  createIncident(@Body() body: IncidentInput, @CurrentUser() user: JwtPayload) {
    return this.status.createIncident(body ?? {}, user.sub);
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Patch('incidents/:id')
  updateIncident(@Param('id') id: string, @Body() body: IncidentInput, @CurrentUser() user: JwtPayload) {
    return this.status.updateIncident(id, body ?? {}, user.sub);
  }

  /** Create the canary project once, owned by the caller's personal organization. */
  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Post('canary')
  setupCanary(@CurrentUser() user: JwtPayload) {
    return this.status.setupCanary(user.sub);
  }

  private assertProbeToken(authorization: string | undefined): void {
    const expected = (process.env.PLATFORM_STATUS_PROBE_TOKEN || '').trim();
    if (!bearerMatches(authorization, expected)) throw new UnauthorizedException('Probe token required');
  }
}
