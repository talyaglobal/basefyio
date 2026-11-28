import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Widest vector the Data Engine stores. */
export const MAX_VECTOR_DIMENSIONS = 2048;
/** Most vectors in one batch write. */
export const MAX_VECTOR_BATCH = 100;
/** Most hits one search returns. */
export const MAX_VECTOR_SEARCH_LIMIT = 100;
/** Longest text query a search embeds. */
export const MAX_VECTOR_QUERY_LENGTH = 8000;

/**
 * Body of PUT entities/:entity/vector-config.
 *  - client: the caller sends its own vectors of `dimensions` width.
 *  - platform: the platform embeds the text at `sourcePaths` (1..8 dot paths
 *    under the record's data, checked in the controller); the width comes
 *    from the project's embedding model.
 */
export class SetVectorConfigDto {
  @IsIn(['client', 'platform'])
  mode!: 'client' | 'platform';

  @ValidateIf((o) => o.mode === 'client' || o.dimensions !== undefined)
  @IsInt()
  @Min(1)
  @Max(MAX_VECTOR_DIMENSIONS)
  dimensions?: number;

  @ValidateIf((o) => o.mode === 'platform' || o.sourcePaths !== undefined)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  sourcePaths?: string[];
}

/** Body of PUT data/:entity/:id/vector. */
export class SetVectorDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VECTOR_DIMENSIONS)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  vector!: number[];
}

export class VectorItemDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VECTOR_DIMENSIONS)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  vector!: number[];
}

/** Body of POST data/:entity/vectors. */
export class SetVectorsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VECTOR_BATCH)
  @ValidateNested({ each: true })
  @Type(() => VectorItemDto)
  items!: VectorItemDto[];
}

/** Body of POST data/:entity/search: exactly one of `vector` or `query`. */
export class VectorSearchDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VECTOR_DIMENSIONS)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  vector?: number[];

  /** Text to search for (platform-mode entities): embedded with the entity's model. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_VECTOR_QUERY_LENGTH)
  query?: string;

  /** Same grammar as the list route's `filter` parameter. */
  @IsOptional()
  @IsObject()
  filter?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_VECTOR_SEARCH_LIMIT)
  limit?: number;

  /** Maximum cosine distance, 0..2 (default 0.5). */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(2)
  threshold?: number;
}
