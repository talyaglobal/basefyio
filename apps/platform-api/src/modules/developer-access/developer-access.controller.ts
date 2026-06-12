import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { DeveloperAccessService } from './developer-access.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';

@Controller('v1/projects/:projectId')
@UseGuards(JwtOrApiKeyGuard)
export class DeveloperAccessController {
  constructor(private readonly service: DeveloperAccessService) {}

  @Get('access')
  async getAccessInfo(
    @Param('projectId') projectId: string,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getAccessInfo(projectId, user.sub);
  }
}
