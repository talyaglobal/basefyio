import { IProvisioningProvider } from './provisioning-provider.interface';
import { ProviderCapability } from '../dto/provider-capability.dto';

export const PROVIDER_REGISTRY = 'PROVIDER_REGISTRY';

export interface IProviderRegistry {
  resolve(providerType: string): IProvisioningProvider;
  list(): ProviderCapability[];
}
