import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  githubUsername?: string;

  @IsOptional()
  @IsString()
  avatarUrl?: string;

  @IsOptional()
  @IsBoolean()
  notifySignIn?: boolean;

  @IsOptional()
  @IsBoolean()
  notifySignInNewDevice?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyTeamInvite?: boolean;

  @IsOptional()
  @IsBoolean()
  notifyBrowserPush?: boolean;

  @IsOptional()
  @IsBoolean()
  allowIdentityEdit?: boolean;
}
