import { ArrayMaxSize, IsArray, IsBoolean, IsString, Matches, MaxLength, ValidateIf } from 'class-validator';

/**
 * Like @IsOptional, but only an absent field is skipped: an explicit null is
 * validated, and so refused with 400 instead of reaching Prisma as null (500).
 */
const OptionalNotNull = () => ValidateIf((_o: unknown, value: unknown) => value !== undefined);

/**
 * A tour id is a stable page key such as `projects` or `project-sql`; a `.v2`
 * suffix shows a redesigned tour again. There is no server-side allow-list, so
 * a new tour never gets a 400 during a rolling deploy.
 */
export const TOUR_ID_PATTERN = /^[a-z0-9]+(?:[-.][a-z0-9]+)*$/;
export const TOUR_ID_MAX_LENGTH = 64;
/** Most ids one request may mark as seen. */
export const TOUR_MARK_BATCH_MAX = 20;
/** Soft cap on the ids stored per user; ids over it are dropped silently. */
export const TOURS_SEEN_MAX = 200;

export class UpdateTourPreferencesDto {
  /** false = "Don't show again": no tour starts by itself on any page. */
  @OptionalNotNull()
  @IsBoolean()
  autoEnabled?: boolean;

  /** Tour ids to add to the seen list (appended, never replaced). */
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(TOUR_MARK_BATCH_MAX)
  @IsString({ each: true })
  @MaxLength(TOUR_ID_MAX_LENGTH, { each: true })
  @Matches(TOUR_ID_PATTERN, { each: true, message: 'A tour id uses lowercase letters, digits, "-" and "."' })
  markSeen?: string[];

  /** Clear the seen list before markSeen is applied ("Show tours again"). */
  @OptionalNotNull()
  @IsBoolean()
  resetSeen?: boolean;
}
