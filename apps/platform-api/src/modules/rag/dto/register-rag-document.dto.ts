import {
  IsString,
  IsOptional,
  MaxLength,
  Matches,
  IsIn,
  IsInt,
  Min,
  Max,
} from 'class-validator';

/**
 * Register a source object (from the existing MinIO bucket system) as a RAG
 * document. No file upload here — the object must already exist in a bucket;
 * this only records the (bucketName, objectKey) pointer and chunking params.
 */
export class RegisterRagDocumentDto {
  /** Logical bucket name within the project (not the physical MinIO name). */
  @IsString()
  @MaxLength(63)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{1,61}[A-Za-z0-9]$/, {
    message: 'bucketName must be 3-63 chars, alphanumeric and hyphens',
  })
  bucketName!: string;

  @IsString()
  @MaxLength(1024)
  objectKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  title?: string;

  @IsOptional()
  @IsIn(['word', 'sentence', 'context'])
  granularity?: 'word' | 'sentence' | 'context';

  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(8000)
  chunkSize?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(4000)
  chunkOverlap?: number;
}
