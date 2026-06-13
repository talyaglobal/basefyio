import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class GatewayQueryDto {
  @IsString()
  @IsNotEmpty()
  certId: string;

  @IsString()
  @IsNotEmpty()
  sql: string;

  @IsOptional()
  @IsArray()
  params?: unknown[];
}
