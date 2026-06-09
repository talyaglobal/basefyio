import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateAgentVersionDto {
  @IsString()
  systemPrompt!: string;

  @IsString()
  @MaxLength(128)
  model!: string;

  @IsOptional()
  @IsIn(['openai', 'nebius-private', 'ollama'])
  provider?: 'openai' | 'nebius-private' | 'ollama';

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(128000)
  maxTokens?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  maxSteps?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  toolIds?: string[];

  @IsOptional()
  modelConfig?: Record<string, unknown>;
}
