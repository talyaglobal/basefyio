import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { TeamsService } from './teams.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { ObservabilityService } from '../observability/observability.service';
import { RequestWithTraceId } from '../../common/middleware/trace-id.middleware';

@Controller('teams')
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(
    private readonly teamsService: TeamsService,
    private readonly observability: ObservabilityService,
  ) {}

  @Post()
  async create(
    @Body() body: { name: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.create(body.name, user.sub);
  }

  @Get()
  async findAll(@CurrentUser() user: JwtPayload) {
    return this.teamsService.findAllForUser(user.sub);
  }

  @Get('active')
  async getActive(@CurrentUser() user: JwtPayload) {
    const teamId = await this.teamsService.getActiveTeamId(user.sub);
    return { teamId };
  }

  @Put('active')
  async setActive(
    @Body() body: { teamId: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.setActiveTeam(user.sub, body.teamId);
  }

  @Get('invites')
  async myInvites(@CurrentUser() user: JwtPayload) {
    return this.teamsService.listPendingInvites(user.sub);
  }

  @Post('invites/:id/accept')
  async acceptInvite(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.acceptInvite(id, user.sub);
  }

  @Post('invites/:id/decline')
  async declineInvite(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.declineInvite(id, user.sub);
  }

  @Patch(':id')
  async updateTeam(
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @Body() body: { name: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.teamsService.updateTeamName(id, user.sub, body.name);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_UPDATED',
        resourceType: 'team',
        resourceId: id,
        severity: 'MEDIUM',
        success: true,
        latencyMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_UPDATED',
        resourceType: 'team',
        resourceId: id,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  @Get(':id/members')
  async listMembers(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.listMembers(id, user.sub);
  }

  @Get(':id/invites')
  async listTeamInvites(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.listTeamInvites(id, user.sub);
  }

  @Post(':id/invites')
  async sendInvite(
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @Body() body: { usernameOrEmail: string },
    @CurrentUser() user: JwtPayload,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.teamsService.sendInvite(id, user.sub, body.usernameOrEmail);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_INVITE_SENT',
        resourceType: 'team',
        resourceId: id,
        severity: 'MEDIUM',
        success: true,
        latencyMs: Date.now() - startedAt,
        metadataJson: { usernameOrEmail: body.usernameOrEmail },
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_INVITE_SENT',
        resourceType: 'team',
        resourceId: id,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  @Delete(':id/invites/:inviteId')
  async cancelInvite(
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.teamsService.cancelInvite(id, inviteId, user.sub);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_INVITE_CANCELLED',
        resourceType: 'team',
        resourceId: id,
        severity: 'MEDIUM',
        success: true,
        latencyMs: Date.now() - startedAt,
        metadataJson: { inviteId },
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_INVITE_CANCELLED',
        resourceType: 'team',
        resourceId: id,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
        metadataJson: { inviteId },
      });
      throw err;
    }
  }

  @Post(':id/invites/:inviteId/reinvite')
  async reInvite(
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.teamsService.reInvite(id, inviteId, user.sub);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_REINVITE_SENT',
        resourceType: 'team',
        resourceId: id,
        severity: 'LOW',
        success: true,
        latencyMs: Date.now() - startedAt,
        metadataJson: { inviteId },
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_REINVITE_SENT',
        resourceType: 'team',
        resourceId: id,
        severity: 'MEDIUM',
        success: false,
        latencyMs: Date.now() - startedAt,
        metadataJson: { inviteId },
      });
      throw err;
    }
  }

  @Patch(':id/members/:userId/role')
  async updateMemberRole(
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @Body() body: { role: 'ADMIN' | 'MEMBER' },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.updateMemberRole(id, user.sub, targetUserId, body.role);
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.teamsService.removeMember(id, user.sub, userId);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_MEMBER_REMOVED',
        resourceType: 'team',
        resourceId: id,
        severity: 'HIGH',
        success: true,
        latencyMs: Date.now() - startedAt,
        metadataJson: { targetUserId: userId },
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_MEMBER_REMOVED',
        resourceType: 'team',
        resourceId: id,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
        metadataJson: { targetUserId: userId },
      });
      throw err;
    }
  }

  @Post(':id/transfer-ownership')
  async transferOwnership(
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @Body('userId') newOwnerId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.teamsService.transferOwnership(id, user.sub, newOwnerId);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_OWNERSHIP_TRANSFERRED',
        resourceType: 'team',
        resourceId: id,
        severity: 'CRITICAL',
        success: true,
        latencyMs: Date.now() - startedAt,
        metadataJson: { newOwnerId },
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_OWNERSHIP_TRANSFERRED',
        resourceType: 'team',
        resourceId: id,
        severity: 'CRITICAL',
        success: false,
        latencyMs: Date.now() - startedAt,
        metadataJson: { newOwnerId },
      });
      throw err;
    }
  }

  @Get(':id/role-permissions')
  async getRolePermissions(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.getRolePermissions(id, user.sub);
  }

  @Put(':id/role-permissions/:role')
  async updateRolePermissions(
    @Param('id') id: string,
    @Param('role') role: 'ADMIN' | 'MEMBER',
    @Body() body: {
      canRenameTeam?: boolean;
      canInviteMembers?: boolean;
      canRemoveMembers?: boolean;
      canManageIntegrations?: boolean;
    },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.updateRolePermissions(id, user.sub, role, body);
  }

  @Delete(':id')
  async deleteTeam(
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.teamsService.deleteTeam(id, user.sub);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_DELETED_BY_OWNER',
        resourceType: 'team',
        resourceId: id,
        severity: 'CRITICAL',
        success: true,
        latencyMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_DELETED_BY_OWNER',
        resourceType: 'team',
        resourceId: id,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }
}
