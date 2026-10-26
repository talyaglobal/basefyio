import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { IsBoolean, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { RequireManagementPermission } from '../../common/decorators/management-permission.decorator';
import { FeatureFlagsService } from './feature-flags.service';

export class SetFeatureFlagDto {
  @IsString()
  @MaxLength(64)
  name!: string;

  @IsBoolean()
  enabled!: boolean;
}

@Controller('features')
export class FeaturesController {
  constructor(private readonly flags: FeatureFlagsService) {}

  /** Public: a map of flag → boolean, nothing else. The dashboard reads it on load. */
  @Get()
  all() {
    return this.flags.all();
  }

  /** Root console: flip one flag. Visible everywhere within 30 s, no deploy. */
  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageTeams')
  @Patch('management')
  set(@Body() body: SetFeatureFlagDto) {
    return this.flags.set(body.name, body.enabled);
  }
}
