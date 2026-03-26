import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class ConnectVercelDto {
  @IsString()
  @IsOptional()
  token?: string;

  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsOptional()
  teamId?: string;

  @IsBoolean()
  @IsOptional()
  useTeamToken?: boolean;

  @IsString()
  @IsOptional()
  sourceTeamId?: string;
}
