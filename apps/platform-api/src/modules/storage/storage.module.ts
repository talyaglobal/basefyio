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
import { S3KeysService } from './s3-keys.service';
import { S3KeysController } from './s3-keys.controller';
import { HttpMinioAdmin, MINIO_ADMIN } from './minio-admin.client';
import { ConfigService } from '@nestjs/config';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { ProjectActivityModule } from '../projects/project-activity.module';
import { ProjectDbModule } from '../project-db/project-db.module';

@Module({
  imports: [PrismaModule, BillingModule, ProjectActivityModule, ProjectDbModule],
  controllers: [StorageController, StoragePolicyController, UploadSessionController, S3KeysController],
  providers: [
    StorageService,
    ImageTransformService,
    UploadSpoolSweeper,
    StorageAccessService,
    StorageCatalogService,
    UploadSessionService,
    S3KeysService,
    {
      // Root credentials, internal endpoint only: the admin API is never called on the public host.
      provide: MINIO_ADMIN,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new HttpMinioAdmin({
          endpoint: `${config.get<boolean>('minio.useSsl') ? 'https' : 'http'}://${config.get<string>('minio.endpoint') || 'localhost'}:${config.get<number>('minio.port') || 9000}`,
          accessKey: config.get<string>('minio.accessKey') || 'kolaybase',
          secretKey: config.get<string>('minio.secretKey') || 'kolaybase_secret',
        }),
    },
  ],
  // The Supabase-compatible facade (storage-facade) builds on these.
  exports: [StorageService, StorageAccessService, ImageTransformService, StorageCatalogService, S3KeysService],
})
export class StorageModule {}
