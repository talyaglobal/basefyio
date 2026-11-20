import { invoiceOutstanding, isCardExempt, planLimitFindings, planRequiresCard } from './billing-plan-rules';

const GB = 1024 ** 3;
const free = {
  name: 'free',
  priceMonthly: 0,
  maxProjects: 5,
  maxTeamMembers: 3,
  maxStorageBytes: BigInt(2 * GB),
  maxDbSizeBytes: BigInt(1 * GB),
  maxApiRequests: 500_000,
  maxBandwidthBytes: BigInt(2 * GB),
  maxMau: 50_000,
};
const within = {
  projects: 5,
  members: 3,
  storageBytes: BigInt(GB),
  dbSizeBytes: BigInt(GB),
  apiRequestsMonth: 10,
  bandwidthMonth: BigInt(0),
  mau: 0,
};

describe('card rules', () => {
  it('requires a card on Pro and Business', () => {
    expect(planRequiresCard({ name: 'pro', priceMonthly: 2000, features: { dailyBackups: true } })).toBe(true);
    expect(planRequiresCard({ name: 'business', priceMonthly: 10000 })).toBe(true);
  });

  it('does not require one on Free, legacy or a grandfathered plan', () => {
    expect(planRequiresCard({ name: 'free', priceMonthly: 0 })).toBe(false);
    expect(planRequiresCard({ name: 'legacy', priceMonthly: 0, features: { grandfathered: true } })).toBe(false);
    expect(planRequiresCard({ name: 'custom', priceMonthly: 5000, features: { grandfathered: true } })).toBe(false);
  });

  it('exempts legacy by name and grandfathered by feature only', () => {
    expect(isCardExempt({ name: 'legacy', priceMonthly: 0 })).toBe(true);
    expect(isCardExempt({ name: 'pro', priceMonthly: 2000, features: { grandfathered: true } })).toBe(true);
    expect(isCardExempt({ name: 'pro', priceMonthly: 2000, features: { grandfathered: 'yes' } })).toBe(false);
    expect(isCardExempt({ name: 'free', priceMonthly: 0, features: null })).toBe(false);
  });

  it('counts only the unpaid part of unpaid invoices', () => {
    expect(invoiceOutstanding({ status: 'open', amountDue: 2000, amountPaid: 500 })).toBe(1500);
    expect(invoiceOutstanding({ status: 'PAYMENT_FAILED', amountDue: 2000, amountPaid: 0 })).toBe(2000);
    expect(invoiceOutstanding({ status: 'paid', amountDue: 2000, amountPaid: 0 })).toBe(0);
  });
});

describe('Free plan limit findings', () => {
  it('finds nothing when usage is at or below every limit', () => {
    expect(planLimitFindings(free, within)).toEqual({ blockers: [], warnings: [] });
  });

  it('blocks on projects, members, storage and database size and says what to reduce', () => {
    const { blockers, warnings } = planLimitFindings(free, {
      ...within,
      projects: 7,
      members: 4,
      storageBytes: BigInt(3 * GB),
      dbSizeBytes: BigInt(2 * GB),
    });
    expect(blockers.map((b) => b.resource)).toEqual(['projects', 'members', 'storage', 'database']);
    expect(blockers[0]).toMatchObject({ current: '7', limit: '5', unit: 'count' });
    expect(blockers[2]).toMatchObject({ current: String(3 * GB), limit: String(2 * GB), unit: 'bytes' });
    expect(blockers.every((b) => b.hint.length > 0)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it('only warns on this month\'s API requests, bandwidth and active users', () => {
    const { blockers, warnings } = planLimitFindings(free, {
      ...within,
      apiRequestsMonth: 600_000,
      bandwidthMonth: BigInt(5 * GB),
      mau: 60_000,
    });
    expect(blockers).toEqual([]);
    expect(warnings.map((w) => w.resource)).toEqual(['api_requests', 'bandwidth', 'mau']);
  });

  it('treats a null limit as unlimited', () => {
    expect(planLimitFindings({ name: 'x', priceMonthly: 0, maxProjects: null }, { ...within, projects: 1000 }).blockers).toEqual([]);
  });
});
