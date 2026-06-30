import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { RealmReferenceRepairService } from './realm-reference-repair.service';
import { ProjectDataController } from './project-data.controller';
import { ProjectDatabaseController } from './project-database.controller';
import { ProjectDatabaseService } from './project-database.service';
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
import { ExportProcessor } from '../queue/export.processor';
import { AuthModule } from '../auth/auth.module';
import { InfrastructureModule } from '../infrastructure/infrastructure.module';
import { StorageModule } from '../storage/storage.module';
import { FoldersController, TagsController } from './folders-tags.controller';
import { FoldersTagsService } from './folders-tags.service';
import { ProjectActivityModule } from './project-activity.module';
import { ProjectExportService } from './project-export.service';
import { ProjectArchiveImportService } from './project-archive-import.service';
import { CollectionController } from './collection.controller';
import { CollectionService } from './collection.service';
import { PublicCollectionApiController } from './public-collection-api.controller';
import { PublicCollectionApiService } from './public-collection-api.service';

@Module({
  imports: [
    AuthModule,
    InfrastructureModule,
    HttpModule.register({ timeout: 60000 }),
    StorageModule,
    ProjectActivityModule,
  ],
  controllers: [
    ProjectsController,
    ProjectDataController,
    ProjectDatabaseController,
    ProjectAuthController,
    ProjectSdkAuthController,
    PublicApiController,
    CollectionController,
    PublicCollectionApiController,
    FoldersController,
    TagsController,
  ],
  providers: [
    ProjectDatabaseService,
    ProjectsService,
    ProjectDataService,
    ProjectAuthConfigService,
    ProjectSdkAuthService,
    PublicApiService,
    CollectionService,
    PublicCollectionApiService,
    SupabaseImportService,
    ProjectExportService,
    ProjectArchiveImportService,
    ImportProcessor,
    ExportProcessor,
    EmailProcessor,
    FoldersTagsService,
    RealmReferenceRepairService,
  ],
  exports: [ProjectsService, CollectionService],
})
export class ProjectsModule {}
