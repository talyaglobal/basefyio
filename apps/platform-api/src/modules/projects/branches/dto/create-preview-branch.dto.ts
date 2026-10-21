import { IsIn, IsOptional, IsString, Matches } from 'class-validator';

export const BRANCH_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;

export class CreatePreviewBranchDto {
  /** Short label, unique per parent project — e.g. "pr-42" or "staging". */
  @IsString()
  @Matches(BRANCH_NAME_PATTERN, {
    message:
      'Branch name must be 2-40 characters of lowercase letters, digits and hyphens, starting and ending with a letter or digit',
  })
  name!: string;

  /** "schema" copies tables, functions and policies only; "full" also copies every row. Defaults to "schema". */
  @IsOptional()
  @IsIn(['schema', 'full'])
  dataMode?: 'schema' | 'full';
}
