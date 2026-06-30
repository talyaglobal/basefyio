import { Module } from '@nestjs/common';
import { SqlController } from './sql.controller';
import { SqlService } from './sql.service';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectActivityModule } from '../projects/project-activity.module';

@Module({
  imports: [ProjectsModule, ProjectActivityModule],
  controllers: [SqlController],
  providers: [SqlService],
})
export class SqlModule {}
