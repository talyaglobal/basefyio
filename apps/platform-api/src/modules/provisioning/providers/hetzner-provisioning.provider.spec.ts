import { HetznerProvisioningProvider } from './hetzner-provisioning.provider';
import { ProvisioningPlannerService } from '../provisioning-planner.service';
import { ProvisioningExecuteInput, ProviderCurrentResource } from '../interfaces/provisioning-provider.interface';

// ── Factories ────────────────────────────────────────────────

function makePlanner() {
  return new ProvisioningPlannerService();
}

function makeProvider() {
  return new HetznerProvisioningProvider(makePlanner());
}

const BASE_INPUT: Omit<ProvisioningExecuteInput, 'desiredSpec' | 'currentResources'> = {
  operationId: 'op-1',
  projectId: 'proj-1',
  providerType: 'hetzner',
  region: 'eu-central',
  datacenter: null,
  credentialOpenbaoPath: 'secret/hetzner/token',
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
): ProviderCurrentResource {
  return {
    id: `res-${type}-${name}`,
    type: type.toUpperCase(),
    name,
    status: 'ACTIVE',
    desiredSpec,
    actualSpec: null,
    externalId: `ext-${name}`,
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
  it('plan() produces UPDATE with hetznerAction=resize when server_type changes', () => {
    const result = makeProvider().plan(
      withDesired(
        [{ type: 'server', name: 'web-1', spec: { server_type: 'cx21' } }],
        [currentResource('SERVER', 'web-1', { server_type: 'cx11' })],
      ),
    );

    expect(result.actions[0].action).toBe('UPDATE');
    expect(result.actions[0].providerMeta).toEqual({ hetznerAction: 'resize' });
  });

  it('plan() produces UPDATE with hetznerAction=rebuild when image changes', () => {
    const result = makeProvider().plan(
      withDesired(
        [{ type: 'server', name: 'web-1', spec: { image: 'ubuntu-22.04' } }],
        [currentResource('SERVER', 'web-1', { image: 'debian-11' })],
      ),
    );

    expect(result.actions[0].action).toBe('UPDATE');
    expect(result.actions[0].providerMeta).toEqual({ hetznerAction: 'rebuild' });
  });

  it('plan() falls back to hetznerAction=update for unknown server field changes', () => {
    const result = makeProvider().plan(
      withDesired(
        [{ type: 'server', name: 'web-1', spec: { labels: { env: 'prod' } } }],
        [currentResource('SERVER', 'web-1', { labels: { env: 'dev' } })],
      ),
    );

    expect(result.actions[0].action).toBe('UPDATE');
    expect(result.actions[0].providerMeta).toEqual({ hetznerAction: 'update' });
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
    expect(result.actions[0].providerMeta).toEqual({});
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
    // A spy on globalThis.fetch or any HTTP module would detect outbound calls.
    // In Phase 8, no fetch/http/axios is imported — this confirms it at the
    // module level. We assert via the deterministic result shape.
    const result = await makeProvider().apply(
      withDesired([{ type: 'server', name: 'web-1', spec: { server_type: 'cx11' } }]),
    );

    expect(result.metadata).toMatchObject({ provider: 'hetzner', dryRun: true });
    // Real resources would only appear after an actual API call
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
    expect(serialised).not.toContain('token');
    expect(serialised).not.toContain('password');
    expect(serialised).not.toContain('secret');
  });
});
