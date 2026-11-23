import { BadRequestException, Body, Controller, Get, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { JwtOrPlatformTokenGuard } from '../api-tokens/jwt-or-platform-token.guard';
import { ScopesGuard } from '../api-tokens/scopes.guard';
import { Scopes } from '../api-tokens/scopes.decorator';
import { BillingService } from './billing.service';
import { PlanEnforcementService } from './plan-enforcement.service';
import { validateEnforcementPatch } from './plan-enforcement.rules';

/**
 * Plan limits as the dashboard shows them, and the rollout switch root flips.
 * Kept apart from BillingController so the payment routes are untouched.
 */
@Controller('billing')
export class PlanLimitsController {
  constructor(
    private readonly billing: BillingService,
    private readonly enforcement: PlanEnforcementService,
  ) {}

  /** Each enforced metric against the plan, its mode, and whether it is refused right now. */
  @UseGuards(JwtOrPlatformTokenGuard, ScopesGuard)
  @Scopes('billing:read')
  @Get('limits')
  async limits(@Req() req: any, @Query('teamId') teamId?: string) {
    const userId = req.user.sub;
    if (!teamId) teamId = await this.billing.getUserActiveTeamId(userId);
    await this.billing.verifyCanViewBilling(teamId, userId);
    return this.enforcement.statusForTeam(teamId);
  }

  /** Root: the modes per metric (off | warn | enforce). */
  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('management/plan-enforcement')
  async getModes() {
    return this.enforcement.modes();
  }

  /**
   * Root: change modes, e.g. `{ "api_requests": "enforce" }`. Unknown metrics
   * or modes are refused. Every replica picks the change up within 30 s.
   */
  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Put('management/plan-enforcement')
  async setModes(@Body() body: unknown) {
    const patch = validateEnforcementPatch(body);
    if (!patch) {
      throw new BadRequestException(
        'Send one or more of api_requests, egress, mau, db_size with a mode of off, warn or enforce',
      );
    }
    return this.enforcement.setModes(patch);
  }
}
