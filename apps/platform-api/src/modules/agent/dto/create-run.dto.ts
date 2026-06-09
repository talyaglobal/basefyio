import { IsString, IsOptional, IsBoolean } from 'class-validator';

export class CreateRunDto {
  @IsOptional()
  @IsString()
  message?: string;

  @IsOptional()
  @IsString()
  threadId?: string;

  /** When true (default), create a new thread if threadId is not provided. */
  @IsOptional()
  @IsBoolean()
  createThread?: boolean;

  @IsOptional()
  @IsString()
  threadTitle?: string;

  /**
   * Opt-in to mutating tools for this run. Default false — the policy
   * gateway will deny mutating tool calls unless this is set.
   */
  @IsOptional()
  @IsBoolean()
  allowMutating?: boolean;
}
