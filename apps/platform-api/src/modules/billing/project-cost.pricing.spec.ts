import {
  DEFAULT_INFRA_COST_CONFIG,
  HOURS_PER_MONTH,
  describePeriod,
  mergeInfraCostConfig,
  priceProject,
  resolveComputeTier,
  sumProjectCosts,
  tierHourlyRawUsd,
  type ProjectUsageInput,
} from './project-cost.pricing';

const GB = 1024 ** 3;
const cfg = DEFAULT_INFRA_COST_CONFIG;
// October 2026: 31 days = 744 hours. "now" is the 16th → 360 hours elapsed.
const period = { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') };
const now = new Date('2026-10-16T00:00:00Z');

const baseProject = (over: Partial<ProjectUsageInput> = {}): ProjectUsageInput => ({
  id: 'p1',
  name: 'Demo',
  slug: 'demo',
  status: 'ACTIVE',
  createdAt: new Date('2026-05-01T00:00:00Z'),
  dbSizeBytes: 0,
  storageBytes: 0,
  apiRequests: 0,
  bandwidthBytes: 0,
  ...over,
});

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

describe('tierHourlyRawUsd', () => {
  it('prices the whole host for a tier that reserves all of it', () => {
    const xl = cfg.computeTiers.find((t) => t.name === 'XL')!;
    expect(close(tierHourlyRawUsd(xl, cfg.server), 17 / HOURS_PER_MONTH)).toBe(true);
  });

  it('uses the larger of the CPU and RAM share', () => {
    const lopsided = { name: 'ram-heavy', vcpu: 0.25, memoryGb: 4 }; // 1/16 cpu vs 1/2 ram
    expect(close(tierHourlyRawUsd(lopsided, cfg.server), (17 * 0.5) / HOURS_PER_MONTH)).toBe(true);
  });
});

describe('resolveComputeTier', () => {
  it('sizes shared projects by database footprint', () => {
    expect(resolveComputeTier(cfg, { dbSizeBytes: 0 }).name).toBe('Micro');
    expect(resolveComputeTier(cfg, { dbSizeBytes: 3 * GB }).name).toBe('Small');
    expect(resolveComputeTier(cfg, { dbSizeBytes: 7 * GB }).name).toBe('Medium');
    expect(resolveComputeTier(cfg, { dbSizeBytes: 25 * GB }).name).toBe('Large');
    expect(resolveComputeTier(cfg, { dbSizeBytes: 60 * GB }).name).toBe('XL');
  });

  it('gives dedicated projects the smallest tier that covers their reservation', () => {
    expect(resolveComputeTier(cfg, { dbSizeBytes: 0, dedicatedMemoryMb: 1024, dedicatedCpuMillis: 1000 }).name).toBe('Medium');
    expect(resolveComputeTier(cfg, { dbSizeBytes: 0, dedicatedMemoryMb: 3000, dedicatedCpuMillis: 500 }).name).toBe('Large');
    // Nothing covers a 64 GB reservation → the largest tier.
    expect(resolveComputeTier(cfg, { dbSizeBytes: 0, dedicatedMemoryMb: 65536, dedicatedCpuMillis: 0 }).name).toBe('XL');
  });
});

describe('priceProject', () => {
  it('bills compute for the hours the project was active and projects to period end', () => {
    const r = priceProject(cfg, period, baseProject(), now);
    const compute = r.lines.find((l) => l.key === 'compute')!;
    const hourly = tierHourlyRawUsd(cfg.computeTiers[0], cfg.server);
    expect(r.computeTier).toBe('Micro');
    expect(r.activeHours).toBe(360);
    expect(close(compute.rawUsd, hourly * 360, 1e-4)).toBe(true);
    expect(close(compute.pricedUsd, hourly * 360 * 2.5, 1e-4)).toBe(true);
    expect(close(compute.projectedRawUsd, hourly * 744, 1e-4)).toBe(true);
  });

  it('prorates storage to the time the project existed in the period', () => {
    const r = priceProject(cfg, period, baseProject({ dbSizeBytes: 10 * GB }), now);
    const db = r.lines.find((l) => l.key === 'database')!;
    // 10 GB × $0.057/GB-month × (360 h / 730 h-per-month)
    expect(close(db.rawUsd, 10 * 0.057 * (360 / HOURS_PER_MONTH), 1e-4)).toBe(true);
    // Full-period projection: 744 h worth.
    expect(close(db.projectedRawUsd, 10 * 0.057 * (744 / HOURS_PER_MONTH), 1e-4)).toBe(true);
    expect(db.detail).toBe('10.00 GB');
    expect(r.computeTier).toBe('Medium');
  });

  it('stops compute for a paused project but keeps charging its storage', () => {
    const r = priceProject(cfg, period, baseProject({ status: 'PAUSED', storageBytes: 2 * GB }), now);
    expect(r.lines.find((l) => l.key === 'compute')!.rawUsd).toBe(0);
    expect(r.lines.find((l) => l.key === 'compute')!.projectedRawUsd).toBe(0);
    expect(r.lines.find((l) => l.key === 'storage')!.rawUsd).toBeGreaterThan(0);
  });

  it('only counts hours after a mid-period creation date', () => {
    const r = priceProject(cfg, period, baseProject({ createdAt: new Date('2026-10-10T00:00:00Z') }), now);
    expect(r.activeHours).toBe(144); // 6 days
    const compute = r.lines.find((l) => l.key === 'compute')!;
    const hourly = tierHourlyRawUsd(cfg.computeTiers[0], cfg.server);
    expect(close(compute.projectedRawUsd, hourly * 22 * 24, 1e-4)).toBe(true);
  });

  it('never projects metered usage from less than a day of data', () => {
    const custom = { ...cfg, egressUsdPerGb: 1 };
    const oneHourIn = new Date('2026-10-01T01:00:00Z');
    const r = priceProject(custom, period, baseProject({ bandwidthBytes: 1 * GB }), oneHourIn);
    const egress = r.lines.find((l) => l.key === 'egress')!;
    expect(egress.rawUsd).toBe(1);
    // Divisor floors at one day (24/744), so ×31 instead of ×744.
    expect(close(egress.projectedRawUsd, 31, 1e-3)).toBe(true);
  });

  it('applies the markup to every line and to the totals', () => {
    const r = priceProject(cfg, period, baseProject({ dbSizeBytes: 1 * GB, storageBytes: 1 * GB }), now);
    for (const l of r.lines) {
      // Lines round to 4 decimals before the comparison, so allow that slack ×2.5.
      expect(close(l.pricedUsd, l.rawUsd * 2.5, 5e-4)).toBe(true);
    }
    expect(close(r.pricedUsd, r.rawUsd * 2.5, 1e-3)).toBe(true);
    expect(close(r.projectedPricedUsd, r.projectedRawUsd * 2.5, 1e-3)).toBe(true);
  });

  it('charges nothing for API requests while the rate is zero', () => {
    const r = priceProject(cfg, period, baseProject({ apiRequests: 2_500_000 }), now);
    const api = r.lines.find((l) => l.key === 'api_requests')!;
    expect(api.rawUsd).toBe(0);
    expect(api.detail).toBe('2,500,000 requests');
  });
});

describe('sumProjectCosts', () => {
  it('adds up every project', () => {
    const a = priceProject(cfg, period, baseProject({ id: 'a', dbSizeBytes: 1 * GB }), now);
    const b = priceProject(cfg, period, baseProject({ id: 'b', dbSizeBytes: 2 * GB }), now);
    const t = sumProjectCosts([a, b]);
    expect(close(t.rawUsd, a.rawUsd + b.rawUsd, 1e-4)).toBe(true);
    expect(close(t.projectedPricedUsd, a.projectedPricedUsd + b.projectedPricedUsd, 1e-4)).toBe(true);
  });
});

describe('describePeriod', () => {
  it('reports elapsed share and days left', () => {
    const p = describePeriod(period, now);
    expect(p.totalHours).toBe(744);
    expect(p.elapsedHours).toBe(360);
    expect(p.daysLeft).toBe(16);
    expect(close(p.elapsedFraction, 360 / 744)).toBe(true);
  });
});

describe('mergeInfraCostConfig', () => {
  it('falls back to defaults for missing or invalid numbers', () => {
    const m = mergeInfraCostConfig({ markup: -1, server: { monthlyCostUsd: 40 }, diskUsdPerGbMonth: 'x' });
    expect(m.markup).toBe(2.5);
    expect(m.server.monthlyCostUsd).toBe(40);
    expect(m.server.vcpu).toBe(4);
    expect(m.diskUsdPerGbMonth).toBe(0.057);
  });

  it('accepts a zero rate but not a negative one', () => {
    expect(mergeInfraCostConfig({ egressUsdPerGb: 0 }).egressUsdPerGb).toBe(0);
    expect(mergeInfraCostConfig({ egressUsdPerGb: -3 }).egressUsdPerGb).toBe(0.0011);
  });

  it('drops malformed tiers and keeps the defaults when none survive', () => {
    const m = mergeInfraCostConfig({ computeTiers: [{ name: '', vcpu: 1, memoryGb: 1 }, { name: 'ok', vcpu: 0, memoryGb: 1 }] });
    expect(m.computeTiers).toEqual(DEFAULT_INFRA_COST_CONFIG.computeTiers);
    const kept = mergeInfraCostConfig({ computeTiers: [{ name: ' Nano ', vcpu: 0.1, memoryGb: 0.25 }] });
    expect(kept.computeTiers).toEqual([{ name: 'Nano', vcpu: 0.1, memoryGb: 0.25 }]);
  });
});
