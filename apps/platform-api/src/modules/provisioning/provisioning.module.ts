import { Module } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningExecutorService } from './provisioning-executor.service';
import { ProvisioningController } from './provisioning.controller';
import { NoopProvisioningProvider } from './providers/noop-provisioning.provider';
import { NoopSecretResolver } from './providers/noop-secret-resolver';
import { ProviderRegistry } from './providers/provider-registry.service';
import { PROVIDER_REGISTRY, IProviderRegistry } from './interfaces/provider-registry.interface';
import { SECRET_RESOLVER } from './interfaces/secret-resolver.interface';

@Module({
  providers: [
    ProvisioningService,
    ProvisioningExecutorService,
    NoopProvisioningProvider,
    {
      provide: SECRET_RESOLVER,
      useClass: NoopSecretResolver,
    },
    {
      provide: PROVIDER_REGISTRY,
      useFactory: (noop: NoopProvisioningProvider): IProviderRegistry => {
        const registry = new ProviderRegistry();
        registry.register('noop', noop);
        // 'hetzner' wired to NoopProvisioningProvider until the real provider lands
        registry.register('hetzner', noop);
        return registry;
      },
      inject: [NoopProvisioningProvider],
    },
  ],
  controllers: [ProvisioningController],
  exports: [ProvisioningService, ProvisioningExecutorService],
})
export class ProvisioningModule {}
