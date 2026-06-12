import { IsInt, IsOptional, IsString, Min } from 'class-validator';

export class InitiateFileUploadDto {
  @IsString()
  filename: string;

  @IsInt()
  @Min(1)
  sizeBytes: number;

  @IsOptional()
  @IsString()
  contentType?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  chunkSize?: number;
}
