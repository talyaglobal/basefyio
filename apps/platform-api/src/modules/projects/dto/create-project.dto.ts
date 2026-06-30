import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(64)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(256)
  description?: string;

  /** Database model chosen in the New Project wizard. Defaults to RELATIONAL. */
  @IsOptional()
  @IsIn(['RELATIONAL', 'NOSQL'])
  databaseType?: 'RELATIONAL' | 'NOSQL';
}
