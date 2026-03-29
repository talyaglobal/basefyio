import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectDataController } from './project-data.controller';
import { ProjectDataService } from './project-data.service';
import { ProjectAuthController } from './project-auth.controller';
import { ProjectAuthConfigService } from './project-auth-config.service';
import { ProjectSdkAuthController } from './project-sdk-auth.controller';
import { ProjectSdkAuthService } from './project-sdk-auth.service';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';
import { SupabaseImportService } from './supabase-import.service';
import { ImportProcessor } from '../queue/import.processor';
import { EmailProcessor } from '../queue/email.processor';
import { AuthModule } from '../auth/auth.module';
import { StorageModule } from '../storage/storage.module';
import { FoldersController, TagsController } from './folders-tags.controller';
import { FoldersTagsService } from './folders-tags.service';
import { ProjectActivityModule } from './project-activity.module';

@Module({
  imports: [
    AuthModule,
    HttpModule.register({ timeout: 60000 }),
    StorageModule,
    ProjectActivityModule,
  ],
  controllers: [
    ProjectsController,
    ProjectDataController,
    ProjectAuthController,
    ProjectSdkAuthController,
    PublicApiController,
    FoldersController,
    TagsController,
  ],
  providers: [
    ProjectsService,
    ProjectDataService,
    ProjectAuthConfigService,
    ProjectSdkAuthService,
    PublicApiService,
    SupabaseImportService,
    ImportProcessor,
    EmailProcessor,
    FoldersTagsService,
  ],
  exports: [ProjectsService],
})
export class ProjectsModule {}
