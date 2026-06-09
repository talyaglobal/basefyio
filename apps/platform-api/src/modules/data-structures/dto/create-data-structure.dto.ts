import { IsEnum, IsString, MaxLength, MinLength } from 'class-validator';

export enum DataStructureKindDto {
  RELATIONAL = 'relational',
  JSON = 'json',
}

export class CreateDataStructureDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name: string;

  @IsEnum(DataStructureKindDto)
  kind: DataStructureKindDto;
}
