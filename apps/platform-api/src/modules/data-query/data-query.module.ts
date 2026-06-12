import { Module } from '@nestjs/common';
import { DataQueryController } from './data-query.controller';
import { DataQueryService } from './data-query.service';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectActivityModule } from '../projects/project-activity.module';

// DataEngineService comes from the global DataEngineModule;
// PrismaService comes from the global PrismaModule.
@Module({
  imports: [ProjectsModule, ProjectActivityModule],
  controllers: [DataQueryController],
  providers: [DataQueryService],
})
export class DataQueryModule {}
