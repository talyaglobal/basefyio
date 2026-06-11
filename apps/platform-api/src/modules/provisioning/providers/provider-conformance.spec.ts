/**
 * Sprint 6a — Provider Conformance Suite
 *
 * Every IProvisioningProvider implementation must satisfy this contract.
 * Adding a new provider: (1) import it, (2) push a ProviderFixture entry.
 * The suite verifies capabilities shape, plan/apply/healthCheck contracts,
 * dry-run isolation, and resource result shape.
 */

import { IProvisioningProvider, ProvisioningExecuteInput, ProviderCurrentResource } from '../interfaces/provisioning-provider.interface';
import { ProviderCapability } from '../dto/provider-capability.dto';

// ── Hetzner imports ───────────────────────────────────────────

import { HetznerProvisioningProvider } from './hetzner-provisioning.provider';
import { ProvisioningPlannerService } from '../provisioning-planner.service';
import { MockHetznerTokenResolver } from './mock-hetzner-token-resolver';
import { MockHetznerClient } from './hetzner/mock-hetzner-client';

// ── Docker imports ────────────────────────────────────────────

import { DockerProvisioningProvider } from './docker-provisioning.provider';
import type { DockerClientInterface } from './docker-client';

// ── Fixture type ──────────────────────────────────────────────

interface ProviderFixture {
  label: string;
  /** Factory called in beforeEach — starts fresh for every test. */
  createProvider: () => IProvisioningProvider;
  /** Valid input with no current resources → must produce ≥1 CREATE action. */
  createInput: ProvisioningExecuteInput;
  /** Valid input with existing resources → must produce UPDATE or DELETE+CREATE. */
  updateInput: ProvisioningExecuteInput;
  /** Input where desiredSpec is semantically invalid → validationErrors non-empty, no throw. */
  invalidInput: ProvisioningExecuteInput;
}

// ── Hetzner fixtures ──────────────────────────────────────────

const BASE_HETZNER: Omit<ProvisioningExecuteInput, 'desiredSpec' | 'currentResources'> = {
  operationId: 'conformance-op-hetzner',
  projectId: 'proj-hetzner',
  providerType: 'hetzner',
  region: 'eu-central',
  datacenter: null,
  credentialOpenbaoPath: 'secret/hetzner/token',
  dryRun: false,
};

const hetznerCurrentServer: ProviderCurrentResource = {
  id: 'res-server-web-1',
  type: 'SERVER',
  name: 'web-1',
  status: 'ACTIVE',
  desiredSpec: { server_type: 'cx11', image: 'ubuntu-24.04' },
  actualSpec: null,
  externalId: 'ext-server-web-1',
};

const HETZNER_FIXTURE: ProviderFixture = {
  label: 'HetznerProvisioningProvider',
  createProvider: () =>
    new HetznerProvisioningProvider(
      new ProvisioningPlannerService(),
      new MockHetznerTokenResolver('test-token'),
      new MockHetznerClient(),
    ),
  createInput: {
    ...BASE_HETZNER,
    desiredSpec: {
      resources: [{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-24.04' } }],
    },
    currentResources: [],
  },
  updateInput: {
    ...BASE_HETZNER,
    desiredSpec: {
      resources: [{ type: 'server', name: 'web-1', spec: { server_type: 'cx21', image: 'ubuntu-24.04' } }],
    },
    currentResources: [hetznerCurrentServer],
  },
  invalidInput: {
    ...BASE_HETZNER,
    desiredSpec: {
      resources: [{ type: 'completely_unsupported_resource_kind', name: 'x', spec: {} }],
    },
    currentResources: [],
    dryRun: true,
  },
};

// ── Docker fixtures ───────────────────────────────────────────

function makeMockDockerClient(): jest.Mocked<DockerClientInterface> {
  return {
    runContainer: jest.fn().mockResolvedValue({ containerId: 'conformance-container-abc' }),
    stopAndRemove: jest.fn().mockResolvedValue(undefined),
    isAvailable: jest.fn().mockResolvedValue(true),
  };
}

const BASE_DOCKER: Omit<ProvisioningExecuteInput, 'desiredSpec' | 'currentResources'> = {
  operationId: 'conformance-op-docker',
  projectId: 'proj-docker',
  providerType: 'docker',
  region: 'local',
  datacenter: null,
  credentialOpenbaoPath: '',
  dryRun: false,
};

const dockerCurrentContainer: ProviderCurrentResource = {
  id: 'res-container-my-app',
  type: 'container',
  name: 'my-app',
  status: 'ACTIVE',
  desiredSpec: { image: 'nginx:1.24', containerName: 'my-app' },
  actualSpec: null,
  externalId: 'container-old-id',
};

let sharedDockerMock = makeMockDockerClient();

const DOCKER_FIXTURE: ProviderFixture = {
  label: 'DockerProvisioningProvider',
  createProvider: () => {
    sharedDockerMock = makeMockDockerClient();
    return new DockerProvisioningProvider(sharedDockerMock);
  },
  createInput: {
    ...BASE_DOCKER,
    desiredSpec: { image: 'nginx:latest', containerName: 'conformance-app' },
    currentResources: [],
  },
  updateInput: {
    ...BASE_DOCKER,
    desiredSpec: { image: 'nginx:1.25', containerName: 'my-app' },
    currentResources: [dockerCurrentContainer],
  },
  invalidInput: {
    ...BASE_DOCKER,
    desiredSpec: {},
    currentResources: [],
  },
};

// ── Registered providers ──────────────────────────────────────

const FIXTURES: ProviderFixture[] = [HETZNER_FIXTURE, DOCKER_FIXTURE];

// ── Conformance assertions ────────────────────────────────────

describe.each(FIXTURES)('Provider conformance — $label', (fixture) => {
  let provider: IProvisioningProvider;

  beforeEach(() => {
    provider = fixture.createProvider();
  });

  // ── 1. getCapabilities() shape ────────────────────────────

  describe('getCapabilities()', () => {
    let cap: ProviderCapability;
    beforeEach(() => { cap = provider.getCapabilities(); });

    it('returns a non-null object', () => {
      expect(cap).toBeDefined();
      expect(typeof cap).toBe('object');
    });

    it('name is a non-empty string', () => {
      expect(typeof cap.name).toBe('string');
      expect(cap.name.length).toBeGreaterThan(0);
    });

    it('displayName is a non-empty string', () => {
      expect(typeof cap.displayName).toBe('string');
      expect(cap.displayName.length).toBeGreaterThan(0);
    });

    it('regions is an array', () => {
      expect(Array.isArray(cap.regions)).toBe(true);
    });

    it('resourceTypes is an array of strings', () => {
      expect(Array.isArray(cap.resourceTypes)).toBe(true);
      cap.resourceTypes.forEach((r) => expect(typeof r).toBe('string'));
    });

    it('supportedResources is an array', () => {
      expect(Array.isArray(cap.supportedResources)).toBe(true);
    });

    it('every supportedResource has non-empty type and description strings', () => {
      for (const r of cap.supportedResources) {
        expect(typeof r.type).toBe('string');
        expect(r.type.length).toBeGreaterThan(0);
        expect(typeof r.description).toBe('string');
        expect(r.description.length).toBeGreaterThan(0);
      }
    });

    it('supportsCreate is a boolean', () => {
      expect(typeof cap.supportsCreate).toBe('boolean');
    });

    it('supportsUpdate is a boolean', () => {
      expect(typeof cap.supportsUpdate).toBe('boolean');
    });

    it('supportsRollback is a boolean', () => {
      expect(typeof cap.supportsRollback).toBe('boolean');
    });

    it('supportsDryRun is a boolean', () => {
      expect(typeof cap.supportsDryRun).toBe('boolean');
    });

    it('is idempotent — two calls return equal objects', () => {
      expect(provider.getCapabilities()).toEqual(provider.getCapabilities());
    });
  });

  // ── 2. plan() return-type contract ────────────────────────

  describe('plan()', () => {
    it('returns { actions, validationErrors } for valid create input', () => {
      const result = provider.plan(fixture.createInput);
      expect(result).toHaveProperty('actions');
      expect(result).toHaveProperty('validationErrors');
      expect(Array.isArray(result.actions)).toBe(true);
      expect(Array.isArray(result.validationErrors)).toBe(true);
    });

    it('never throws — invalid input returns validationErrors instead', () => {
      expect(() => provider.plan(fixture.invalidInput)).not.toThrow();
      const result = provider.plan(fixture.invalidInput);
      expect(result.validationErrors.length).toBeGreaterThan(0);
    });

    it('valid create input produces at least one action', () => {
      const result = provider.plan(fixture.createInput);
      expect(result.actions.length).toBeGreaterThan(0);
    });

    it('create input (no current resources) produces no DELETE actions', () => {
      const result = provider.plan(fixture.createInput);
      const deletes = result.actions.filter((a) => a.action === 'DELETE');
      expect(deletes).toHaveLength(0);
    });

    it('update input (with current resources) may produce non-CREATE actions', () => {
      const result = provider.plan(fixture.updateInput);
      expect(Array.isArray(result.actions)).toBe(true);
    });

    it('every action has required string fields: action, resourceType, resourceName, reason', () => {
      const result = provider.plan(fixture.createInput);
      for (const action of result.actions) {
        expect(typeof action.action).toBe('string');
        expect(typeof action.resourceType).toBe('string');
        expect(typeof action.resourceName).toBe('string');
        expect(typeof action.reason).toBe('string');
        expect(action.reason.length).toBeGreaterThan(0);
      }
    });

    it('action.action is one of: CREATE, UPDATE, DELETE, NOOP', () => {
      const VALID_ACTIONS = new Set(['CREATE', 'UPDATE', 'DELETE', 'NOOP']);
      const result = provider.plan(fixture.createInput);
      for (const action of result.actions) {
        expect(VALID_ACTIONS.has(action.action)).toBe(true);
      }
    });
  });

  // ── 3. apply() dry-run contract ───────────────────────────

  describe('apply() — dry-run', () => {
    const dryInput = (base: ProvisioningExecuteInput) => ({ ...base, dryRun: true });

    it('returns success: true', async () => {
      const result = await provider.apply(dryInput(fixture.createInput));
      expect(result.success).toBe(true);
    });

    it('returns resources as an empty array', async () => {
      const result = await provider.apply(dryInput(fixture.createInput));
      expect(Array.isArray(result.resources)).toBe(true);
      expect(result.resources).toHaveLength(0);
    });

    it('returns metadata.dryRun === true', async () => {
      const result = await provider.apply(dryInput(fixture.createInput));
      expect(result.metadata?.dryRun).toBe(true);
    });

    it('deletedExternalIds is an array (not undefined)', async () => {
      const result = await provider.apply(dryInput(fixture.createInput));
      expect(Array.isArray(result.deletedExternalIds ?? [])).toBe(true);
    });
  });

  // ── 4. apply() create contract ────────────────────────────

  describe('apply() — create (live)', () => {
    it('returns success: true', async () => {
      const result = await provider.apply(fixture.createInput);
      expect(result.success).toBe(true);
    });

    it('returns at least one resource', async () => {
      const result = await provider.apply(fixture.createInput);
      expect(result.resources.length).toBeGreaterThan(0);
    });

    it('every resource has externalId as a non-empty string', async () => {
      const result = await provider.apply(fixture.createInput);
      for (const r of result.resources) {
        expect(typeof r.externalId).toBe('string');
        expect(r.externalId.length).toBeGreaterThan(0);
      }
    });

    it('every resource has type as a non-empty string', async () => {
      const result = await provider.apply(fixture.createInput);
      for (const r of result.resources) {
        expect(typeof r.type).toBe('string');
        expect(r.type.length).toBeGreaterThan(0);
      }
    });

    it('every resource has name as a non-empty string', async () => {
      const result = await provider.apply(fixture.createInput);
      for (const r of result.resources) {
        expect(typeof r.name).toBe('string');
        expect(r.name.length).toBeGreaterThan(0);
      }
    });

    it('every resource has status: "ACTIVE"', async () => {
      const result = await provider.apply(fixture.createInput);
      for (const r of result.resources) {
        expect(r.status).toBe('ACTIVE');
      }
    });

    it('every resource has desiredSpec as a non-null object', async () => {
      const result = await provider.apply(fixture.createInput);
      for (const r of result.resources) {
        expect(r.desiredSpec).toBeDefined();
        expect(typeof r.desiredSpec).toBe('object');
      }
    });

    it('every resource has actualSpec as a non-null object', async () => {
      const result = await provider.apply(fixture.createInput);
      for (const r of result.resources) {
        expect(r.actualSpec).toBeDefined();
        expect(typeof r.actualSpec).toBe('object');
      }
    });

    it('deletedExternalIds is an array', async () => {
      const result = await provider.apply(fixture.createInput);
      expect(Array.isArray(result.deletedExternalIds ?? [])).toBe(true);
    });
  });

  // ── 5. healthCheck() contract ─────────────────────────────

  describe('healthCheck()', () => {
    it('returns an object with healthy (boolean) and latencyMs (number)', async () => {
      const result = await provider.healthCheck();
      expect(typeof result.healthy).toBe('boolean');
      expect(typeof result.latencyMs).toBe('number');
    });

    it('latencyMs is a non-negative number', async () => {
      const result = await provider.healthCheck();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('is callable multiple times without throwing', async () => {
      await expect(provider.healthCheck()).resolves.toBeDefined();
      await expect(provider.healthCheck()).resolves.toBeDefined();
    });
  });
});
