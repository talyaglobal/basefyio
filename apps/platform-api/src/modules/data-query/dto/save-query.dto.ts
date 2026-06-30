import { IsIn, IsOptional, IsString, Length } from 'class-validator';

export class SaveQueryDto {
  @IsString()
  @Length(1, 64)
  name!: string;

  @IsString()
  @Length(1, 100000)
  source!: string;

  @IsOptional()
  @IsString()
  entity?: string;

  /** Query dialect of `source`: js chain text or an aggregation pipeline JSON. */
  @IsOptional()
  @IsIn(['js', 'aggregation'])
  mode?: 'js' | 'aggregation';
}
