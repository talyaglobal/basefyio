import { IsArray, IsNotEmpty, IsString } from 'class-validator';

export class ExecuteAggregationDto {
  @IsString()
  @IsNotEmpty()
  entity!: string;

  /** Untrusted pipeline JSON — validated by validateAggregation() in the service. */
  @IsArray()
  pipeline!: unknown[];
}
