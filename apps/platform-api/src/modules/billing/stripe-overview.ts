/**
 * The root console's Stripe screen, limited to basefyio.
 *
 * The Stripe account is shared with other products, so the raw account lists
 * mixed their customers, subscriptions ("Pay-as-you-go 1.99/mo") and charges
 * into ours, and "Customers 100" was simply the page size. Everything here is
 * filtered to objects that map to a basefyio team, and the headline revenue
 * is the platform's own recurring-revenue figure (recurring-revenue.ts) so it
 * matches the Overview and Infrastructure costs screens.
 *
 * Pure: the caller fetches the Stripe lists and the team mapping.
 */

/** Stripe object ids as they arrive: a bare id or an expanded object. */
type Ref = string | { id: string; deleted?: boolean; email?: string | null; name?: string | null; customer?: Ref | null } | null | undefined;

export interface StripeChargeLike {
  id: string;
  amount: number;
  amount_refunded?: number;
  currency: string;
  status: string;
  created: number;
  customer?: Ref;
  description?: string | null;
  paid?: boolean;
  refunded?: boolean;
  failure_message?: string | null;
}

export interface StripeBalanceTransactionLike {
  id: string;
  type: string;
  status: string;
  amount: number;
  net: number;
  fee: number;
  created: number;
  /** Expanded to the charge so it can be attributed to a customer. */
  source?: Ref;
}

export interface StripeInvoiceLike {
  id: string;
  number?: string | null;
  amount_due: number;
  amount_paid: number;
  currency: string;
  status?: string | null;
  created?: number | null;
  due_date?: number | null;
  customer?: Ref;
  subscription?: Ref | { id: string; metadata?: Record<string, string> | null } | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
}

export interface StripeSubscriptionLike {
  id: string;
  status: string;
  created: number;
  current_period_end?: number | null;
  cancel_at_period_end?: boolean;
  currency?: string;
  customer?: Ref;
  metadata?: Record<string, string> | null;
  items?: {
    data: Array<{ price?: { unit_amount?: number | null; nickname?: string | null; product?: Ref } | null }>;
  };
}

export interface StripeScope {
  /** Stripe customers that belong to a basefyio team (subscriptions.stripe_customer_id). */
  customerIds: Set<string>;
  /** Stripe subscriptions recorded on a basefyio team. */
  subscriptionIds: Set<string>;
  /** Products created for basefyio plans. */
  productIds: Set<string>;
  teamByCustomer: Map<string, { teamId: string; teamName: string; teamSlug: string }>;
  planNameByProduct: Map<string, string>;
}

export interface PlatformRevenueFacts {
  recurringRevenueUsd: number;
  payingTeams: number;
  paidPlanTeams: number;
  pastDueTeams: number;
  definition: string;
}

/** How many of each list the overview reads (one Stripe page). */
export const STRIPE_LIST_WINDOW = 100;

export const idOf = (v: Ref | { id: string } | null | undefined): string | null =>
  typeof v === 'string' ? v : v && typeof v === 'object' && typeof v.id === 'string' ? v.id : null;

const customerText = (v: Ref) =>
  v && typeof v === 'object' && !v.deleted ? { name: v.name ?? null, email: v.email ?? null } : { name: null, email: null };

export function isBasefyioCustomer(customer: Ref, scope: StripeScope): boolean {
  const id = idOf(customer);
  return !!id && scope.customerIds.has(id);
}

export function isBasefyioSubscription(sub: StripeSubscriptionLike, scope: StripeScope): boolean {
  if (scope.subscriptionIds.has(sub.id)) return true;
  if (isBasefyioCustomer(sub.customer, scope)) return true;
  return (sub.items?.data ?? []).some((i) => {
    const product = idOf(i.price?.product ?? null);
    return !!product && scope.productIds.has(product);
  });
}

export function isBasefyioInvoice(inv: StripeInvoiceLike, scope: StripeScope): boolean {
  if (isBasefyioCustomer(inv.customer, scope)) return true;
  const subId = idOf(inv.subscription as Ref);
  return !!subId && scope.subscriptionIds.has(subId);
}

/** A balance transaction counts when its source charge belongs to a basefyio customer. */
export function isBasefyioBalanceTransaction(t: StripeBalanceTransactionLike, scope: StripeScope): boolean {
  const source = t.source;
  if (!source || typeof source !== 'object') return false;
  return isBasefyioCustomer(source.customer ?? null, scope);
}

export function buildStripeOverview(
  raw: {
    charges: StripeChargeLike[];
    balanceTransactions: StripeBalanceTransactionLike[];
    invoices: StripeInvoiceLike[];
    subscriptions: StripeSubscriptionLike[];
  },
  scope: StripeScope,
  platform: PlatformRevenueFacts,
) {
  const charges = raw.charges.filter((c) => isBasefyioCustomer(c.customer, scope));
  const txns = raw.balanceTransactions.filter((t) => isBasefyioBalanceTransaction(t, scope));
  const invoices = raw.invoices.filter((i) => isBasefyioInvoice(i, scope));
  const subscriptions = raw.subscriptions.filter((s) => isBasefyioSubscription(s, scope));

  const teamFor = (customer: Ref) => {
    const id = idOf(customer);
    return id ? scope.teamByCustomer.get(id) ?? null : null;
  };

  // Settled charges only, as before; refunds are listed on the charge itself.
  const settled = txns.filter((t) => t.type === 'charge' && t.status === 'available');
  const totalRevenue = settled.reduce((s, t) => s + t.net, 0);
  const totalGross = settled.reduce((s, t) => s + t.amount, 0);
  const totalFees = settled.reduce((s, t) => s + t.fee, 0);

  const monthly: Record<string, { gross: number; net: number; fees: number; count: number }> = {};
  for (const t of txns) {
    if (t.type !== 'charge') continue;
    const d = new Date(t.created * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    monthly[key] ??= { gross: 0, net: 0, fees: 0, count: 0 };
    monthly[key].gross += t.amount;
    monthly[key].net += t.net;
    monthly[key].fees += t.fee;
    monthly[key].count += 1;
  }

  const active = subscriptions.filter((s) => s.status === 'active');
  const planName = (s: StripeSubscriptionLike) => {
    const item = s.items?.data[0];
    const product = idOf(item?.price?.product ?? null);
    return (
      s.metadata?.planName ||
      (product ? scope.planNameByProduct.get(product) : undefined) ||
      item?.price?.nickname ||
      null
    );
  };

  return {
    configured: true as const,
    scope: {
      basefyioOnly: true,
      window: STRIPE_LIST_WINDOW,
      hidden: {
        charges: raw.charges.length - charges.length,
        invoices: raw.invoices.length - invoices.length,
        subscriptions: raw.subscriptions.length - subscriptions.length,
        balanceTransactions: raw.balanceTransactions.length - txns.length,
      },
    },
    summary: {
      totalRevenue,
      totalGross,
      totalFees,
      /** Platform recurring revenue in cents — the same figure as the Overview. */
      mrr: Math.round(platform.recurringRevenueUsd * 100),
      mrrSource: 'platform' as const,
      mrrDefinition: platform.definition,
      payingTeams: platform.payingTeams,
      paidPlanTeams: platform.paidPlanTeams,
      pastDueTeams: platform.pastDueTeams,
      /** Monthly value of basefyio's own Stripe subscriptions (older checkout flow). */
      stripeSubscriptionMrr: active.reduce((s, sub) => s + (sub.items?.data[0]?.price?.unit_amount || 0), 0),
      currency: 'usd',
      activeSubscriptions: active.length,
      canceledSubscriptions: subscriptions.filter((s) => s.status === 'canceled').length,
      pastDueSubscriptions: subscriptions.filter((s) => s.status === 'past_due').length,
      /** basefyio teams with a Stripe customer — not one page of the shared account. */
      totalCustomers: scope.customerIds.size,
    },
    revenueByMonth: Object.entries(monthly)
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    recentCharges: charges.map((c) => {
      const team = teamFor(c.customer);
      const who = customerText(c.customer);
      return {
        id: c.id,
        amount: c.amount,
        currency: c.currency,
        status: c.status,
        created: new Date(c.created * 1000).toISOString(),
        customerEmail: who.email,
        customerName: who.name,
        teamId: team?.teamId ?? null,
        teamName: team?.teamName ?? null,
        description: c.description ?? null,
        paid: c.paid ?? false,
        refunded: c.refunded ?? false,
        amountRefunded: c.amount_refunded ?? 0,
        failureMessage: c.failure_message ?? null,
      };
    }),
    recentInvoices: invoices.map((inv) => {
      const team = teamFor(inv.customer);
      const who = customerText(inv.customer);
      const sub = inv.subscription && typeof inv.subscription === 'object' ? inv.subscription : null;
      return {
        id: inv.id,
        number: inv.number ?? null,
        amount: inv.amount_due,
        amountPaid: inv.amount_paid,
        currency: inv.currency,
        status: inv.status ?? null,
        created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
        dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
        customerEmail: who.email,
        customerName: who.name,
        teamId: team?.teamId ?? null,
        teamName: team?.teamName ?? null,
        hostedUrl: inv.hosted_invoice_url ?? null,
        pdf: inv.invoice_pdf ?? null,
        planName: (sub as { metadata?: Record<string, string> | null } | null)?.metadata?.planName || null,
      };
    }),
    activeSubscriptions: active.map((s) => {
      const team = teamFor(s.customer);
      const who = customerText(s.customer);
      return {
        id: s.id,
        status: s.status,
        created: new Date(s.created * 1000).toISOString(),
        currentPeriodEnd: s.current_period_end ? new Date(s.current_period_end * 1000).toISOString() : null,
        cancelAtPeriodEnd: s.cancel_at_period_end ?? false,
        customerEmail: who.email,
        customerName: who.name,
        teamId: team?.teamId ?? null,
        teamName: team?.teamName ?? null,
        teamSlug: team?.teamSlug ?? null,
        planName: planName(s),
        amount: s.items?.data[0]?.price?.unit_amount || 0,
        currency: s.currency ?? 'usd',
      };
    }),
  };
}

export type StripeOverview = ReturnType<typeof buildStripeOverview>;
