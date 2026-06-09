import {
  IsString,
  IsOptional,
  IsIn,
  MaxLength,
  MinLength,
  Matches,
} from 'class-validator';

export class CreateAgentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(256)
  @Matches(/^[a-z0-9][a-z0-9-]{0,254}$/, {
    message: 'slug must be lowercase alphanumeric with hyphens',
  })
  slug!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['draft', 'active'])
  status?: 'draft' | 'active';
}
