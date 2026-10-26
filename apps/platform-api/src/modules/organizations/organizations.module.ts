import { Module } from '@nestjs/common';
import { TeamsModule } from '../teams/teams.module';
import { BillingModule } from '../billing/billing.module';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsService } from './organizations.service';
import { OrganizationsCoreModule } from './organizations-core.module';

@Module({
  imports: [TeamsModule, BillingModule, OrganizationsCoreModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
