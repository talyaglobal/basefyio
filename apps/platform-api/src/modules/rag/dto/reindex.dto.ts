import { IsOptional, IsString, IsBoolean } from 'class-validator';

export class ReindexDto {
  /** When set, reindex only this document; otherwise the whole project. */
  @IsOptional()
  @IsString()
  documentId?: string;

  /** Force reindex of already-INDEXED documents (default false). */
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
