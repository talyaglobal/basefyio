/**
 * One definition of recurring revenue for every root-console screen.
 *
 * The Overview, Infrastructure costs and Stripe screens used to compute three
 * different numbers: one counted past-due and trialing teams as paying, one
 * only counted teams that happened to have projects, and one summed every
 * subscription in a Stripe account that other products share. They all read
 * this module now, so they show the same figure.
 *
 * A team contributes to recurring revenue when its plan has a price, the
 * subscription is ACTIVE, the account is not frozen, the plan is actually
 * billed (a Stripe subscription, or a card customer with a recurring charge
 * day), and the current period was renewed on time. Everything else is
 * reported by state so nothing silently disappears.
 *
 * Pure functions only — no database, no Stripe.
 */

/** A renewal this many days overdue counts as not collected. */
export const RENEWAL_GRACE_DAYS = 3;

export const RECURRING_REVENUE_DEFINITION =
  'Monthly plan price, after any student discount, of every team whose paid plan is active, ' +
  'billed through Stripe and renewed on time. Trials, past-due, frozen, unbilled (assigned ' +
  'without a payment method) and lapsed subscriptions are not counted.';

export type RevenueState =
  | 'paying'
  | 'free'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'frozen'
  | 'unbilled'
  | 'lapsed';

export const REVENUE_STATES: RevenueState[] = [
  'paying',
  'past_due',
  'lapsed',
  'unbilled',
  'trialing',
  'frozen',
  'incomplete',
  'canceled',
  'free',
];

export const REVENUE_STATE_LABELS: Record<RevenueState, string> = {
  paying: 'Paying',
  free: 'Free plan',
  trialing: 'Trial',
  past_due: 'Past due',
  canceled: 'Canceled',
  incomplete: 'Payment incomplete',
  frozen: 'Account frozen',
  unbilled: 'Not billed',
  lapsed: 'Renewal overdue',
};

export interface RevenueSubscriptionInput {
  status: string;
  /** Plan list price in cents per month. */
  priceMonthlyCents: number;
  studentDiscountPercent?: number | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  billingDayOfMonth?: number | null;
  currentPeriodEnd?: Date | string | null;
  /** Team.accountStatus (ACTIVE | FROZEN | CANCELLED). */
  accountStatus?: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The monthly price after the student discount, in USD. */
export function effectivePriceUsd(sub: Pick<RevenueSubscriptionInput, 'priceMonthlyCents' | 'studentDiscountPercent'>): number {
  const cents = Math.max(0, Number(sub.priceMonthlyCents) || 0);
  const discount = Math.min(100, Math.max(0, Number(sub.studentDiscountPercent) || 0));
  return round2((cents * (100 - discount)) / 100 / 100);
}

/** True when something actually charges the team every period. */
export function isBilled(sub: RevenueSubscriptionInput): boolean {
  if (sub.stripeSubscriptionId) return true;
  return !!sub.stripeCustomerId && sub.billingDayOfMonth != null;
}

export function classifyRevenue(sub: RevenueSubscriptionInput, now: Date = new Date()): RevenueState {
  if (effectivePriceUsd(sub) <= 0) return 'free';
  const status = String(sub.status || '').toUpperCase();
  if (status === 'CANCELED') return 'canceled';
  if (status === 'INCOMPLETE') return 'incomplete';
  if (status === 'TRIALING') return 'trialing';
  if (status === 'PAST_DUE') return 'past_due';
  if (status !== 'ACTIVE') return 'incomplete';
  if (sub.accountStatus && String(sub.accountStatus).toUpperCase() !== 'ACTIVE') return 'frozen';
  if (!isBilled(sub)) return 'unbilled';
  if (sub.currentPeriodEnd) {
    const end = new Date(sub.currentPeriodEnd).getTime();
    const graceEnd = now.getTime() - RENEWAL_GRACE_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(end) && end < graceEnd) return 'lapsed';
  }
  return 'paying';
}

/** What a subscription adds to recurring revenue this month, in USD. */
export function monthlyRevenueUsd(sub: RevenueSubscriptionInput, now: Date = new Date()): number {
  return classifyRevenue(sub, now) === 'paying' ? effectivePriceUsd(sub) : 0;
}

export interface RevenueStateTotals {
  teams: number;
  /** Sum of effective plan prices in this state (what it would be worth if collected). */
  listPriceUsd: number;
}

export interface RecurringRevenueSummary {
  mrrUsd: number;
  payingTeams: number;
  /** Teams on a plan with a price, whatever their billing state. */
  paidPlanTeams: number;
  byState: Record<RevenueState, RevenueStateTotals>;
  definition: string;
}

export function summarizeRecurringRevenue(
  subs: RevenueSubscriptionInput[],
  now: Date = new Date(),
): RecurringRevenueSummary {
  const byState = Object.fromEntries(
    REVENUE_STATES.map((s) => [s, { teams: 0, listPriceUsd: 0 }]),
  ) as Record<RevenueState, RevenueStateTotals>;
  let mrr = 0;
  for (const sub of subs) {
    const state = classifyRevenue(sub, now);
    const price = effectivePriceUsd(sub);
    byState[state].teams += 1;
    byState[state].listPriceUsd = round2(byState[state].listPriceUsd + price);
    if (state === 'paying') mrr += price;
  }
  return {
    mrrUsd: round2(mrr),
    payingTeams: byState.paying.teams,
    paidPlanTeams: subs.length - byState.free.teams,
    byState,
    definition: RECURRING_REVENUE_DEFINITION,
  };
}
