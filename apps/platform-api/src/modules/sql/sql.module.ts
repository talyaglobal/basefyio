import { Module } from '@nestjs/common';
import { SqlController } from './sql.controller';
import { SqlService } from './sql.service';
import { ProjectsModule } from '../projects/projects.module';

@Module({
  imports: [ProjectsModule],
  controllers: [SqlController],
  providers: [SqlService],
})
export class SqlModule {}
