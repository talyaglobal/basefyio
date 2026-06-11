import { NotFoundException } from '@nestjs/common';
import { ProviderRegistry } from './provider-registry.service';
import { IProvisioningProvider } from '../interfaces/provisioning-provider.interface';
import { ProviderCapability } from '../dto/provider-capability.dto';

// ── Helpers ──────────────────────────────────────────────────

const HETZNER_CAPABILITIES: ProviderCapability = {
  name: 'hetzner',
  displayName: 'Hetzner Cloud',
  regions: ['eu-central', 'us-east', 'ap-southeast'],
  resourceTypes: ['server', 'network', 'loadbalancer', 'volume'],
};

function makeHetznerProvider(): IProvisioningProvider {
  return {
    getCapabilities: () => HETZNER_CAPABILITIES,
    plan: jest.fn(),
    apply: jest.fn(),
  };
}

function makeRegistry(providers: IProvisioningProvider[] = []): ProviderRegistry {
  // ProviderRegistry constructor expects the PROVIDER_REGISTRY_PROVIDERS token injection.
  // In tests we bypass NestJS DI and pass the array directly.
  return new ProviderRegistry(providers);
}

// ── Tests ─────────────────────────────────────────────────────

describe('ProviderRegistry', () => {
  describe('resolve()', () => {
    it('returns the Hetzner provider when resolved by name', () => {
      const hetzner = makeHetznerProvider();
      const registry = makeRegistry([hetzner]);

      const resolved = registry.resolve('hetzner');

      expect(resolved).toBe(hetzner);
    });

    it('throws NotFoundException for an unknown provider name', () => {
      const registry = makeRegistry([makeHetznerProvider()]);

      expect(() => registry.resolve('unknown')).toThrow(NotFoundException);
      expect(() => registry.resolve('unknown')).toThrow('Unknown provider: unknown');
    });

    it('throws NotFoundException when the registry is empty', () => {
      const registry = makeRegistry([]);

      expect(() => registry.resolve('hetzner')).toThrow(NotFoundException);
    });
  });

  describe('list()', () => {
    it('returns an array with one entry matching Hetzner capabilities', () => {
      const registry = makeRegistry([makeHetznerProvider()]);

      const capabilities = registry.list();

      expect(capabilities).toHaveLength(1);
      expect(capabilities[0]).toEqual(HETZNER_CAPABILITIES);
    });

    it('returns an empty array when no providers are registered', () => {
      const registry = makeRegistry([]);

      expect(registry.list()).toEqual([]);
    });

    it('returns capabilities for all registered providers in order', () => {
      const noopCapabilities: ProviderCapability = {
        name: 'noop',
        displayName: 'No-op (test)',
        regions: [],
        resourceTypes: [],
      };
      const noopProvider: IProvisioningProvider = {
        getCapabilities: () => noopCapabilities,
        plan: jest.fn(),
        apply: jest.fn(),
      };
      const hetzner = makeHetznerProvider();
      const registry = makeRegistry([noopProvider, hetzner]);

      const capabilities = registry.list();

      expect(capabilities).toHaveLength(2);
      expect(capabilities[0]).toEqual(noopCapabilities);
      expect(capabilities[1]).toEqual(HETZNER_CAPABILITIES);
    });
  });
});
