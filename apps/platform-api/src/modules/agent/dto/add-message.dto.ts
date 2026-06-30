import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class AddMessageDto {
  @IsIn(['system', 'user', 'assistant', 'tool'])
  role!: 'system' | 'user' | 'assistant' | 'tool';

  @IsString()
  @IsNotEmpty()
  content!: string;

  @IsOptional()
  metadata?: { toolName?: string; toolCallId?: string; [k: string]: unknown };
}
