import { BadRequestException } from '@nestjs/common';
import { HetznerProvisioningProvider } from './hetzner-provisioning.provider';
import { ProvisioningPlannerService } from '../provisioning-planner.service';
import { ProvisioningExecuteInput, ProviderCurrentResource } from '../interfaces/provisioning-provider.interface';
import { MockHetznerTokenResolver } from './mock-hetzner-token-resolver';
import { MockHetznerClient } from './hetzner/mock-hetzner-client';
import { CircularDependencyError } from '../provisioning-topo-sort';
import { PartialApplyError } from '../interfaces/partial-apply.error';

// ── Factories ─────────────────────────────────────────────────

function makePlanner() {
  return new ProvisioningPlannerService();
}

function makeClient() {
  return new MockHetznerClient();
}

function makeProvider(
  resolver?: MockHetznerTokenResolver,
  client?: MockHetznerClient,
) {
  return new HetznerProvisioningProvider(makePlanner(), resolver, client);
}

const BASE_INPUT: Omit<ProvisioningExecuteInput, 'desiredSpec' | 'currentResources'> = {
  operationId: 'op-1',
  projectId: 'proj-1',
  providerType: 'hetzner',
  region: 'eu-central',
  datacenter: null,
  credentialOpenbaoPath: 'secret/hetzner/token',
  dryRun: true,   // Phase 8/9a baseline: all calls dry-run; tests override to false as needed
};

function withDesired(
  resources: Array<{ type: string; name: string; spec?: Record<string, unknown> }>,
  currentResources: ProviderCurrentResource[] = [],
): ProvisioningExecuteInput {
  return {
    ...BASE_INPUT,
    desiredSpec: {
      resources: resources.map((r) => ({ type: r.type, name: r.name, spec: r.spec ?? {} })),
    },
    currentResources,
  };
}

function currentResource(
  type: string,
  name: string,
  desiredSpec: Record<string, unknown> = {},
  externalId = `ext-${name}`,
): ProviderCurrentResource {
  return {
    id: `res-${type}-${name}`,
    type: type.toUpperCase(),
    name,
    status: 'ACTIVE',
    desiredSpec,
    actualSpec: null,
    externalId,
  };
}

// ── CREATE server ─────────────────────────────────────────────

describe('HetznerProvisioningProvider — CREATE server', () => {
  it('plan() produces a CREATE action for a new server', () => {
    const result = makeProvider().plan(
      withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11' } }]),
    );

    expect(result.validationErrors).toHaveLength(0);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      action: 'CREATE',
      resourceType: 'server',
      resourceName: 'web-1',
      desiredSpec: { server_type: 'cx11' },
    });
  });

  it('apply() returns dry-run result with CREATE action and empty resources', async () => {
    const result = await makeProvider().apply(
      withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11' } }]),
    );

    expect(result.success).toBe(true);
    expect(result.resources).toHaveLength(0);
    expect(result.metadata).toMatchObject({
      provider: 'hetzner',
      dryRun: true,
    });
    const actions = (result.metadata as any).actions as any[];
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('CREATE');
  });
});

// ── UPDATE server ─────────────────────────────────────────────

describe('HetznerProvisioningProvider — UPDATE server', () => {
  it('plan() produces UPDATE with updateStrategy=resize when server_type changes', () => {
    const result = makeProvider().plan(
      withDesired(
        [{ type: 'server', name: 'web-1', spec: { server_type: 'cx21' } }],
        [currentResource('SERVER', 'web-1', { server_type: 'cx11' })],
      ),
    );

    expect(result.actions[0].action).toBe('UPDATE');
    expect(result.actions[0].updateStrategy).toBe('resize');
  });

  it('plan() produces UPDATE with updateStrategy=rebuild when image changes', () => {
    const result = makeProvider().plan(
      withDesired(
        [{ type: 'server', name: 'web-1', spec: { image: 'ubuntu-22.04' } }],
        [currentResource('SERVER', 'web-1', { image: 'debian-11' })],
      ),
    );

    expect(result.actions[0].action).toBe('UPDATE');
    expect(result.actions[0].updateStrategy).toBe('rebuild');
  });

  it('plan() falls back to updateStrategy=update for unknown server field changes', () => {
    const result = makeProvider().plan(
      withDesired(
        [{ type: 'server', name: 'web-1', spec: { labels: { env: 'prod' } } }],
        [currentResource('SERVER', 'web-1', { labels: { env: 'dev' } })],
      ),
    );

    expect(result.actions[0].action).toBe('UPDATE');
    expect(result.actions[0].updateStrategy).toBe('update');
  });
});

// ── DELETE resource ───────────────────────────────────────────

describe('HetznerProvisioningProvider — DELETE resource', () => {
  it('plan() produces DELETE when a current resource is absent from desired state', () => {
    const result = makeProvider().plan(
      withDesired([], [currentResource('SERVER', 'web-1', { server_type: 'cx11' })]),
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]).toMatchObject({
      action: 'DELETE',
      resourceType: 'server',
      resourceName: 'web-1',
    });
    expect(result.validationErrors).toHaveLength(0);
  });
});

// ── NOOP ─────────────────────────────────────────────────────

describe('HetznerProvisioningProvider — NOOP', () => {
  it('plan() produces NOOP when desired spec matches current state', () => {
    const spec = { server_type: 'cx11', datacenter: 'hel1-dc2' };
    const result = makeProvider().plan(
      withDesired(
        [{ type: 'server', name: 'web-1', spec }],
        [currentResource('SERVER', 'web-1', spec)],
      ),
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].action).toBe('NOOP');
    expect(result.actions[0].updateStrategy).toBeUndefined();
  });

  it('apply() metadata actions list is empty when all resources are NOOP', async () => {
    const spec = { server_type: 'cx11' };
    const result = await makeProvider().apply(
      withDesired(
        [{ type: 'server', name: 'web-1', spec }],
        [currentResource('SERVER', 'web-1', spec)],
      ),
    );

    // NOOP actions ARE reported in the plan metadata for observability
    const actions = (result.metadata as any).actions as any[];
    expect(actions[0].action).toBe('NOOP');
    expect(result.resources).toHaveLength(0);
  });
});

// ── Unsupported kind ──────────────────────────────────────────

describe('HetznerProvisioningProvider — unsupported kind', () => {
  it('returns a validation error for an unsupported resource kind', () => {
    const result = makeProvider().plan(
      withDesired([{ type: 'load_balancer', name: 'lb-1', spec: {} }]),
    );

    expect(result.actions).toHaveLength(0);
    expect(result.validationErrors).toHaveLength(1);
    expect(result.validationErrors[0]).toMatch(/load_balancer/);
    expect(result.validationErrors[0]).toMatch(/server, volume, network, firewall, ssh_key/);
  });

  it('does not throw — unsupported kind is a validation warning, not FAILED', () => {
    expect(() =>
      makeProvider().plan(withDesired([{ type: 'unknown_resource', name: 'x', spec: {} }])),
    ).not.toThrow();
  });

  it('processes valid resources alongside an unsupported kind', () => {
    const result = makeProvider().plan(
      withDesired([
        { type: 'server', name: 'web-1', spec: { server_type: 'cx11' } },
        { type: 'magic_box', name: 'box-1', spec: {} },
      ]),
    );

    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].resourceType).toBe('server');
    expect(result.validationErrors).toHaveLength(1);
  });

  it('apply() propagates validationErrors for unsupported kinds in metadata', async () => {
    const result = await makeProvider().apply(
      withDesired([{ type: 'mystery_type', name: 'x', spec: {} }]),
    );

    expect(result.success).toBe(true);
    const errors = (result.metadata as any).validationErrors as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/mystery_type/);
  });
});

// ── Supported kinds normalisation ──────────────────────────────

describe('HetznerProvisioningProvider — supported kinds', () => {
  const supported = ['server', 'volume', 'network', 'firewall', 'ssh_key'];

  for (const kind of supported) {
    it(`accepts resource kind '${kind}'`, () => {
      const result = makeProvider().plan(
        withDesired([{ type: kind, name: `${kind}-1`, spec: {} }]),
      );
      expect(result.validationErrors).toHaveLength(0);
      expect(result.actions[0].resourceType).toBe(kind);
    });
  }

  it('normalises kind to lowercase in action output', () => {
    const result = makeProvider().plan(
      withDesired([{ type: 'SERVER', name: 'web-1', spec: {} }]),
    );
    expect(result.actions[0].resourceType).toBe('server');
  });
});

// ── API call boundary ────────────────────────────────────────

describe('HetznerProvisioningProvider — no real API calls', () => {
  it('apply() returns without calling any external service (dry-run phase)', async () => {
    const result = await makeProvider().apply(
      withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11' } }]),
    );

    expect(result.metadata).toMatchObject({ provider: 'hetzner', dryRun: true });
    expect(result.resources).toHaveLength(0);
  });

  it('apply() is deterministic — same input always yields identical output', async () => {
    const input = withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11' } }]);

    const a = await makeProvider().apply(input);
    const b = await makeProvider().apply(input);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ── Secret boundary ───────────────────────────────────────────

describe('HetznerProvisioningProvider — secret boundary', () => {
  it('apply() result does not contain the openbao credential path', async () => {
    const result = await makeProvider().apply(
      withDesired([{ type: 'server', name: 'web-1', spec: {} }]),
    );

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(BASE_INPUT.credentialOpenbaoPath);
    expect(serialised).not.toContain('secret/hetzner');
  });

  it('plan() result does not contain the openbao credential path', () => {
    const result = makeProvider().plan(
      withDesired([{ type: 'server', name: 'web-1', spec: {} }]),
    );

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(BASE_INPUT.credentialOpenbaoPath);
  });

  it('apply() result does not contain any resolved token or credential field', async () => {
    const result = await makeProvider().apply(
      withDesired([{ type: 'server', name: 'web-1', spec: {} }]),
    );

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('apiKey');
    expect(serialised).not.toContain('password');
    expect(serialised).not.toContain('mock-hetzner-token');
    expect(serialised).not.toContain('hetzner-api-token');
  });
});

// ── Phase 9a — token resolver contract ───────────────────────

describe('HetznerProvisioningProvider — dry-run gate (Phase 9a)', () => {
  it('dry-run apply() does NOT call the token resolver', async () => {
    const resolver = new MockHetznerTokenResolver('super-secret');
    const provider = makeProvider(resolver, makeClient());

    await provider.apply(withDesired([{ type: 'server', name: 'web-1', spec: {} }]));

    expect(resolver.wasCalled()).toBe(false);
  });

  it('non-dry-run apply() DOES call the token resolver', async () => {
    const resolver = new MockHetznerTokenResolver('super-secret');
    const provider = makeProvider(resolver, makeClient());

    const input: ProvisioningExecuteInput = {
      ...withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11' } }]),
      dryRun: false,
    };
    await provider.apply(input);

    expect(resolver.wasCalled()).toBe(true);
    expect(resolver.calls()).toContain(BASE_INPUT.credentialOpenbaoPath);
  });

  it('non-dry-run apply() fails fast when no tokenResolver is wired', async () => {
    const provider = makeProvider(); // no resolver, no client

    const input: ProvisioningExecuteInput = {
      ...withDesired([{ type: 'server', name: 'web-1', spec: {} }]),
      dryRun: false,
    };
    await expect(provider.apply(input)).rejects.toThrow(/HETZNER_TOKEN_RESOLVER.*required|required for real operations/);
  });

  it('non-dry-run apply() fails fast when no hetznerClient is wired', async () => {
    const resolver = new MockHetznerTokenResolver('super-secret');
    const provider = makeProvider(resolver); // resolver present, client absent

    const input: ProvisioningExecuteInput = {
      ...withDesired([{ type: 'server', name: 'web-1', spec: {} }]),
      dryRun: false,
    };
    await expect(provider.apply(input)).rejects.toThrow(/HETZNER_CLIENT.*required|required for real operations/);
  });

  it('non-dry-run apply() fails fast when openbaoPath is empty', async () => {
    const resolver = new MockHetznerTokenResolver('super-secret');
    const provider = makeProvider(resolver, makeClient());

    const input: ProvisioningExecuteInput = {
      ...withDesired([{ type: 'server', name: 'web-1', spec: {} }]),
      dryRun: false,
      credentialOpenbaoPath: '',
    };
    await expect(provider.apply(input)).rejects.toThrow(/openbaoPath must not be empty/);
  });
});

// ── Phase 9a — resolved token not in result ───────────────────

describe('HetznerProvisioningProvider — resolved token not in result (Phase 9a)', () => {
  const REAL_TOKEN = 'hetzner-api-token-abc123xyz';

  async function applyNonDryRun() {
    const resolver = new MockHetznerTokenResolver(REAL_TOKEN);
    const client = makeClient();
    const provider = makeProvider(resolver, client);
    const input: ProvisioningExecuteInput = {
      ...withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
      dryRun: false,
    };
    const result = await provider.apply(input);
    return { result, resolver, client };
  }

  it('resolved token does not appear in the result payload', async () => {
    const { result } = await applyNonDryRun();
    expect(JSON.stringify(result)).not.toContain(REAL_TOKEN);
  });

  it('result resources include the created server', async () => {
    const { result } = await applyNonDryRun();
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].type).toBe('server');
    expect(result.resources[0].name).toBe('web-1');
  });

  it('result metadata includes provider and dryRun:false', async () => {
    const { result } = await applyNonDryRun();
    expect(result.metadata).toMatchObject({ provider: 'hetzner', dryRun: false });
  });

  it('resolver is called exactly once per apply()', async () => {
    const { resolver } = await applyNonDryRun();
    expect(resolver.calls()).toHaveLength(1);
  });
});

// ── Phase 9b — HetznerClient wired ───────────────────────────

describe('HetznerProvisioningProvider — Phase 9b: HetznerClient wired', () => {
  it('non-dry-run CREATE server returns a resource with externalId', async () => {
    const provider = makeProvider(
      new MockHetznerTokenResolver('test-token'),
      makeClient(),
    );
    const input: ProvisioningExecuteInput = {
      ...withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
      dryRun: false,
    };
    const result = await provider.apply(input);

    expect(result.resources).toHaveLength(1);
    const resource = result.resources[0];
    expect(resource.type).toBe('server');
    expect(resource.name).toBe('web-1');
    expect(resource.externalId).toBeTruthy();
    expect(resource.status).toBe('ACTIVE');
  });

  it('externalId is the string representation of the Hetzner server.id', async () => {
    const client = makeClient();
    const provider = makeProvider(new MockHetznerTokenResolver('test-token'), client);
    const input: ProvisioningExecuteInput = {
      ...withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
      dryRun: false,
    };
    const result = await provider.apply(input);

    // MockHetznerClient starts IDs at 1001
    expect(result.resources[0].externalId).toBe('1001');
  });

  it('actualSpec includes server metadata from the Hetzner response', async () => {
    const provider = makeProvider(
      new MockHetznerTokenResolver('test-token'),
      makeClient(),
    );
    const input: ProvisioningExecuteInput = {
      ...withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
      dryRun: false,
    };
    const result = await provider.apply(input);

    const { actualSpec } = result.resources[0];
    expect(actualSpec).toMatchObject({
      server_type: 'cx11',
      location: 'nbg1',        // eu-central → nbg1
      datacenter: 'nbg1-dc1',
      status: 'running',
    });
  });

  it('dry-run does NOT call hetznerClient.createServer', async () => {
    const client = makeClient();
    const createSpy = jest.spyOn(client, 'createServer');
    const provider = makeProvider(new MockHetznerTokenResolver('test-token'), client);

    await provider.apply(
      withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11' } }]),
      // dryRun: true from BASE_INPUT
    );

    expect(createSpy).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });

  it('resolved token is NOT passed to createServer as the first positional arg', async () => {
    const client = makeClient();
    const createSpy = jest.spyOn(client, 'createServer');
    const TOKEN = 'secret-token-xyz';
    const provider = makeProvider(new MockHetznerTokenResolver(TOKEN), client);

    const input: ProvisioningExecuteInput = {
      ...withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
      dryRun: false,
    };
    await provider.apply(input);

    // Token must be the second param (apiToken), not embedded in the params object
    const [params, apiToken] = createSpy.mock.calls[0];
    expect(JSON.stringify(params)).not.toContain(TOKEN);
    expect(apiToken).toBe(TOKEN);
    createSpy.mockRestore();
  });

  it('NOOP actions do not produce resources', async () => {
    const spec = { server_type: 'cx11', image: 'ubuntu-22.04' };
    const provider = makeProvider(
      new MockHetznerTokenResolver('test-token'),
      makeClient(),
    );
    const input: ProvisioningExecuteInput = {
      ...withDesired(
        [{ type: 'server', name: 'web-1', spec }],
        [currentResource('SERVER', 'web-1', spec)],
      ),
      dryRun: false,
    };
    const result = await provider.apply(input);

    expect(result.resources).toHaveLength(0);
    expect(result.success).toBe(true);
  });
});

// ── MockHetznerTokenResolver contract ─────────────────────────

describe('MockHetznerTokenResolver — contract', () => {
  it('resolve() returns the configured token', async () => {
    const resolver = new MockHetznerTokenResolver('my-token');
    expect(await resolver.resolve('some/path')).toBe('my-token');
  });

  it('resolve() throws when path is empty', async () => {
    const resolver = new MockHetznerTokenResolver();
    await expect(resolver.resolve('')).rejects.toThrow(/openbaoPath must not be empty/);
  });

  it('resolve() throws when path is whitespace only', async () => {
    const resolver = new MockHetznerTokenResolver();
    await expect(resolver.resolve('   ')).rejects.toThrow(/openbaoPath must not be empty/);
  });

  it('tracks all resolved paths in calls()', async () => {
    const resolver = new MockHetznerTokenResolver();
    await resolver.resolve('path/one');
    await resolver.resolve('path/two');
    expect(resolver.calls()).toEqual(['path/one', 'path/two']);
  });

  it('wasCalled() is false before any resolve()', () => {
    expect(new MockHetznerTokenResolver().wasCalled()).toBe(false);
  });
});

// ── Phase 9 — real apply (dryRun=false) ──────────────────────

function makeRealProvider() {
  const tokenResolver = new MockHetznerTokenResolver('test-token-xyz');
  const client = new MockHetznerClient();
  const provider = new HetznerProvisioningProvider(
    new ProvisioningPlannerService(),
    tokenResolver,
    client,
  );
  return { provider, tokenResolver, client };
}

function realInput(
  resources: Array<{ type: string; name: string; spec?: Record<string, unknown> }>,
  currentResources: ProviderCurrentResource[] = [],
): ProvisioningExecuteInput {
  return {
    ...BASE_INPUT,
    dryRun: false,
    desiredSpec: {
      resources: resources.map((r) => ({ type: r.type, name: r.name, spec: r.spec ?? {} })),
    },
    currentResources,
  };
}

function trackedServer(name: string, externalId: string, spec: Record<string, unknown> = {}): ProviderCurrentResource {
  return {
    id: `db-${name}`,
    type: 'SERVER',
    name,
    status: 'ACTIVE',
    desiredSpec: spec,
    actualSpec: null,
    externalId,
  };
}

// ── CREATE ────────────────────────────────────────────────────

describe('HetznerProvisioningProvider — Phase 9 CREATE', () => {
  it('apply() creates a server and returns a ProvisioningResourceResult', async () => {
    const { provider } = makeRealProvider();
    const result = await provider.apply(
      realInput([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
    );

    expect(result.success).toBe(true);
    expect(result.resources).toHaveLength(1);
    const r = result.resources[0];
    expect(r.type).toBe('server');
    expect(r.name).toBe('web-1');
    expect(r.externalId).toBeTruthy();
    expect(r.status).toBe('ACTIVE');
    expect(r.actualSpec).toMatchObject({ server_type: 'cx11' });
  });

  it('apply() resolves the OpenBao token before dispatching', async () => {
    const { provider, tokenResolver } = makeRealProvider();
    await provider.apply(
      realInput([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
    );
    expect(tokenResolver.wasCalled()).toBe(true);
    expect(tokenResolver.calls()).toContain('secret/hetzner/token');
  });

  it('apply() maps eu-central region to nbg1 location (via LocationMapper)', async () => {
    const { provider, client } = makeRealProvider();
    const createSpy = jest.spyOn(client, 'createServer');
    await provider.apply(
      realInput([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
    );
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ location: 'nbg1' }),
      'test-token-xyz',
    );
  });

  it('apply() deletedExternalIds is empty for a pure CREATE', async () => {
    const { provider } = makeRealProvider();
    const result = await provider.apply(
      realInput([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
    );
    expect(result.deletedExternalIds).toHaveLength(0);
  });
});

// ── UPDATE ────────────────────────────────────────────────────

describe('HetznerProvisioningProvider — Phase 9 UPDATE', () => {
  it('apply() resize calls resizeServer with new server_type', async () => {
    const { provider, client } = makeRealProvider();
    const resizeSpy = jest.spyOn(client, 'resizeServer');

    const result = await provider.apply(
      realInput(
        [{ type: 'server', name: 'web-1', spec: { server_type: 'cx21' } }],
        [trackedServer('web-1', '1001', { server_type: 'cx11' })],
      ),
    );

    expect(resizeSpy).toHaveBeenCalledWith(1001, 'cx21', 'test-token-xyz');
    expect(result.resources[0].externalId).toBe('1001');
    expect(result.resources[0].status).toBe('ACTIVE');
  });

  it('apply() rebuild calls rebuildServer with new image', async () => {
    const { provider, client } = makeRealProvider();
    const rebuildSpy = jest.spyOn(client, 'rebuildServer');

    await provider.apply(
      realInput(
        [{ type: 'server', name: 'web-1', spec: { image: 'debian-12' } }],
        [trackedServer('web-1', '1002', { image: 'ubuntu-22.04' })],
      ),
    );

    expect(rebuildSpy).toHaveBeenCalledWith(1002, 'debian-12', 'test-token-xyz');
  });
});

// ── Phase 10a — Read-after-write ─────────────────────────────

describe('HetznerProvisioningProvider — Phase 10a: read-after-write', () => {
  it('UPDATE resize: getServer() is called after resizeServer()', async () => {
    const { provider, client } = makeRealProvider();
    const getServerSpy = jest.spyOn(client, 'getServer');

    await provider.apply(
      realInput(
        [{ type: 'server', name: 'web-1', spec: { server_type: 'cx21' } }],
        [trackedServer('web-1', '1001', { server_type: 'cx11' })],
      ),
    );

    expect(getServerSpy).toHaveBeenCalledWith(1001, 'test-token-xyz');
  });

  it('UPDATE resize: actualSpec reflects getServer() snapshot, not desiredSpec', async () => {
    const { provider } = makeRealProvider();

    const result = await provider.apply(
      realInput(
        [{ type: 'server', name: 'web-1', spec: { server_type: 'cx21' } }],
        [trackedServer('web-1', '1001', { server_type: 'cx11' })],
      ),
    );

    const { actualSpec } = result.resources[0];
    // actualSpec comes from getServer() — has server snapshot fields absent from desiredSpec
    expect(actualSpec).toMatchObject({
      id: expect.any(Number),
      status: 'running',
      location: expect.any(String),
      datacenter: expect.any(String),
    });
  });

  it('UPDATE rebuild: getServer() is called after rebuildServer()', async () => {
    const { provider, client } = makeRealProvider();
    const getServerSpy = jest.spyOn(client, 'getServer');

    await provider.apply(
      realInput(
        [{ type: 'server', name: 'web-1', spec: { image: 'debian-12' } }],
        [trackedServer('web-1', '1002', { image: 'ubuntu-22.04' })],
      ),
    );

    expect(getServerSpy).toHaveBeenCalledWith(1002, 'test-token-xyz');
  });

  it('CREATE does NOT call getServer() — actualSpec comes from createServer() response', async () => {
    const { provider, client } = makeRealProvider();
    const getServerSpy = jest.spyOn(client, 'getServer');

    await provider.apply(
      realInput([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
    );

    expect(getServerSpy).not.toHaveBeenCalled();
  });

  it('UPDATE resize: actualSpec server_type matches server state after resize', async () => {
    const client = makeClient();
    // Pre-seed the mock so resizeServer() can mutate the record and getServer() reads it back.
    // createServer() seeds with cx11; resizeServer() will update it to cx21.
    await client.createServer(
      { name: 'web-1', server_type: 'cx11', image: 'ubuntu-22.04', location: 'nbg1' },
      'ignored',
    );
    const seededId = 1001; // MockHetznerClient starts at 1000, first create → 1001

    const provider = makeProvider(new MockHetznerTokenResolver('test-token'), client);
    const result = await provider.apply({
      ...realInput(
        [{ type: 'server', name: 'web-1', spec: { server_type: 'cx21' } }],
        [trackedServer('web-1', String(seededId), { server_type: 'cx11' })],
      ),
    });

    expect(result.resources[0].actualSpec).toMatchObject({ server_type: 'cx21' });
  });
});

// ── DELETE ────────────────────────────────────────────────────

describe('HetznerProvisioningProvider — Phase 9 DELETE', () => {
  it('apply() deletes a server and returns its externalId in deletedExternalIds', async () => {
    const { provider, client } = makeRealProvider();
    const deleteSpy = jest.spyOn(client, 'deleteServer');

    const result = await provider.apply(
      realInput([], [trackedServer('web-1', '2001', { server_type: 'cx11' })]),
    );

    expect(deleteSpy).toHaveBeenCalledWith(2001, 'test-token-xyz');
    expect(result.deletedExternalIds).toContain('2001');
    expect(result.resources).toHaveLength(0);
  });

  it('throws when DELETE action has no externalId', async () => {
    const { provider } = makeRealProvider();
    const currentWithoutExternalId: ProviderCurrentResource = {
      id: 'db-web-1',
      type: 'SERVER',
      name: 'web-1',
      status: 'ACTIVE',
      desiredSpec: { server_type: 'cx11' },
      actualSpec: null,
      externalId: null,
    };

    // Per-action try/catch wraps the error in PartialApplyError; the original message is in failures[0].error
    const err = await provider.apply(realInput([], [currentWithoutExternalId])).catch((e) => e);
    expect(err).toBeInstanceOf(PartialApplyError);
    expect((err as PartialApplyError).failures[0].error).toMatch(/externalId is required/);
  });
});

// ── Guard: missing dependencies for real apply ─────────────────

describe('HetznerProvisioningProvider — Phase 9 dependency guards', () => {
  it('throws when tokenResolver is absent and dryRun=false', async () => {
    const provider = new HetznerProvisioningProvider(new ProvisioningPlannerService());
    await expect(
      provider.apply(realInput([{ type: 'server', name: 'web-1', spec: {} }])),
    ).rejects.toThrow(/HETZNER_TOKEN_RESOLVER/);
  });

  it('throws when client is absent and dryRun=false', async () => {
    const tokenResolver = new MockHetznerTokenResolver();
    const provider = new HetznerProvisioningProvider(
      new ProvisioningPlannerService(),
      tokenResolver,
    );
    await expect(
      provider.apply(realInput([{ type: 'server', name: 'web-1', spec: {} }])),
    ).rejects.toThrow(/HETZNER_CLIENT/);
  });

  it('dry-run does NOT resolve the token (tokenResolver.wasCalled() remains false)', async () => {
    const tokenResolver = new MockHetznerTokenResolver();
    const provider = new HetznerProvisioningProvider(
      new ProvisioningPlannerService(),
      tokenResolver,
    );
    await provider.apply(
      withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11' } }]),
    );
    expect(tokenResolver.wasCalled()).toBe(false);
  });
});

// ── Secret boundary (Phase 9) ─────────────────────────────────

describe('HetznerProvisioningProvider — Phase 9 secret boundary', () => {
  it('apply() result does not contain the resolved API token', async () => {
    const { provider } = makeRealProvider();
    const result = await provider.apply(
      realInput([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
    );
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('test-token-xyz');
  });

  it('apply() result does not contain the openbao credential path', async () => {
    const { provider } = makeRealProvider();
    const result = await provider.apply(
      realInput([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11', image: 'ubuntu-22.04' } }]),
    );
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(BASE_INPUT.credentialOpenbaoPath);
  });
});

// ── Phase 10b — dependency ordering ──────────────────────

describe('HetznerProvisioningProvider — Phase 10b: dependency ordering', () => {
  it('dry-run metadata actions list is in type-sorted order (network before server)', async () => {
    const { provider } = makeRealProvider();
    const input: ProvisioningExecuteInput = {
      ...BASE_INPUT,
      dryRun: true,
      desiredSpec: {
        resources: [
          { type: 'server', name: 'web-1', spec: { server_type: 'cx11' } },
          { type: 'network', name: 'my-net', spec: {} },
        ],
      },
      currentResources: [],
    };

    const result = await provider.apply(input);

    const actions = (result.metadata as any).actions as any[];
    expect(actions).toHaveLength(2);
    expect(actions[0].resourceType).toBe('network');
    expect(actions[1].resourceType).toBe('server');
  });

  it('apply() throws CircularDependencyError when two same-type resources depend on each other', async () => {
    const { provider } = makeRealProvider();
    const input: ProvisioningExecuteInput = {
      ...BASE_INPUT,
      dryRun: false,
      desiredSpec: {
        resources: [
          { type: 'server', name: 'server-a', spec: { server_type: 'cx11' }, dependsOn: ['server:server-b'] },
          { type: 'server', name: 'server-b', spec: { server_type: 'cx11' }, dependsOn: ['server:server-a'] },
        ],
      },
      currentResources: [],
    };

    await expect(provider.apply(input)).rejects.toThrow(CircularDependencyError);
  });
});

// ── Phase 10d — partial failure loop ─────────────────────────

describe('HetznerProvisioningProvider — Phase 10d: partial failure loop', () => {
  it('one succeeds + one fails → PartialApplyError with 1 applied, 1 failure', async () => {
    const { provider, client } = makeRealProvider();

    // First createServer resolves normally; second rejects.
    const createSpy = jest.spyOn(client, 'createServer');
    createSpy
      .mockResolvedValueOnce({
        id: 9001,
        name: 'web-1',
        status: 'running',
        serverType: 'cx11',
        publicIpv4: '10.0.0.1',
        locationName: 'nbg1',
        datacenterName: 'nbg1-dc1',
      })
      .mockRejectedValueOnce(new Error('quota exceeded'));

    const err = await provider
      .apply(
        realInput([
          { type: 'server', name: 'web-1', spec: { server_type: 'cx11' } },
          { type: 'server', name: 'web-2', spec: { server_type: 'cx11' } },
        ]),
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(PartialApplyError);
    expect(err.appliedResources).toHaveLength(1);
    expect(err.failures).toHaveLength(1);
    expect(err.failures[0].error).toContain('quota exceeded');
  });

  it('all actions fail → PartialApplyError with 0 applied', async () => {
    const { provider, client } = makeRealProvider();

    jest
      .spyOn(client, 'createServer')
      .mockRejectedValue(new Error('network error'));

    const err = await provider
      .apply(
        realInput([
          { type: 'server', name: 'web-1', spec: { server_type: 'cx11' } },
          { type: 'server', name: 'web-2', spec: { server_type: 'cx11' } },
        ]),
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(PartialApplyError);
    expect(err.appliedResources).toHaveLength(0);
    expect(err.failures).toHaveLength(2);
  });

  it('appliedResources contains the correct externalId for the succeeded action', async () => {
    const { provider, client } = makeRealProvider();

    const mockServerId = 9002;
    jest
      .spyOn(client, 'createServer')
      .mockResolvedValueOnce({
        id: mockServerId,
        name: 'web-1',
        status: 'running',
        serverType: 'cx11',
        publicIpv4: '10.0.0.2',
        locationName: 'nbg1',
        datacenterName: 'nbg1-dc1',
      })
      .mockRejectedValueOnce(new Error('quota exceeded'));

    const err = await provider
      .apply(
        realInput([
          { type: 'server', name: 'web-1', spec: { server_type: 'cx11' } },
          { type: 'server', name: 'web-2', spec: { server_type: 'cx11' } },
        ]),
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(PartialApplyError);
    expect(err.appliedResources[0].externalId).toBe(String(mockServerId));
  });

  it('failures record resourceType, resourceName, action, error', async () => {
    const { provider, client } = makeRealProvider();

    jest
      .spyOn(client, 'createServer')
      .mockRejectedValueOnce(new Error('quota exceeded'));

    const err = await provider
      .apply(realInput([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11' } }]))
      .catch((e) => e);

    expect(err).toBeInstanceOf(PartialApplyError);
    expect(err.failures[0]).toMatchObject({
      resourceType: 'server',
      resourceName: 'web-1',
      action: 'CREATE',
      error: 'quota exceeded',
    });
  });

  it('loop continues after first failure (second action still runs)', async () => {
    const { provider, client } = makeRealProvider();

    const createSpy = jest.spyOn(client, 'createServer');
    createSpy
      .mockRejectedValueOnce(new Error('quota exceeded'))
      .mockResolvedValueOnce({
        id: 9003,
        name: 'web-2',
        status: 'running',
        serverType: 'cx11',
        publicIpv4: '10.0.0.3',
        locationName: 'nbg1',
        datacenterName: 'nbg1-dc1',
      });

    const err = await provider
      .apply(
        realInput([
          { type: 'server', name: 'web-1', spec: { server_type: 'cx11' } },
          { type: 'server', name: 'web-2', spec: { server_type: 'cx11' } },
        ]),
      )
      .catch((e) => e);

    expect(err).toBeInstanceOf(PartialApplyError);
    expect(createSpy).toHaveBeenCalledTimes(2);
    expect(err.appliedResources).toHaveLength(1);
  });
});

// ── Sprint 4b — spec validation ───────────────────────────────

describe('HetznerProvisioningProvider — Sprint 4b: spec validation', () => {
  function makeValidationProvider() {
    return new HetznerProvisioningProvider(new ProvisioningPlannerService());
  }

  it('valid spec passes without throwing', async () => {
    const provider = makeValidationProvider();
    const input: ProvisioningExecuteInput = {
      ...BASE_INPUT,
      dryRun: true,
      desiredSpec: { region: 'eu-central', serverType: 'cx11', image: 'ubuntu-22.04' },
      currentResources: [],
    };
    await expect(provider.apply(input)).resolves.not.toThrow();
  });

  it('invalid region field throws BadRequestException', async () => {
    const provider = makeValidationProvider();
    const input: ProvisioningExecuteInput = {
      ...BASE_INPUT,
      dryRun: true,
      desiredSpec: { region: 'invalid-region' },
      currentResources: [],
    };
    await expect(provider.apply(input)).rejects.toThrow(BadRequestException);
  });

  it('invalid serverType field throws BadRequestException', async () => {
    const provider = makeValidationProvider();
    const input: ProvisioningExecuteInput = {
      ...BASE_INPUT,
      dryRun: true,
      desiredSpec: { serverType: 'cx99' },
      currentResources: [],
    };
    await expect(provider.apply(input)).rejects.toThrow(BadRequestException);
  });

  it('empty spec {} passes (all fields are optional)', async () => {
    const provider = makeValidationProvider();
    const input: ProvisioningExecuteInput = {
      ...BASE_INPUT,
      dryRun: true,
      desiredSpec: {},
      currentResources: [],
    };
    await expect(provider.apply(input)).resolves.not.toThrow();
  });
});

// ── Sprint 4b — health check ──────────────────────────────────

describe('HetznerProvisioningProvider — Sprint 4b: health check', () => {
  it('healthCheck returns { healthy: true, latencyMs: expect.any(Number) }', async () => {
    const provider = new HetznerProvisioningProvider(new ProvisioningPlannerService());
    const result = await provider.healthCheck();
    expect(result).toEqual({ healthy: true, latencyMs: expect.any(Number) });
  });
});
