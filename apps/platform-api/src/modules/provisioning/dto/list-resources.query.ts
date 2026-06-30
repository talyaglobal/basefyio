import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { Transform } from 'class-transformer';

export class ListResourcesQuery {
  /** Platform project ID — required. */
  @IsUUID()
  projectId: string;

  /**
   * When true, include resources where destroyedAt is set.
   * Default false — destroyed resources are excluded from the list.
   */
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === 'true' || value === true)
  includeDestroyed?: boolean;
}
