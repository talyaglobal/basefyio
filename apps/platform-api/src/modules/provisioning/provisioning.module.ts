import { Module } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningExecutorService } from './provisioning-executor.service';
import { ProvisioningResourceProjectionService } from './provisioning-resource-projection.service';
import { ProvisioningPlannerService } from './provisioning-planner.service';
import { ProvisioningController } from './provisioning.controller';
import { NoopProvisioningProvider } from './providers/noop-provisioning.provider';
import { HetznerProvisioningProvider } from './providers/hetzner-provisioning.provider';
import { NoopSecretResolver } from './providers/noop-secret-resolver';
import { MockHetznerTokenResolver } from './providers/mock-hetzner-token-resolver';
import { ProviderRegistry } from './providers/provider-registry.service';
import { PROVIDER_REGISTRY, IProviderRegistry } from './interfaces/provider-registry.interface';
import { HETZNER_TOKEN_RESOLVER } from './interfaces/hetzner-token-resolver.interface';
import { SECRET_RESOLVER } from './interfaces/secret-resolver.interface';

@Module({
  providers: [
    ProvisioningService,
    ProvisioningResourceProjectionService,
    ProvisioningPlannerService,
    ProvisioningExecutorService,
    NoopProvisioningProvider,
    HetznerProvisioningProvider,
    {
      provide: SECRET_RESOLVER,
      useClass: NoopSecretResolver,
    },
    {
      // Phase 9a placeholder — Phase 9c replaces with OpenBaoHetznerTokenResolver + config
      provide: HETZNER_TOKEN_RESOLVER,
      useFactory: (): MockHetznerTokenResolver => new MockHetznerTokenResolver(
        process.env.HETZNER_API_TOKEN ?? 'dev-placeholder-token',
      ),
    },
    {
      provide: PROVIDER_REGISTRY,
      useFactory: (
        noop: NoopProvisioningProvider,
        hetzner: HetznerProvisioningProvider,
      ): IProviderRegistry => {
        const registry = new ProviderRegistry();
        registry.register('noop', noop);
        registry.register('hetzner', hetzner);
        return registry;
      },
      inject: [NoopProvisioningProvider, HetznerProvisioningProvider],
    },
  ],
  controllers: [ProvisioningController],
  exports: [ProvisioningService, ProvisioningExecutorService],
})
export class ProvisioningModule {}
