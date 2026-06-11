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
  supportedResources: [
    { type: 'server',       description: 'Virtual machine instances' },
    { type: 'network',      description: 'Private networks and subnets' },
    { type: 'loadbalancer', description: 'Managed load balancers' },
    { type: 'volume',       description: 'Block storage volumes' },
  ],
  supportsCreate:   true,
  supportsUpdate:   true,
  supportsRollback: true,
  supportsDryRun:   true,
};

const NOOP_CAPABILITIES: ProviderCapability = {
  name: 'noop',
  displayName: 'No-op (testing)',
  regions: [],
  resourceTypes: [],
  supportedResources: [],
  supportsCreate: true,
  supportsUpdate: true,
  supportsRollback: true,
  supportsDryRun: true,
};

function makeHetznerProvider(): IProvisioningProvider {
  return {
    getCapabilities: () => HETZNER_CAPABILITIES,
    plan: jest.fn(),
    apply: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue({ healthy: true, latencyMs: 0 }),
  };
}

function makeNoopProvider(): IProvisioningProvider {
  return {
    getCapabilities: () => NOOP_CAPABILITIES,
    plan: jest.fn(),
    apply: jest.fn(),
    healthCheck: jest.fn().mockResolvedValue({ healthy: true, latencyMs: 0 }),
  };
}

function makeRegistry(providers: IProvisioningProvider[] = []): ProviderRegistry {
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
      const hetzner = makeHetznerProvider();
      const noop = makeNoopProvider();
      const registry = makeRegistry([noop, hetzner]);

      const capabilities = registry.list();

      expect(capabilities).toHaveLength(2);
      expect(capabilities[0]).toEqual(NOOP_CAPABILITIES);
      expect(capabilities[1]).toEqual(HETZNER_CAPABILITIES);
    });

    it('list() returns capability with supportsRollback=true for Hetzner', () => {
      const registry = makeRegistry([makeHetznerProvider()]);
      const caps = registry.list();
      const hetzner = caps.find((c) => c.name === 'hetzner');
      expect(hetzner).toBeDefined();
      expect(hetzner!.supportsRollback).toBe(true);
    });

    it('hetzner capability has all Sprint 5a operational flags set to true', () => {
      const registry = makeRegistry([makeHetznerProvider()]);
      const caps = registry.list();
      const hetzner = caps.find((c) => c.name === 'hetzner')!;
      expect(hetzner.supportsCreate).toBe(true);
      expect(hetzner.supportsUpdate).toBe(true);
      expect(hetzner.supportsRollback).toBe(true);
      expect(hetzner.supportsDryRun).toBe(true);
    });

    it('hetzner capability exposes supportedResources with type+description', () => {
      const registry = makeRegistry([makeHetznerProvider()]);
      const caps = registry.list();
      const hetzner = caps.find((c) => c.name === 'hetzner')!;
      expect(hetzner.supportedResources).toHaveLength(4);
      const server = hetzner.supportedResources.find((r) => r.type === 'server');
      expect(server).toMatchObject({ type: 'server', description: 'Virtual machine instances' });
    });

    it('hetzner capability retains backward-compat resourceTypes array', () => {
      const registry = makeRegistry([makeHetznerProvider()]);
      const caps = registry.list();
      const hetzner = caps.find((c) => c.name === 'hetzner')!;
      expect(hetzner.resourceTypes).toEqual(
        expect.arrayContaining(['server', 'network', 'loadbalancer', 'volume']),
      );
    });

    it('noop capability has empty arrays and all supports flags true', () => {
      const registry = makeRegistry([makeNoopProvider()]);
      const caps = registry.list();
      const noop = caps.find((c) => c.name === 'noop')!;
      expect(noop.regions).toEqual([]);
      expect(noop.resourceTypes).toEqual([]);
      expect(noop.supportedResources).toEqual([]);
      expect(noop.supportsCreate).toBe(true);
      expect(noop.supportsUpdate).toBe(true);
      expect(noop.supportsRollback).toBe(true);
      expect(noop.supportsDryRun).toBe(true);
    });
  });
});
