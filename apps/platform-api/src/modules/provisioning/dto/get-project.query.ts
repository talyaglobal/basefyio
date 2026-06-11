import { IsUUID } from 'class-validator';

export class GetProjectQuery {
  @IsUUID()
  projectId: string;
}
