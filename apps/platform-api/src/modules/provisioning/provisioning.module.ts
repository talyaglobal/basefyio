import { Module } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningExecutorService } from './provisioning-executor.service';
import { ProvisioningController } from './provisioning.controller';
import { NoopProvisioningProvider } from './providers/noop-provisioning.provider';
import { PROVISIONING_PROVIDER } from './interfaces/provisioning-provider.interface';

@Module({
  providers: [
    ProvisioningService,
    ProvisioningExecutorService,
    { provide: PROVISIONING_PROVIDER, useClass: NoopProvisioningProvider },
  ],
  controllers: [ProvisioningController],
  exports: [ProvisioningService, ProvisioningExecutorService],
})
export class ProvisioningModule {}
