import {
  ProvisioningPlannerService,
  CurrentResource,
  PlannerInput,
} from './provisioning-planner.service';

// ── Factories ────────────────────────────────────────────────

function makeSvc() {
  return new ProvisioningPlannerService();
}

const BASE: Omit<PlannerInput, 'desiredSpec' | 'currentResources'> = {
  projectId: 'proj-1',
  provider: 'hetzner',
  region: 'eu-central',
  datacenter: null,
};

function desired(resources: Array<{ type: string; name: string; spec?: Record<string, unknown> }>) {
  return { resources: resources.map((r) => ({ ...r, spec: r.spec ?? {} })) };
}

function current(
  type: string,
  name: string,
  desiredSpec: Record<string, unknown> = {},
): CurrentResource {
  return {
    id: `res-${type}-${name}`,
    type,
    name,
    status: 'ACTIVE',
    desiredSpec,
    actualSpec: null,
    externalId: null,
  };
}

// ── Empty → create ───────────────────────────────────────────

describe('ProvisioningPlannerService — empty → create', () => {
  it('produces CREATE for a desired resource when current state is empty', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([{ type: 'server', name: 'web-1', spec: { size: 'cx11' } }]),
      currentResources: [],
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      action: 'CREATE',
      resourceType: 'server',
      resourceName: 'web-1',
      desiredSpec: { size: 'cx11' },
    });
    expect(plan.summary).toEqual({ create: 1, update: 0, delete: 0, noop: 0 });
  });

  it('produces CREATE for each desired resource when multiple are absent', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([
        { type: 'server', name: 'web-1' },
        { type: 'firewall', name: 'main-fw' },
      ]),
      currentResources: [],
    });

    expect(plan.summary).toEqual({ create: 2, update: 0, delete: 0, noop: 0 });
  });
});

// ── Same → noop ──────────────────────────────────────────────

describe('ProvisioningPlannerService — same → noop', () => {
  it('produces NOOP when spec matches current desiredSpec exactly', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([{ type: 'server', name: 'web-1', spec: { size: 'cx11' } }]),
      currentResources: [current('server', 'web-1', { size: 'cx11' })],
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].action).toBe('NOOP');
    expect(plan.summary).toEqual({ create: 0, update: 0, delete: 0, noop: 1 });
  });

  it('NOOP includes both desiredSpec and currentSpec for observability', () => {
    const spec = { size: 'cx11', region: 'eu-central' };
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([{ type: 'server', name: 'web-1', spec }]),
      currentResources: [current('server', 'web-1', spec)],
    });

    expect(plan.actions[0].desiredSpec).toEqual(spec);
    expect(plan.actions[0].currentSpec).toEqual(spec);
  });
});

// ── Spec change → update ──────────────────────────────────────

describe('ProvisioningPlannerService — spec change → update', () => {
  it('produces UPDATE when desired spec differs from current desiredSpec', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([{ type: 'server', name: 'web-1', spec: { size: 'cx21' } }]),
      currentResources: [current('server', 'web-1', { size: 'cx11' })],
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'server',
      resourceName: 'web-1',
      desiredSpec: { size: 'cx21' },
      currentSpec: { size: 'cx11' },
    });
    expect(plan.summary).toEqual({ create: 0, update: 1, delete: 0, noop: 0 });
  });

  it('detects nested spec changes', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([{ type: 'server', name: 'web-1', spec: { config: { memory: '4GB' } } }]),
      currentResources: [current('server', 'web-1', { config: { memory: '2GB' } })],
    });

    expect(plan.actions[0].action).toBe('UPDATE');
  });

  it('detects a new key being added to the spec', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([{ type: 'server', name: 'web-1', spec: { size: 'cx11', extra: 'yes' } }]),
      currentResources: [current('server', 'web-1', { size: 'cx11' })],
    });

    expect(plan.actions[0].action).toBe('UPDATE');
  });
});

// ── Missing desired → delete ──────────────────────────────────

describe('ProvisioningPlannerService — missing desired → delete', () => {
  it('produces DELETE for a current resource absent from desired state', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([]),
      currentResources: [current('server', 'web-1', { size: 'cx11' })],
    });

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      action: 'DELETE',
      resourceType: 'server',
      resourceName: 'web-1',
      currentSpec: { size: 'cx11' },
    });
    expect(plan.summary).toEqual({ create: 0, update: 0, delete: 1, noop: 0 });
  });

  it('DELETE does not include desiredSpec (there is none)', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([]),
      currentResources: [current('server', 'web-1')],
    });

    expect(plan.actions[0].desiredSpec).toBeUndefined();
  });
});

// ── Mixed plan ────────────────────────────────────────────────

describe('ProvisioningPlannerService — mixed plan', () => {
  it('produces correct mix of CREATE/UPDATE/DELETE/NOOP', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([
        { type: 'server', name: 'web-1', spec: { size: 'cx11' } },     // unchanged → NOOP
        { type: 'server', name: 'web-2', spec: { size: 'cx21' } },     // spec change → UPDATE
        { type: 'firewall', name: 'main-fw', spec: { rules: [] } },    // new → CREATE
      ]),
      currentResources: [
        current('server', 'web-1', { size: 'cx11' }),                   // no change
        current('server', 'web-2', { size: 'cx11' }),                   // different spec
        current('server', 'old-server', { size: 'cx11' }),              // not in desired → DELETE
      ],
    });

    expect(plan.summary).toEqual({ create: 1, update: 1, delete: 1, noop: 1 });
    expect(plan.actions.find((a) => a.action === 'CREATE')?.resourceName).toBe('main-fw');
    expect(plan.actions.find((a) => a.action === 'UPDATE')?.resourceName).toBe('web-2');
    expect(plan.actions.find((a) => a.action === 'DELETE')?.resourceName).toBe('old-server');
    expect(plan.actions.find((a) => a.action === 'NOOP')?.resourceName).toBe('web-1');
  });
});

// ── Edge cases ────────────────────────────────────────────────

describe('ProvisioningPlannerService — edge cases', () => {
  it('returns empty plan when both desired and current are empty', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([]),
      currentResources: [],
    });

    expect(plan.actions).toHaveLength(0);
    expect(plan.summary).toEqual({ create: 0, update: 0, delete: 0, noop: 0 });
  });

  it('is case-insensitive on resourceType matching (SERVER matches server)', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: desired([{ type: 'SERVER', name: 'web-1', spec: { size: 'cx11' } }]),
      currentResources: [current('server', 'web-1', { size: 'cx11' })],
    });

    expect(plan.actions[0].action).toBe('NOOP');
  });

  it('treats a desiredSpec with no resources key as empty desired state', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: { other: 'data' },
      currentResources: [current('server', 'web-1')],
    });

    // No desired resources → all current become DELETE
    expect(plan.summary.delete).toBe(1);
    expect(plan.summary.create).toBe(0);
  });

  it('treats a desiredSpec with non-array resources as empty desired state', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: { resources: 'invalid' },
      currentResources: [current('server', 'web-1')],
    });

    expect(plan.summary.delete).toBe(1);
  });

  it('skips malformed resource entries in desiredSpec', () => {
    const plan = makeSvc().plan({
      ...BASE,
      desiredSpec: {
        resources: [
          { type: 'server', name: 'web-1', spec: { size: 'cx11' } }, // valid
          { type: 'server' },                                          // missing name → skip
          null,                                                        // null → skip
        ],
      },
      currentResources: [],
    });

    expect(plan.summary.create).toBe(1);
  });

  it('does not mutate currentResources array during planning', () => {
    const curr = [current('server', 'web-1', { size: 'cx11' })];
    const originalLength = curr.length;
    makeSvc().plan({
      ...BASE,
      desiredSpec: desired([]),
      currentResources: curr,
    });

    expect(curr).toHaveLength(originalLength);
  });
});
