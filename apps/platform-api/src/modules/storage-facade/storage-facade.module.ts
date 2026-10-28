import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { StorageModule } from '../storage/storage.module';
import { ProjectDbModule } from '../project-db/project-db.module';
import { StorageCatalogBackfillService } from './storage-catalog-backfill.service';
import { StorageCatalogController } from './storage-catalog.controller';

/**
 * The Supabase Storage API (`/api/storage/v1/*`) over the platform's object
 * store, so `@supabase/storage-js` and supabase-js work unchanged, plus the
 * operator routes for the catalog it authorises against.
 */
@Module({
  imports: [PrismaModule, BillingModule, StorageModule, ProjectDbModule],
  controllers: [StorageCatalogController],
  providers: [StorageCatalogBackfillService],
})
export class StorageFacadeModule {}
