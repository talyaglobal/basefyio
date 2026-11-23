import { buildProjectResources, type ResourcesInput } from './project-resources';

const GB = BigInt(1024 ** 3);
const base: ResourcesInput = {
  plan: { name: 'free', displayName: 'Free', maxDbSizeBytes: GB, maxStorageBytes: GB * BigInt(2) },
  projectDbSizeBytes: BigInt(50 * 1024 * 1024),
  projectStorageBytes: BigInt(1024),
  dbSizeMeasuredAt: new Date('2026-11-23T10:00:00Z'),
  storageMeasuredAt: null,
  orgDbSizeBytes: BigInt(200 * 1024 * 1024),
  orgStorageBytes: BigInt(4096),
  infrastructure: null,
};

describe('buildProjectResources', () => {
  it('reports shared compute in Nuremberg with the plan caps', () => {
    const r = buildProjectResources(base);
    expect(r.region).toEqual({ id: 'eu-central', label: 'EU (Germany)', location: 'Nuremberg, Germany' });
    expect(r.compute).toEqual({ mode: 'shared', label: 'Shared', vcpu: null, memoryGb: null, reserved: false });
    expect(r.database).toMatchObject({ projectBytes: 50 * 1024 * 1024, organizationBytes: 200 * 1024 * 1024, limitBytes: 1024 ** 3 });
    expect(r.storage.limitBytes).toBe(2 * 1024 ** 3);
    expect(r.storage.measuredAt).toBeNull();
    expect(r.database.measuredAt).toBe('2026-11-23T10:00:00.000Z');
    expect(r.uncapped).toBe(false);
  });

  it('is uncapped only when the plan has no database and no storage cap (Legacy)', () => {
    const legacy = buildProjectResources({
      ...base,
      plan: { name: 'legacy', displayName: 'Legacy', maxDbSizeBytes: null, maxStorageBytes: null },
    });
    expect(legacy.uncapped).toBe(true);
    expect(legacy.database.limitBytes).toBeNull();
    expect(legacy.storage.limitBytes).toBeNull();
  });

  it('never calls a project with no plan row unlimited', () => {
    const r = buildProjectResources({ ...base, plan: null });
    expect(r.uncapped).toBe(false);
    expect(r.plan).toBeNull();
  });

  it('reports the reserved CPU and memory of an active dedicated container', () => {
    const r = buildProjectResources({
      ...base,
      infrastructure: { status: 'ACTIVE', pgMemoryMb: 2048, pgCpuMillis: 1000 },
    });
    expect(r.compute).toEqual({ mode: 'dedicated', label: 'Medium', vcpu: 1, memoryGb: 2, reserved: true });
  });

  it('treats a container that is not active as shared', () => {
    const r = buildProjectResources({
      ...base,
      infrastructure: { status: 'PROVISIONING', pgMemoryMb: 2048, pgCpuMillis: 1000 },
    });
    expect(r.compute.mode).toBe('shared');
  });
});
