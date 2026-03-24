import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class ConnectGitHubDto {
  @IsString()
  @IsNotEmpty()
  token!: string;

  @IsString()
  @IsNotEmpty()
  owner!: string;

  @IsString()
  @IsNotEmpty()
  repo!: string;

  @IsString()
  @IsOptional()
  branch?: string;
}
