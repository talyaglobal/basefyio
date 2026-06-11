import { Injectable, Inject, NotFoundException } from '@nestjs/common';
import { PROVIDER_REGISTRY_PROVIDERS } from '../provisioning.constants';
import { IProviderRegistry } from '../interfaces/provider-registry.interface';
import { IProvisioningProvider } from '../interfaces/provisioning-provider.interface';
import { ProviderCapability } from '../dto/provider-capability.dto';

@Injectable()
export class ProviderRegistry implements IProviderRegistry {
  constructor(
    @Inject(PROVIDER_REGISTRY_PROVIDERS)
    private readonly providers: IProvisioningProvider[],
  ) {}

  resolve(providerType: string): IProvisioningProvider {
    const provider = this.providers.find(
      (p) => p.getCapabilities().name === providerType,
    );
    if (!provider) {
      throw new NotFoundException(`Unknown provider: ${providerType}`);
    }
    return provider;
  }

  list(): ProviderCapability[] {
    return this.providers.map((p) => p.getCapabilities());
  }
}
