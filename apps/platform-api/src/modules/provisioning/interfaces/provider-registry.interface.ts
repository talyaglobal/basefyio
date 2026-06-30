import { IProvisioningProvider } from './provisioning-provider.interface';

export const PROVIDER_REGISTRY = 'PROVIDER_REGISTRY';

export interface IProviderRegistry {
  resolve(providerType: string): IProvisioningProvider;
}
