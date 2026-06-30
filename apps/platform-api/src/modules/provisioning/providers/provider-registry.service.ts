import { BadRequestException } from '@nestjs/common';
import { IProviderRegistry } from '../interfaces/provider-registry.interface';
import { IProvisioningProvider } from '../interfaces/provisioning-provider.interface';

export class ProviderRegistry implements IProviderRegistry {
  private readonly map = new Map<string, IProvisioningProvider>();

  register(providerType: string, provider: IProvisioningProvider): void {
    this.map.set(providerType, provider);
  }

  resolve(providerType: string): IProvisioningProvider {
    const provider = this.map.get(providerType);
    if (!provider) {
      throw new BadRequestException(`Unknown provider type: ${providerType}`);
    }
    return provider;
  }
}
