import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { RealmReferenceRepairService } from './realm-reference-repair.service';
import { ProjectDataController } from './project-data.controller';
import { ProjectDatabaseController } from './project-database.controller';
import { ProjectDatabaseService } from './project-database.service';
import { ProjectProvisioningService } from './project-provisioning.service';
import { ProjectReadonlyRoleService } from './project-readonly-role.service';
import { ProjectPoliciesController } from './project-policies.controller';
import { ProjectPoliciesService } from './project-policies.service';
import { ProjectDataService } from './project-data.service';
import { ProjectAuthController } from './project-auth.controller';
import { ProjectAuthConfigService } from './project-auth-config.service';
import { ProjectSdkAuthController } from './project-sdk-auth.controller';
import { ProjectOAuthCallbackController } from './project-oauth-callback.controller';
import { ProjectSdkAuthService } from './project-sdk-auth.service';
import { ProjectMfaService } from './project-mfa.service';
import { ProjectAnonymousAuthService } from './project-anonymous-auth.service';
import { PublicApiController } from './public-api.controller';
import { PublicApiService } from './public-api.service';
import { SupabaseImportService } from './supabase-import.service';
import { SupabaseImportKeysService } from './supabase-import-keys.service';
import { ImportProcessor } from '../queue/import.processor';
import { EmailProcessor } from '../queue/email.processor';
import { ExportProcessor } from '../queue/export.processor';
import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { InfrastructureModule } from '../infrastructure/infrastructure.module';
import { StorageModule } from '../storage/storage.module';
import { FoldersController, TagsController } from './folders-tags.controller';
import { FoldersTagsService } from './folders-tags.service';
import { ProjectActivityModule } from './project-activity.module';
import { ProjectExportService } from './project-export.service';
import { ProjectPitrService } from './project-pitr.service';
import { ProjectArchiveImportService } from './project-archive-import.service';
import { CollectionController } from './collection.controller';
import { CollectionService } from './collection.service';
import { PublicCollectionApiController } from './public-collection-api.controller';
import { PublicCollectionApiService } from './public-collection-api.service';
import { BackupOffsiteService } from './backups/backup-offsite.service';
import { BackupVerificationService } from './backups/backup-verification.service';
import { ProjectBackupsController } from './backups/project-backups.controller';
import { ProjectBranchService } from './branches/project-branch.service';
import { ProjectBranchesController } from './branches/project-branches.controller';

@Module({
  imports: [
    AuthModule,
    BillingModule,
    InfrastructureModule,
    HttpModule.register({ timeout: 60000 }),
    StorageModule,
    ProjectActivityModule,
  ],
  controllers: [
    ProjectsController,
    ProjectDataController,
    ProjectDatabaseController,
    ProjectPoliciesController,
    ProjectAuthController,
    ProjectSdkAuthController,
    ProjectOAuthCallbackController,
    PublicApiController,
    CollectionController,
    PublicCollectionApiController,
    FoldersController,
    TagsController,
    ProjectBackupsController,
    ProjectBranchesController,
  ],
  providers: [
    ProjectDatabaseService,
    ProjectProvisioningService,
    ProjectReadonlyRoleService,
    ProjectPoliciesService,
    ProjectsService,
    ProjectDataService,
    ProjectAuthConfigService,
    ProjectSdkAuthService,
    ProjectMfaService,
    ProjectAnonymousAuthService,
    PublicApiService,
    CollectionService,
    PublicCollectionApiService,
    SupabaseImportService,
    SupabaseImportKeysService,
    ProjectExportService,
    ProjectPitrService,
    ProjectArchiveImportService,
    ImportProcessor,
    ExportProcessor,
    EmailProcessor,
    FoldersTagsService,
    RealmReferenceRepairService,
    BackupOffsiteService,
    BackupVerificationService,
    ProjectBranchService,
  ],
  exports: [ProjectsService, CollectionService],
})
export class ProjectsModule {}
