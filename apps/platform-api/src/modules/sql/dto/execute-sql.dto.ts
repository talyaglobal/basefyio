import { IsNotEmpty, IsString, IsUUID } from 'class-validator';

export class ExecuteSqlDto {
  @IsUUID()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  query!: string;
}
