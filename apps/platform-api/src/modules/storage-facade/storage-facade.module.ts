import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { StorageModule } from '../storage/storage.module';
import { ProjectDbModule } from '../project-db/project-db.module';
import { ProjectWakeService } from './project-wake.service';
import { StorageCatalogBackfillService } from './storage-catalog-backfill.service';
import { StorageCatalogController } from './storage-catalog.controller';
import { StorageFacadeService } from './storage-facade.service';
import { StorageSigningService } from './storage-signing.service';
import { StorageV1Controller } from './storage-v1.controller';
import { StorageV1PublicController } from './storage-v1-public.controller';

/**
 * The Supabase Storage API (`/api/storage/v1/*`) over the platform's object
 * store, so `@supabase/storage-js` and supabase-js work unchanged, plus the
 * operator routes for the catalog it authorises against.
 *
 * Controller order matters: the public controller's literal routes
 * (`object/public/…`, `object/sign/…`, `object/upload/sign/…`) must be
 * registered before the keyed controller's `object/:bucket/*`.
 */
@Module({
  imports: [PrismaModule, StorageModule, ProjectDbModule],
  controllers: [StorageV1PublicController, StorageV1Controller, StorageCatalogController],
  providers: [StorageFacadeService, StorageSigningService, ProjectWakeService, StorageCatalogBackfillService],
})
export class StorageFacadeModule {}
