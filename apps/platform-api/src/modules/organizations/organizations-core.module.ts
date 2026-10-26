import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { OrganizationsCoreService } from './organizations-core.service';

/**
 * The part of organizations that sign-up needs. Kept apart from the facade
 * module because AuthModule cannot import TeamsModule (TeamsModule imports
 * AuthModule); this module depends on Prisma and billing only.
 */
@Module({
  imports: [BillingModule],
  providers: [OrganizationsCoreService],
  exports: [OrganizationsCoreService],
})
export class OrganizationsCoreModule {}
