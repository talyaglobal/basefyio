import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class ConnectVercelDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsOptional()
  teamId?: string;
}
