import { IsString, IsOptional, IsIn, IsObject } from 'class-validator';

export const HETZNER_REGIONS = ['eu-central', 'us-east', 'ap-southeast'] as const;
export type HetznerRegion = typeof HETZNER_REGIONS[number];

export const HETZNER_SERVER_TYPES = ['cx11', 'cx21', 'cx31', 'cx41', 'cx51', 'ccx11', 'ccx21', 'ccx31'] as const;

export class HetznerDesiredSpec {
  @IsOptional()
  @IsIn([...HETZNER_REGIONS])
  region?: HetznerRegion;

  @IsOptional()
  @IsIn([...HETZNER_SERVER_TYPES])
  serverType?: string;

  @IsOptional()
  @IsString()
  image?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;
}
