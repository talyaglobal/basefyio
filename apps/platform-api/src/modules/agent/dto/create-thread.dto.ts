import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateThreadDto {
  @IsOptional()
  @IsString()
  @MaxLength(512)
  title?: string;

  /** Owning agent — optional until Module 3 (Agent Creation) lands. */
  @IsOptional()
  @IsString()
  agentId?: string;

  @IsOptional()
  metadata?: Record<string, unknown>;
}
