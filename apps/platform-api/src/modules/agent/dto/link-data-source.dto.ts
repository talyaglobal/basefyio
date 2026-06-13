import { IsIn, IsOptional, IsString } from 'class-validator';

export class LinkDataSourceDto {
  @IsString()
  dataStructureId: string;

  @IsOptional()
  @IsIn(['read', 'write'])
  access?: 'read' | 'write';
}
