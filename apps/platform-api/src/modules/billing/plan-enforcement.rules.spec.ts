import {
  DEFAULT_ENFORCEMENT_MODES,
  EnforcementModes,
  evaluatePlanUsage,
  parseEnforcementModes,
  usageLevel,
  validateEnforcementPatch,
} from './plan-enforcement.rules';

const GB = BigInt(1024 ** 3);
const NOW = new Date('2026-11-23T12:00:00Z');
const THIS_MONTH = new Date('2026-11-01T00:00:00Z');

const free = {
  name: 'free',
  displayName: 'Free',
  priceMonthly: 0,
  features: null,
  maxApiRequests: 50_000,
  maxBandwidthBytes: (GB).toString(),
  maxMau: 50_000,
  maxDbSizeBytes: (GB).toString(),
};
const legacy = { name: 'legacy', priceMonthly: 0, features: { grandfathered: true }, maxApiRequests: null, maxDbSizeBytes: null };
const enterprise = {
  name: 'enterprise',
  priceMonthly: 0,
  features: { enterprise: true },
  maxApiRequests: null,
  maxBandwidthBytes: null,
  maxMau: null,
  maxDbSizeBytes: null,
};

const usage = (o: Partial<{ api: number; bw: bigint; mau: number; db: bigint; periodStart: Date }> = {}) => ({
  apiRequestsMonth: o.api ?? 0,
  bandwidthMonth: o.bw ?? BigInt(0),
  mauCount: o.mau ?? 0,
  dbSizeBytes: o.db ?? BigInt(0),
  periodStart: o.periodStart ?? THIS_MONTH,
});

const ENFORCE: EnforcementModes = { api_requests: 'enforce', egress: 'enforce', mau: 'enforce', db_size: 'enforce' };
const byMetric = (s: ReturnType<typeof evaluatePlanUsage>, m: string) => s.metrics.find((x) => x.metric === m)!;

describe('parseEnforcementModes', () => {
  it('defaults to warn for every metric', () => {
    expect(parseEnforcementModes(undefined)).toEqual(DEFAULT_ENFORCEMENT_MODES);
    expect(parseEnforcementModes(null)).toEqual({ api_requests: 'warn', egress: 'warn', mau: 'warn', db_size: 'warn' });
  });

  it('takes known metrics and modes, ignores the rest', () => {
    expect(parseEnforcementModes({ api_requests: 'enforce', db_size: 'off', mau: 'block', other: 'enforce' })).toEqual({
      api_requests: 'enforce',
      egress: 'warn',
      mau: 'warn',
      db_size: 'off',
    });
  });

  it('accepts one mode for every metric', () => {
    expect(parseEnforcementModes('enforce')).toEqual(ENFORCE);
    expect(parseEnforcementModes('nonsense')).toEqual(DEFAULT_ENFORCEMENT_MODES);
  });

  it('validates a root change strictly', () => {
    expect(validateEnforcementPatch({ api_requests: 'enforce' })).toEqual({ api_requests: 'enforce' });
    expect(validateEnforcementPatch({ api_requests: 'block' })).toBeNull();
    expect(validateEnforcementPatch({ storage: 'enforce' })).toBeNull();
    expect(validateEnforcementPatch({})).toBeNull();
    expect(validateEnforcementPatch('enforce')).toBeNull();
  });
});

describe('usageLevel', () => {
  it('has the 80% warning, the 100% limit and the 10% grace', () => {
    const cap = BigInt(1000);
    expect(usageLevel(BigInt(799), cap)).toBe('ok');
    expect(usageLevel(BigInt(800), cap)).toBe('warning');
    expect(usageLevel(BigInt(1000), cap)).toBe('limit');
    expect(usageLevel(BigInt(1099), cap)).toBe('limit');
    expect(usageLevel(BigInt(1100), cap)).toBe('over_grace');
  });
});

describe('evaluatePlanUsage', () => {
  it('never affects a team below its limits, in any mode', () => {
    const below = usage({ api: 49_999, bw: GB - BigInt(1), mau: 49_999, db: GB - BigInt(1) });
    for (const mode of ['off', 'warn', 'enforce'] as const) {
      const modes = { api_requests: mode, egress: mode, mau: mode, db_size: mode };
      const s = evaluatePlanUsage(free, below, modes, NOW);
      expect(s.metrics.every((m) => !m.blocking && !m.wouldBlock)).toBe(true);
    }
  });

  it('blocks only past the grace, and only in enforce mode', () => {
    const over = usage({ api: 55_000 });
    expect(byMetric(evaluatePlanUsage(free, over, ENFORCE, NOW), 'api_requests')).toMatchObject({
      level: 'over_grace',
      blocking: true,
      percent: 110,
    });
    const warn = byMetric(evaluatePlanUsage(free, over, DEFAULT_ENFORCEMENT_MODES, NOW), 'api_requests');
    expect(warn).toMatchObject({ wouldBlock: true, blocking: false, mode: 'warn' });
    const inGrace = byMetric(evaluatePlanUsage(free, usage({ api: 54_999 }), ENFORCE, NOW), 'api_requests');
    expect(inGrace).toMatchObject({ level: 'limit', blocking: false });
  });

  it('does nothing for a metric that is off', () => {
    const s = evaluatePlanUsage(free, usage({ db: GB * BigInt(5) }), { ...ENFORCE, db_size: 'off' }, NOW);
    expect(byMetric(s, 'db_size')).toMatchObject({ blocking: false, wouldBlock: false, level: 'ok' });
  });

  it('exempts Legacy and grandfathered plans whatever their usage', () => {
    const huge = usage({ api: 10 ** 9, db: GB * BigInt(1000) });
    for (const plan of [legacy, { ...free, name: 'old-free', features: { grandfathered: true } }]) {
      const s = evaluatePlanUsage(plan as any, huge, ENFORCE, NOW);
      expect(s.exempt).toBe(true);
      expect(s.metrics.some((m) => m.blocking || m.wouldBlock)).toBe(false);
    }
  });

  it('never blocks Enterprise with empty caps, and enforces a cap set on it', () => {
    const huge = usage({ api: 10 ** 9, db: GB * BigInt(1000) });
    const s = evaluatePlanUsage(enterprise as any, huge, ENFORCE, NOW);
    expect(s.exempt).toBe(false);
    expect(s.metrics.some((m) => m.blocking)).toBe(false);
    expect(s.metrics.every((m) => m.limit === null)).toBe(true);
    const capped = evaluatePlanUsage({ ...enterprise, maxApiRequests: 1_000_000 } as any, huge, ENFORCE, NOW);
    expect(byMetric(capped, 'api_requests').blocking).toBe(true);
  });

  it('treats a cap of zero as not set, so a misconfigured row cannot lock a team out', () => {
    const s = evaluatePlanUsage({ ...free, maxApiRequests: 0 }, usage({ api: 5 }), ENFORCE, NOW);
    expect(byMetric(s, 'api_requests')).toMatchObject({ limit: null, blocking: false });
  });

  it('never acts on monthly counters from an earlier month (reset not run yet), but still on database size', () => {
    const stale = usage({ api: 10 ** 7, mau: 10 ** 7, db: GB * BigInt(5), periodStart: new Date('2026-10-01T00:00:00Z') });
    const s = evaluatePlanUsage(free, stale, ENFORCE, NOW);
    expect(byMetric(s, 'api_requests').blocking).toBe(false);
    expect(byMetric(s, 'mau').blocking).toBe(false);
    expect(byMetric(s, 'db_size').blocking).toBe(true);
  });

  it('a team without a plan or without usage is never blocked', () => {
    expect(evaluatePlanUsage(null, usage({ api: 10 ** 9 }), ENFORCE, NOW).metrics.some((m) => m.blocking)).toBe(false);
    expect(evaluatePlanUsage(free, null, ENFORCE, NOW).metrics.some((m) => m.blocking)).toBe(false);
  });
});
