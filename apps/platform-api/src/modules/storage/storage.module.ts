import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { ImageTransformService } from './image-transform.service';
import { UploadSpoolSweeper } from './upload-spool';
import { StorageAccessService } from './storage-access.service';
import { StoragePolicyController } from './storage-policy.controller';
import { UploadSessionService } from './upload-session.service';
import { UploadSessionController } from './upload-session.controller';
import { StorageCatalogService } from './storage-catalog.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { ProjectActivityModule } from '../projects/project-activity.module';
import { ProjectDbModule } from '../project-db/project-db.module';

@Module({
  imports: [PrismaModule, BillingModule, ProjectActivityModule, ProjectDbModule],
  controllers: [StorageController, StoragePolicyController, UploadSessionController],
  providers: [
    StorageService,
    ImageTransformService,
    UploadSpoolSweeper,
    StorageAccessService,
    StorageCatalogService,
    UploadSessionService,
  ],
  // The Supabase-compatible facade (storage-facade) builds on these.
  exports: [StorageService, StorageAccessService, ImageTransformService, StorageCatalogService],
})
export class StorageModule {}
