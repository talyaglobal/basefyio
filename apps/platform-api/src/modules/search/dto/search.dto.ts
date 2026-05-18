import {
  IsString,
  MinLength,
  MaxLength,
  IsOptional,
  IsUUID,
  IsArray,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { EntityType } from '../../embedding/types';

export class SearchQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(500)
  q!: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  teamId?: string;

  @IsOptional()
  @IsArray()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  entityTypes?: EntityType[];

  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export interface SearchResult {
  entityType: EntityType;
  entityId: string;
  projectId: string | null;
  teamId: string | null;
  score: number;
  /** The indexed text snippet for display. */
  text: string | null;
  meta: Record<string, unknown> | null;
}
