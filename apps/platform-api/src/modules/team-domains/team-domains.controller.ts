import { Body, Controller, Delete, Get, Param, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { TeamDomainsService } from './team-domains.service';
import { ClaimSubdomainDto } from './dto/claim-subdomain.dto';
import { RequestWithTenant } from './tenant-host.middleware';

/** A team's workspace address: `<subdomain>.<base domain>`. */
@Controller('teams/:teamId/domain')
@UseGuards(JwtAuthGuard)
export class TeamDomainsController {
  constructor(private readonly domains: TeamDomainsService) {}

  /** The current address, the earlier ones still on hold, and whether it answers yet. Any member. */
  @Get()
  get(@Param('teamId') teamId: string, @CurrentUser() user: JwtPayload) {
    return this.domains.getForTeam(teamId, user.sub);
  }

  /** Whether `name` could be claimed by this team, with the reason when not. Any member. */
  @Get('availability')
  availability(
    @Param('teamId') teamId: string,
    @Query('name') name: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.domains.checkAvailability(teamId, user.sub, name);
  }

  /** Claim or change the address. Owners and admins. */
  @Put()
  claim(
    @Param('teamId') teamId: string,
    @Body() body: ClaimSubdomainDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.domains.claim(teamId, user.sub, body.subdomain);
  }

  /** Give the address up; it stays on hold for this team for a while. Owners and admins. */
  @Delete()
  release(@Param('teamId') teamId: string, @CurrentUser() user: JwtPayload) {
    return this.domains.release(teamId, user.sub);
  }
}

/**
 * `GET /api/tenant` — which workspace, if any, the address a request came in
 * on belongs to. Public: it only echoes the address itself, which DNS already
 * publishes. Useful to check that a workspace address is wired up end to end.
 */
@Controller('tenant')
export class TenantController {
  constructor(private readonly domains: TeamDomainsService) {}

  @Get()
  current(@Req() req: RequestWithTenant) {
    const tenant = req.tenant;
    if (!tenant) return { workspace: null };
    return {
      workspace: {
        subdomain: tenant.subdomain,
        host: tenant.host,
        apiUrl: `https://${tenant.host}`,
        // The SDK appends /api itself; plain HTTP clients use this.
        restUrl: `https://${tenant.host}/api/rest/v1`,
        database: { host: tenant.host, port: this.domains.databasePort() },
        previous: tenant.previous,
      },
    };
  }
}
