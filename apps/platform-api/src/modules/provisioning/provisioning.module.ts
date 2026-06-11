import { Module } from '@nestjs/common';
import { ProvisioningService } from './provisioning.service';
import { ProvisioningExecutorService } from './provisioning-executor.service';
import { ProvisioningResourceProjectionService } from './provisioning-resource-projection.service';
import { ProvisioningPlannerService } from './provisioning-planner.service';
import { ProvisioningController } from './provisioning.controller';
import { ProvisioningCredentialRefController } from './provisioning-credential-ref.controller';
import { ProvisioningCredentialRefService } from './provisioning-credential-ref.service';
import { NoopProvisioningProvider } from './providers/noop-provisioning.provider';
import { HetznerProvisioningProvider } from './providers/hetzner-provisioning.provider';
import { NoopSecretResolver } from './providers/noop-secret-resolver';
import { MockHetznerTokenResolver } from './providers/mock-hetzner-token-resolver';
import { OpenBaoHetznerTokenResolver } from './providers/openbao-hetzner-token-resolver';
import { HetznerClient } from './providers/hetzner/hetzner.client';
import { MockHetznerClient } from './providers/hetzner/mock-hetzner-client';
import { ProviderRegistry } from './providers/provider-registry.service';
import { PROVIDER_REGISTRY } from './interfaces/provider-registry.interface';
import { PROVIDER_REGISTRY_PROVIDERS } from './provisioning.constants';
import { IHetznerTokenResolver, HETZNER_TOKEN_RESOLVER } from './interfaces/hetzner-token-resolver.interface';
import { HETZNER_CLIENT, IHetznerClient } from './providers/hetzner/hetzner-client.interface';
import { SECRET_RESOLVER } from './interfaces/secret-resolver.interface';

/**
 * Hetzner provider wiring strategy:
 *
 * OPENBAO_URL set  →  OpenBaoHetznerTokenResolver + HetznerClient  (real operations)
 * OPENBAO_URL unset  →  MockHetznerTokenResolver + MockHetznerClient  (dev / CI)
 *
 * OPENBAO_VAULT_TOKEN must be set alongside OPENBAO_URL in production.
 * Phase 9c: OpenBaoHetznerTokenResolver supports KV v1 and v2 secret shapes.
 */

@Module({
  providers: [
    ProvisioningService,
    ProvisioningCredentialRefService,
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
      provide: HETZNER_TOKEN_RESOLVER,
      useFactory: (): IHetznerTokenResolver => {
        const openbaoUrl = process.env.OPENBAO_URL;
        if (openbaoUrl) {
          return new OpenBaoHetznerTokenResolver({
            baseUrl: openbaoUrl,
            vaultToken: process.env.OPENBAO_VAULT_TOKEN ?? '',
          });
        }
        return new MockHetznerTokenResolver(
          process.env.HETZNER_API_TOKEN ?? 'dev-placeholder-token',
        );
      },
    },
    {
      provide: HETZNER_CLIENT,
      useFactory: (): IHetznerClient => {
        return process.env.OPENBAO_URL ? new HetznerClient() : new MockHetznerClient();
      },
    },
    {
      provide: PROVIDER_REGISTRY_PROVIDERS,
      useFactory: (
        noop: NoopProvisioningProvider,
        hetzner: HetznerProvisioningProvider,
      ) => [noop, hetzner],
      inject: [NoopProvisioningProvider, HetznerProvisioningProvider],
    },
    ProviderRegistry,
    {
      provide: PROVIDER_REGISTRY,
      useExisting: ProviderRegistry,
    },
  ],
  controllers: [ProvisioningController, ProvisioningCredentialRefController],
  exports: [ProvisioningService, ProvisioningExecutorService, ProviderRegistry],
})
export class ProvisioningModule {}
