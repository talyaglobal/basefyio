import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class ConnectGitHubDto {
  @IsString()
  @IsOptional()
  token?: string;

  @IsString()
  @IsNotEmpty()
  owner!: string;

  @IsString()
  @IsNotEmpty()
  repo!: string;

  @IsString()
  @IsOptional()
  branch?: string;

  @IsBoolean()
  @IsOptional()
  useTeamToken?: boolean;

  @IsString()
  @IsOptional()
  teamId?: string;
}
