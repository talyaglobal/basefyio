import { Module } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningController } from './provisioning.controller';

@Module({
  providers: [ProvisioningService],
  controllers: [ProvisioningController],
  exports: [ProvisioningService],
})
export class ProvisioningModule {}
