import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectDataController } from './project-data.controller';
import { ProjectDataService } from './project-data.service';
import { ProjectAuthController } from './project-auth.controller';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';
import { SupabaseImportService } from './supabase-import.service';
import { ImportProcessor } from '../queue/import.processor';
import { EmailProcessor } from '../queue/email.processor';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [AuthModule, HttpModule.register({ timeout: 60000 }), StorageModule],
  controllers: [ProjectsController, ProjectDataController, ProjectAuthController, PublicApiController],
  providers: [
    ProjectsService,
    ProjectDataService,
    PublicApiService,
    SupabaseImportService,
    ImportProcessor,
    EmailProcessor,
  ],
  exports: [ProjectsService],
})
export class ProjectsModule {}
