import { Module } from '@nestjs/common';
import { DataQueryController } from './data-query.controller';
import { DataViewsController } from './data-views.controller';
import { DataQueryService } from './data-query.service';
import { ProjectsModule } from '../projects/projects.module';
import { ProjectActivityModule } from '../projects/project-activity.module';

// DataEngineService comes from the global DataEngineModule;
// PrismaService comes from the global PrismaModule.
@Module({
  imports: [ProjectsModule, ProjectActivityModule],
  controllers: [DataQueryController, DataViewsController],
  providers: [DataQueryService],
})
export class DataQueryModule {}
