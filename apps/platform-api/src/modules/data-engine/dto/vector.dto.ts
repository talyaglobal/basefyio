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
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Widest vector the Data Engine stores. */
export const MAX_VECTOR_DIMENSIONS = 2048;
/** Most vectors in one batch write. */
export const MAX_VECTOR_BATCH = 100;
/** Most hits one search returns. */
export const MAX_VECTOR_SEARCH_LIMIT = 100;

/** Body of PUT entities/:entity/vector-config. */
export class SetVectorConfigDto {
  /** Stage 1: the client sends its own vectors. */
  @IsIn(['client'])
  mode!: 'client';

  @IsInt()
  @Min(1)
  @Max(MAX_VECTOR_DIMENSIONS)
  dimensions!: number;
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

/** Body of POST data/:entity/search. */
export class VectorSearchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_VECTOR_DIMENSIONS)
  @IsNumber({ allowNaN: false, allowInfinity: false }, { each: true })
  vector!: number[];

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
