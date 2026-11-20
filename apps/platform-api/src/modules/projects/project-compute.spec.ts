import { computeOptionsFor, computeTierRefusal, dedicatedSizeFor } from './project-compute';

describe('compute tiers', () => {
  it('size dedicated tiers from the billing tier table', () => {
    expect(dedicatedSizeFor('shared')).toBeNull();
    expect(dedicatedSizeFor('micro')).toEqual({ cpuMillis: 250, memoryMb: 512 });
    expect(dedicatedSizeFor('xl')).toEqual({ cpuMillis: 4000, memoryMb: 8192 });
  });

  it('always allow shared compute', () => {
    expect(computeTierRefusal('shared', { planDedicated: false, planDisplayName: 'Free', regionHasCapacity: false })).toBeNull();
  });

  it('refuse a dedicated size on a plan without one, naming the plan', () => {
    expect(computeTierRefusal('micro', { planDedicated: false, planDisplayName: 'Free', regionHasCapacity: true })).toBe(
      'Dedicated compute is not available on the Free plan',
    );
  });

  it('refuse a dedicated size where the region has no room', () => {
    expect(computeTierRefusal('small', { planDedicated: true, planDisplayName: 'Pro', regionHasCapacity: false })).toBe(
      'Dedicated compute is not available in this region yet',
    );
    expect(computeTierRefusal('small', { planDedicated: true, planDisplayName: 'Pro', regionHasCapacity: true })).toBeNull();
  });

  it('offer shared plus five disabled tiers with a reason when nothing dedicated is available', () => {
    const free = computeOptionsFor({ planDedicated: false, planDisplayName: 'Free', regionHasCapacity: false });
    expect(free.dedicatedAvailable).toBe(false);
    expect(free.tiers.map((t) => t.id)).toEqual(['shared', 'micro', 'small', 'medium', 'large', 'xl']);
    expect(free.tiers[0]).toMatchObject({ available: true, reason: null });
    expect(free.tiers.slice(1).every((t) => !t.available && t.reason === 'Pro and above')).toBe(true);

    const pro = computeOptionsFor({ planDedicated: true, planDisplayName: 'Pro', regionHasCapacity: false });
    expect(pro.planAllowsDedicated).toBe(true);
    expect(pro.tiers.slice(1).every((t) => t.reason === 'Not available in this region yet')).toBe(true);
  });
});
