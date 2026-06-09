import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdateAgentDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsIn(['draft', 'active', 'archived'])
  status?: 'draft' | 'active' | 'archived';
}
