import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { OrganizationsService, ORGANIZATION_KINDS } from './organizations.service';
import { CreateOrganizationDto, UpdateOrganizationDto } from './dto/create-organization.dto';

/**
 * Organizations by public id. Every route delegates to the teams service,
 * so the rules stay where they always were; `/teams/*` is untouched for the
 * SDK and the CLI.
 */
@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  list(@CurrentUser() user: JwtPayload) {
    return this.organizations.listForUser(user.sub);
  }

  @Get('kinds')
  kinds() {
    return ORGANIZATION_KINDS;
  }

  @Post()
  create(@Body() body: CreateOrganizationDto, @CurrentUser() user: JwtPayload) {
    return this.organizations.create(user.sub, body);
  }

  @Get(':id')
  overview(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.organizations.overview(id, user.sub);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateOrganizationDto, @CurrentUser() user: JwtPayload) {
    return this.organizations.update(id, user.sub, body);
  }

  @Post(':id/switch')
  switchTo(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.organizations.switchTo(id, user.sub);
  }

  @Get(':id/projects')
  projects(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.organizations.projects(id, user.sub);
  }

  @Get(':id/members')
  members(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.organizations.members(id, user.sub);
  }

  @Get(':id/invites')
  invites(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.organizations.invites(id, user.sub);
  }

  @Get(':id/billing')
  billing(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.organizations.billingOverview(id, user.sub);
  }
}
