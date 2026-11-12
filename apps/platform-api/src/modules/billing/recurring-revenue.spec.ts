import {
  RENEWAL_GRACE_DAYS,
  classifyRevenue,
  effectivePriceUsd,
  monthlyRevenueUsd,
  summarizeRecurringRevenue,
  type RevenueSubscriptionInput,
} from './recurring-revenue';

const NOW = new Date('2026-10-21T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const paying = (over: Partial<RevenueSubscriptionInput> = {}): RevenueSubscriptionInput => ({
  status: 'ACTIVE',
  priceMonthlyCents: 2000,
  stripeCustomerId: 'cus_1',
  billingDayOfMonth: 5,
  currentPeriodEnd: new Date(NOW.getTime() + 10 * DAY),
  accountStatus: 'ACTIVE',
  ...over,
});

describe('recurring revenue', () => {
  it('counts an active, billed, renewed paid plan', () => {
    expect(classifyRevenue(paying(), NOW)).toBe('paying');
    expect(monthlyRevenueUsd(paying(), NOW)).toBe(20);
  });

  it('applies the student discount', () => {
    expect(effectivePriceUsd({ priceMonthlyCents: 2000, studentDiscountPercent: 50 })).toBe(10);
    expect(monthlyRevenueUsd(paying({ studentDiscountPercent: 50 }), NOW)).toBe(10);
    // A 100% discount is a free plan in practice.
    expect(classifyRevenue(paying({ studentDiscountPercent: 100 }), NOW)).toBe('free');
  });

  it('does not count past-due, trialing, canceled or incomplete subscriptions', () => {
    expect(classifyRevenue(paying({ status: 'PAST_DUE' }), NOW)).toBe('past_due');
    expect(classifyRevenue(paying({ status: 'TRIALING' }), NOW)).toBe('trialing');
    expect(classifyRevenue(paying({ status: 'CANCELED' }), NOW)).toBe('canceled');
    expect(classifyRevenue(paying({ status: 'INCOMPLETE' }), NOW)).toBe('incomplete');
    expect(monthlyRevenueUsd(paying({ status: 'PAST_DUE' }), NOW)).toBe(0);
  });

  it('does not count frozen accounts', () => {
    expect(classifyRevenue(paying({ accountStatus: 'FROZEN' }), NOW)).toBe('frozen');
  });

  it('does not count a paid plan nothing charges for', () => {
    // Assigned by an admin: no Stripe customer, no charge day.
    expect(classifyRevenue(paying({ stripeCustomerId: null, billingDayOfMonth: null }), NOW)).toBe('unbilled');
    // A customer without a recurring charge day is never charged either.
    expect(classifyRevenue(paying({ billingDayOfMonth: null }), NOW)).toBe('unbilled');
    // A Stripe subscription bills on its own.
    expect(
      classifyRevenue(paying({ stripeCustomerId: null, billingDayOfMonth: null, stripeSubscriptionId: 'sub_1' }), NOW),
    ).toBe('paying');
  });

  it('treats a renewal overdue past the grace window as lapsed', () => {
    const justOverdue = new Date(NOW.getTime() - (RENEWAL_GRACE_DAYS - 1) * DAY);
    const longOverdue = new Date(NOW.getTime() - (RENEWAL_GRACE_DAYS + 1) * DAY);
    expect(classifyRevenue(paying({ currentPeriodEnd: justOverdue }), NOW)).toBe('paying');
    expect(classifyRevenue(paying({ currentPeriodEnd: longOverdue }), NOW)).toBe('lapsed');
    expect(classifyRevenue(paying({ currentPeriodEnd: '2026-07-26T00:00:00.000Z' }), NOW)).toBe('lapsed');
    expect(classifyRevenue(paying({ currentPeriodEnd: null }), NOW)).toBe('paying');
  });

  it('summarises every state and sums only paying teams', () => {
    const summary = summarizeRecurringRevenue(
      [
        paying(),
        paying({ priceMonthlyCents: 4999 }),
        paying({ status: 'PAST_DUE' }),
        paying({ stripeCustomerId: null }),
        paying({ priceMonthlyCents: 0 }),
      ],
      NOW,
    );
    expect(summary.mrrUsd).toBe(69.99);
    expect(summary.payingTeams).toBe(2);
    expect(summary.paidPlanTeams).toBe(4);
    expect(summary.byState.past_due).toEqual({ teams: 1, listPriceUsd: 20 });
    expect(summary.byState.unbilled).toEqual({ teams: 1, listPriceUsd: 20 });
    expect(summary.byState.free.teams).toBe(1);
    expect(summary.definition).toMatch(/renewed on time/);
  });
});
