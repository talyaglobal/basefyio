import { IsArray, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class SheetHeaderDto {
  @IsString()
  sheet!: string;

  @IsArray()
  @IsString({ each: true })
  headers!: string[];

  @IsArray()
  sampleRows!: unknown[][];
}

export class AnalyzeBlueprintDto {
  @IsString()
  teamId!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SheetHeaderDto)
  sheets!: SheetHeaderDto[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  excludeSheets?: string[];
}
