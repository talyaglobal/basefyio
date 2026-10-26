import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsBoolean, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { RequireManagementPermission } from '../../common/decorators/management-permission.decorator';
import { CurrentUser, JwtPayload } from '../../common/decorators/current-user.decorator';
import { FeatureFlagsService } from './feature-flags.service';

export class SetFeatureFlagDto {
  @IsString()
  @MaxLength(64)
  name!: string;

  @IsBoolean()
  enabled!: boolean;
}

export class SetFeatureFlagUsersDto {
  @IsString()
  @MaxLength(64)
  name!: string;

  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  userIds!: string[];
}

@Controller('features')
export class FeaturesController {
  constructor(private readonly flags: FeatureFlagsService) {}

  /** Public: a map of flag → boolean, nothing else. The website and anonymous pages read it. */
  @Get()
  all() {
    return this.flags.all();
  }

  /** Signed in: the same map, with the flags that are on for this user ahead of everyone. The dashboard reads this. */
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: JwtPayload) {
    return this.flags.forUser(user.sub);
  }

  /** Root console: every flag and the users it is on for. */
  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageTeams')
  @Get('management')
  management() {
    return this.flags.management();
  }

  /** Root console: flip one flag for everyone. Visible everywhere within 30 s, no deploy. */
  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageTeams')
  @Patch('management')
  set(@Body() body: SetFeatureFlagDto) {
    return this.flags.set(body.name, body.enabled);
  }

  /** Root console: the users a flag is on for before everyone (replace the list). */
  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageTeams')
  @Patch('management/users')
  setUsers(@Body() body: SetFeatureFlagUsersDto) {
    return this.flags.setUsers(body.name, body.userIds);
  }
}
