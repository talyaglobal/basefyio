import { BadRequestException } from '@nestjs/common';
import { DockerProvisioningProvider } from './docker-provisioning.provider';
import type { DockerClientInterface } from './docker-client';
import type { ProvisioningExecuteInput, ProviderCurrentResource } from '../interfaces/provisioning-provider.interface';

// ── Mock factory ─────────────────────────────────────────────────

function makeMockDocker(): jest.Mocked<DockerClientInterface> {
  return {
    runContainer: jest.fn().mockResolvedValue({ containerId: 'container-abc123' }),
    stopAndRemove: jest.fn().mockResolvedValue(undefined),
    isAvailable: jest.fn().mockResolvedValue(true),
  };
}

function makeProvider(mockDocker?: jest.Mocked<DockerClientInterface>) {
  const docker = mockDocker ?? makeMockDocker();
  return { provider: new DockerProvisioningProvider(docker), docker };
}

// ── Base input factory ────────────────────────────────────────────

const BASE_INPUT: Omit<ProvisioningExecuteInput, 'desiredSpec' | 'currentResources'> = {
  operationId: 'op-docker-1',
  projectId: 'proj-docker-1',
  providerType: 'docker',
  region: 'local',
  datacenter: null,
  credentialOpenbaoPath: '',
  dryRun: false,
};

function makeInput(
  desiredSpec: unknown,
  currentResources: ProviderCurrentResource[] = [],
  dryRun = false,
): ProvisioningExecuteInput {
  return { ...BASE_INPUT, desiredSpec, currentResources, dryRun };
}

function currentContainer(
  name: string,
  externalId: string,
  desiredSpec: Record<string, unknown> = {},
): ProviderCurrentResource {
  return {
    id: `res-container-${name}`,
    type: 'container',
    name,
    status: 'ACTIVE',
    desiredSpec,
    actualSpec: null,
    externalId,
  };
}

// ── getCapabilities ───────────────────────────────────────────────

describe('DockerProvisioningProvider — getCapabilities', () => {
  it('returns name: "docker"', () => {
    const { provider } = makeProvider();
    expect(provider.getCapabilities().name).toBe('docker');
  });

  it('returns supportsRollback: true', () => {
    const { provider } = makeProvider();
    expect(provider.getCapabilities().supportsRollback).toBe(true);
  });

  it('includes "container" in resourceTypes', () => {
    const { provider } = makeProvider();
    expect(provider.getCapabilities().resourceTypes).toContain('container');
  });

  it('returns supportsDryRun: true', () => {
    const { provider } = makeProvider();
    expect(provider.getCapabilities().supportsDryRun).toBe(true);
  });

  it('returns displayName: "Docker"', () => {
    const { provider } = makeProvider();
    expect(provider.getCapabilities().displayName).toBe('Docker');
  });
});

// ── plan ──────────────────────────────────────────────────────────

describe('DockerProvisioningProvider — plan', () => {
  it('missing image returns validationErrors containing "desiredSpec.image is required"', () => {
    const { provider } = makeProvider();
    const result = provider.plan(makeInput({}));
    expect(result.validationErrors).toContain('desiredSpec.image is required');
    expect(result.actions).toHaveLength(0);
  });

  it('null desiredSpec returns validationErrors containing "desiredSpec.image is required"', () => {
    const { provider } = makeProvider();
    const result = provider.plan(makeInput(null));
    expect(result.validationErrors).toContain('desiredSpec.image is required');
  });

  it('no current resources + valid spec returns single CREATE action', () => {
    const { provider } = makeProvider();
    const result = provider.plan(makeInput({ image: 'nginx:latest' }));
    expect(result.validationErrors).toHaveLength(0);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe('CREATE');
    expect(result.actions[0].resourceType).toBe('container');
  });

  it('existing container resource returns DELETE + CREATE actions (update path)', () => {
    const { provider } = makeProvider();
    const result = provider.plan(
      makeInput(
        { image: 'nginx:1.25' },
        [currentContainer('my-container', 'old-container-id')],
      ),
    );
    expect(result.validationErrors).toHaveLength(0);
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0].action).toBe('DELETE');
    expect(result.actions[1].action).toBe('CREATE');
  });

  it('DELETE action contains the existing container externalId in providerMeta', () => {
    const { provider } = makeProvider();
    const result = provider.plan(
      makeInput(
        { image: 'nginx:1.25' },
        [currentContainer('my-container', 'old-container-id')],
      ),
    );
    expect(result.actions[0].providerMeta?.externalId).toBe('old-container-id');
  });
});

// ── apply — dry-run ───────────────────────────────────────────────

describe('DockerProvisioningProvider — apply dry-run', () => {
  it('dryRun=true returns success:true with empty resources', async () => {
    const { provider } = makeProvider();
    const result = await provider.apply(makeInput({ image: 'nginx:latest' }, [], true));
    expect(result.success).toBe(true);
    expect(result.resources).toHaveLength(0);
  });

  it('dryRun=true returns metadata.dryRun: true', async () => {
    const { provider } = makeProvider();
    const result = await provider.apply(makeInput({ image: 'nginx:latest' }, [], true));
    expect(result.metadata?.dryRun).toBe(true);
  });

  it('dryRun=true does NOT call docker.runContainer', async () => {
    const mockDocker = makeMockDocker();
    const { provider } = makeProvider(mockDocker);
    await provider.apply(makeInput({ image: 'nginx:latest' }, [], true));
    expect(mockDocker.runContainer).not.toHaveBeenCalled();
  });

  it('dryRun=true includes plan in metadata', async () => {
    const { provider } = makeProvider();
    const result = await provider.apply(makeInput({ image: 'nginx:latest' }, [], true));
    expect(result.metadata?.plan).toBeDefined();
  });
});

// ── apply — create ────────────────────────────────────────────────

describe('DockerProvisioningProvider — apply create', () => {
  it('calls docker.runContainer with the correct image', async () => {
    const mockDocker = makeMockDocker();
    const { provider } = makeProvider(mockDocker);
    await provider.apply(makeInput({ image: 'nginx:latest' }));
    expect(mockDocker.runContainer).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'nginx:latest' }),
    );
  });

  it('calls docker.runContainer with the provided containerName', async () => {
    const mockDocker = makeMockDocker();
    const { provider } = makeProvider(mockDocker);
    await provider.apply(makeInput({ image: 'nginx:latest', containerName: 'my-nginx' }));
    expect(mockDocker.runContainer).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my-nginx' }),
    );
  });

  it('returns resource with the containerId from docker.runContainer as externalId', async () => {
    const mockDocker = makeMockDocker();
    mockDocker.runContainer.mockResolvedValue({ containerId: 'abc123def456' });
    const { provider } = makeProvider(mockDocker);
    const result = await provider.apply(makeInput({ image: 'nginx:latest' }));
    expect(result.resources[0].externalId).toBe('abc123def456');
  });

  it('returns resource with type: "container"', async () => {
    const { provider } = makeProvider();
    const result = await provider.apply(makeInput({ image: 'nginx:latest' }));
    expect(result.resources[0].type).toBe('container');
  });

  it('returns result with success: true', async () => {
    const { provider } = makeProvider();
    const result = await provider.apply(makeInput({ image: 'nginx:latest' }));
    expect(result.success).toBe(true);
  });

  it('passes port mappings to docker.runContainer', async () => {
    const mockDocker = makeMockDocker();
    const { provider } = makeProvider(mockDocker);
    await provider.apply(
      makeInput({ image: 'nginx:latest', ports: [{ host: 8080, container: 80 }] }),
    );
    expect(mockDocker.runContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        ports: [{ host: 8080, container: 80 }],
      }),
    );
  });

  it('passes env vars as KEY=VALUE strings to docker.runContainer', async () => {
    const mockDocker = makeMockDocker();
    const { provider } = makeProvider(mockDocker);
    await provider.apply(
      makeInput({ image: 'nginx:latest', env: { FOO: 'bar', BAZ: 'qux' } }),
    );
    const call = mockDocker.runContainer.mock.calls[0][0];
    expect(call.env).toEqual(expect.arrayContaining(['FOO=bar', 'BAZ=qux']));
  });
});

// ── validateSpec ──────────────────────────────────────────────────

describe('DockerProvisioningProvider — validateSpec', () => {
  it('missing image throws BadRequestException', async () => {
    const { provider } = makeProvider();
    await expect(provider.apply(makeInput({}))).rejects.toThrow(BadRequestException);
  });

  it('missing image error message contains "Invalid desiredSpec"', async () => {
    const { provider } = makeProvider();
    await expect(provider.apply(makeInput({}))).rejects.toThrow(/Invalid desiredSpec/);
  });

  it('valid spec with image passes without throwing', async () => {
    const { provider } = makeProvider();
    await expect(provider.apply(makeInput({ image: 'alpine:latest' }))).resolves.toBeDefined();
  });

  it('null desiredSpec throws BadRequestException', async () => {
    const { provider } = makeProvider();
    await expect(provider.apply(makeInput(null))).rejects.toThrow(BadRequestException);
  });
});

// ── healthCheck ───────────────────────────────────────────────────

describe('DockerProvisioningProvider — healthCheck', () => {
  it('docker available returns { healthy: true, latencyMs: <number> }', async () => {
    const mockDocker = makeMockDocker();
    mockDocker.isAvailable.mockResolvedValue(true);
    const { provider } = makeProvider(mockDocker);
    const result = await provider.healthCheck();
    expect(result.healthy).toBe(true);
    expect(typeof result.latencyMs).toBe('number');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('docker unavailable returns { healthy: false, latencyMs: <number> }', async () => {
    const mockDocker = makeMockDocker();
    mockDocker.isAvailable.mockResolvedValue(false);
    const { provider } = makeProvider(mockDocker);
    const result = await provider.healthCheck();
    expect(result.healthy).toBe(false);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('calls docker.isAvailable() exactly once', async () => {
    const mockDocker = makeMockDocker();
    const { provider } = makeProvider(mockDocker);
    await provider.healthCheck();
    expect(mockDocker.isAvailable).toHaveBeenCalledTimes(1);
  });
});
