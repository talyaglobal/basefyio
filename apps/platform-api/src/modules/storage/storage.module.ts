import { Module } from '@nestjs/common';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { ImageTransformService } from './image-transform.service';
import { UploadSpoolSweeper } from './upload-spool';
import { StorageAccessService } from './storage-access.service';
import { StoragePolicyController } from './storage-policy.controller';
import { UploadSessionService } from './upload-session.service';
import { UploadSessionController } from './upload-session.controller';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { ProjectActivityModule } from '../projects/project-activity.module';

@Module({
  imports: [PrismaModule, BillingModule, ProjectActivityModule],
  controllers: [StorageController, StoragePolicyController, UploadSessionController],
  providers: [
    StorageService,
    ImageTransformService,
    UploadSpoolSweeper,
    StorageAccessService,
    UploadSessionService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
