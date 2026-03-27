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
} from '@nestjs/common';
import { TeamsService } from './teams.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

@Controller('teams')
@UseGuards(JwtAuthGuard)
export class TeamsController {
  constructor(private readonly teamsService: TeamsService) {}

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
    @Param('id') id: string,
    @Body() body: { name: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.updateTeamName(id, user.sub, body.name);
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
    @Param('id') id: string,
    @Body() body: { usernameOrEmail: string },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.sendInvite(id, user.sub, body.usernameOrEmail);
  }

  @Delete(':id/invites/:inviteId')
  async cancelInvite(
    @Param('id') id: string,
    @Param('inviteId') inviteId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.cancelInvite(id, inviteId, user.sub);
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.teamsService.removeMember(id, user.sub, userId);
  }
}
