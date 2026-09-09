import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { RequireManagementPermission } from '../../common/decorators/management-permission.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import {
  CreateCampaignInput,
  MarketingAgencyService,
  PublishCampaignInput,
} from './marketing-agency.service';

/**
 * The in-house marketing agency. Gated behind the same management permission as
 * the rest of the internal tooling: these endpoints spend money on three APIs and
 * can post to a public account, so they are not part of the customer surface.
 */
@Controller('auth/management/marketing-agency')
@UseGuards(JwtAuthGuard, ManagementPermissionGuard)
@RequireManagementPermission('canAccessManagement')
export class MarketingAgencyController {
  constructor(private readonly agency: MarketingAgencyService) {}

  @Get('status')
  status() {
    return this.agency.status();
  }

  @Get('channels')
  channels() {
    return this.agency.listChannels();
  }

  @Get('voices')
  voices() {
    return this.agency.listVoices();
  }

  @Get('campaigns')
  list() {
    return this.agency.listCampaigns();
  }

  @Get('campaigns/:id')
  get(@Param('id') id: string) {
    return this.agency.getCampaign(id);
  }

  @Post('campaigns')
  create(@CurrentUser() user: JwtPayload, @Body() body: CreateCampaignInput) {
    return this.agency.createCampaign(user.sub, body);
  }

  @Post('campaigns/:id/copy')
  rewrite(@Param('id') id: string) {
    return this.agency.writeCopy(id);
  }

  @Patch('campaigns/:id/copy')
  editCopy(
    @Param('id') id: string,
    @Body()
    body: {
      caption?: string;
      hashtags?: string[];
      imagePrompt?: string;
      videoPrompt?: string;
      voiceScript?: string;
    },
  ) {
    return this.agency.updateCopy(id, body);
  }

  @Post('campaigns/:id/image')
  image(@Param('id') id: string) {
    return this.agency.renderImage(id);
  }

  @Post('campaigns/:id/video')
  video(@Param('id') id: string) {
    return this.agency.renderVideo(id);
  }

  @Post('campaigns/:id/voiceover')
  voiceover(@Param('id') id: string, @Body() body: { voiceId?: string }) {
    return this.agency.renderVoiceover(id, body?.voiceId);
  }

  @Post('campaigns/:id/assets/:assetId/select')
  select(@Param('id') id: string, @Param('assetId') assetId: string) {
    return this.agency.selectAsset(id, assetId);
  }

  @Post('campaigns/:id/publish')
  publish(@Param('id') id: string, @Body() body: PublishCampaignInput) {
    return this.agency.publish(id, body);
  }

  @Delete('campaigns/:id')
  remove(@Param('id') id: string) {
    return this.agency.deleteCampaign(id);
  }
}
