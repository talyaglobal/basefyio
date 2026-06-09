import { Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsNumber,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import {
  RAG_DEFAULT_SEARCH_LIMIT,
  RAG_DEFAULT_SEARCH_THRESHOLD,
} from '../rag.constants';

export class RagSearchQuery {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  q!: string;

  /** Result count — bounded 1–25 (validation requirement). */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number = RAG_DEFAULT_SEARCH_LIMIT;

  /** Max cosine distance — bounded 0–1 (validation requirement). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  threshold?: number = RAG_DEFAULT_SEARCH_THRESHOLD;
}
