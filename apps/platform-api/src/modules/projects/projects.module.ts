import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectDataController } from './project-data.controller';
import { ProjectDataService } from './project-data.service';
import { ProjectAuthController } from './project-auth.controller';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [ProjectsController, ProjectDataController, ProjectAuthController],
  providers: [ProjectsService, ProjectDataService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
