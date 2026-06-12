import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateThreadDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  title?: string;

  @IsOptional()
  metadata?: Record<string, unknown>;
}
