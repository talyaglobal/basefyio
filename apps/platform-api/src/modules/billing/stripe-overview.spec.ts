import { StripeScope, buildStripeOverview } from './stripe-overview';

const scope: StripeScope = {
  customerIds: new Set(['cus_bf1', 'cus_bf2']),
  subscriptionIds: new Set(['sub_bf_legacy']),
  productIds: new Set(['prod_pro']),
  teamByCustomer: new Map([
    ['cus_bf1', { teamId: 't1', teamName: "Faruk's Team", teamSlug: 'faruk' }],
    ['cus_bf2', { teamId: 't2', teamName: 'Acme', teamSlug: 'acme' }],
  ]),
  planNameByProduct: new Map([['prod_pro', 'Pro']]),
};

const platform = {
  recurringRevenueUsd: 49.99,
  payingTeams: 2,
  paidPlanTeams: 6,
  pastDueTeams: 1,
  definition: 'definition text',
};

const ts = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

describe('buildStripeOverview', () => {
  const raw = {
    charges: [
      { id: 'ch_1', amount: 2000, currency: 'usd', status: 'succeeded', created: ts('2026-10-21T10:00:00Z'), customer: { id: 'cus_bf1', email: 'f@example.com', name: null } },
      { id: 'ch_other', amount: 199, currency: 'usd', status: 'succeeded', created: ts('2026-10-21T11:00:00Z'), customer: { id: 'cus_other', email: 'x@shop.com', name: 'Sardar Shipping' } },
    ],
    balanceTransactions: [
      { id: 'txn_1', type: 'charge', status: 'available', amount: 2000, net: 1912, fee: 88, created: ts('2026-10-21T10:00:00Z'), source: { id: 'ch_1', customer: 'cus_bf1' } },
      { id: 'txn_other', type: 'charge', status: 'available', amount: 199, net: 164, fee: 35, created: ts('2026-10-21T11:00:00Z'), source: { id: 'ch_other', customer: 'cus_other' } },
      // Not expanded: cannot be attributed, so it is not counted as ours.
      { id: 'txn_unknown', type: 'charge', status: 'available', amount: 500, net: 450, fee: 50, created: ts('2026-10-20T11:00:00Z'), source: 'ch_x' },
    ],
    invoices: [
      { id: 'in_1', amount_due: 2000, amount_paid: 2000, currency: 'usd', status: 'paid', customer: { id: 'cus_bf2' } },
      { id: 'in_other', amount_due: 199, amount_paid: 199, currency: 'usd', status: 'paid', customer: 'cus_other' },
    ],
    subscriptions: [
      // Another product's pay-as-you-go plan on the shared account.
      { id: 'sub_other', status: 'active', created: ts('2026-01-01T00:00:00Z'), customer: 'cus_other', items: { data: [{ price: { unit_amount: 199, nickname: 'Pay-as-you-go', product: 'prod_other' } }] } },
      { id: 'sub_bf_legacy', status: 'active', created: ts('2026-01-01T00:00:00Z'), customer: 'cus_legacy', items: { data: [{ price: { unit_amount: 2000, product: 'prod_pro' } }] } },
      { id: 'sub_bf_past', status: 'past_due', created: ts('2026-01-01T00:00:00Z'), customer: 'cus_bf2', items: { data: [{ price: { unit_amount: 2000, product: 'prod_pro' } }] } },
    ],
  };

  const overview = buildStripeOverview(raw as any, scope, platform);

  it('keeps only basefyio customers and says how much it hid', () => {
    expect(overview.recentCharges.map((c) => c.id)).toEqual(['ch_1']);
    expect(overview.recentInvoices.map((i) => i.id)).toEqual(['in_1']);
    expect(overview.activeSubscriptions.map((s) => s.id)).toEqual(['sub_bf_legacy']);
    expect(overview.scope.hidden).toEqual({ charges: 1, invoices: 1, subscriptions: 1, balanceTransactions: 2 });
  });

  it('maps every Stripe object to its team', () => {
    expect(overview.recentCharges[0].teamName).toBe("Faruk's Team");
    expect(overview.recentInvoices[0].teamName).toBe('Acme');
    // Matched through the product, named after our plan.
    expect(overview.activeSubscriptions[0].planName).toBe('Pro');
  });

  it('sums revenue from basefyio charges only', () => {
    expect(overview.summary.totalGross).toBe(2000);
    expect(overview.summary.totalRevenue).toBe(1912);
    expect(overview.summary.totalFees).toBe(88);
    expect(overview.revenueByMonth).toEqual([{ month: '2026-10', gross: 2000, net: 1912, fees: 88, count: 1 }]);
  });

  it('reports the platform recurring revenue and our own customer count', () => {
    expect(overview.summary.mrr).toBe(4999);
    expect(overview.summary.mrrSource).toBe('platform');
    expect(overview.summary.payingTeams).toBe(2);
    expect(overview.summary.pastDueTeams).toBe(1);
    // Our teams with a Stripe customer — not the page size of the shared account.
    expect(overview.summary.totalCustomers).toBe(2);
    expect(overview.summary.pastDueSubscriptions).toBe(1);
    expect(overview.summary.stripeSubscriptionMrr).toBe(2000);
  });
});
