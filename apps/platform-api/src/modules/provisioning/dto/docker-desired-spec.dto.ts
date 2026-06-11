import { IsString, IsOptional, IsArray, IsObject, ValidateNested, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class DockerPortMapping {
  @IsInt()
  @Min(1)
  @Max(65535)
  host!: number;

  @IsInt()
  @Min(1)
  @Max(65535)
  container!: number;
}

export class DockerDesiredSpec {
  @IsString()
  image!: string;

  @IsOptional()
  @IsString()
  containerName?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DockerPortMapping)
  ports?: DockerPortMapping[];

  @IsOptional()
  @IsObject()
  env?: Record<string, string>;

  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;
}
