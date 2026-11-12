import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { ProjectCostService } from './project-cost.service';
import {
  STRIPE_LIST_WINDOW,
  StripeOverview,
  StripeScope,
  buildStripeOverview,
} from './stripe-overview';

/**
 * Reads the latest page of each Stripe list (read-only) and narrows it to
 * basefyio's own customers. Used by the root console's Stripe screen and the
 * scheduled email report.
 */
@Injectable()
export class StripeOverviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly costs: ProjectCostService,
  ) {}

  /** Which Stripe objects belong to basefyio, from our own subscription records. */
  async getScope(): Promise<StripeScope> {
    const [subs, plans] = await Promise.all([
      this.prisma.subscription.findMany({
        where: { OR: [{ stripeCustomerId: { not: null } }, { stripeSubscriptionId: { not: null } }] },
        select: {
          stripeCustomerId: true,
          stripeSubscriptionId: true,
          team: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.prisma.plan.findMany({
        where: { stripeProductId: { not: null } },
        select: { stripeProductId: true, displayName: true },
      }),
    ]);
    const scope: StripeScope = {
      customerIds: new Set(),
      subscriptionIds: new Set(),
      productIds: new Set(),
      teamByCustomer: new Map(),
      planNameByProduct: new Map(),
    };
    for (const s of subs) {
      if (s.stripeCustomerId) {
        scope.customerIds.add(s.stripeCustomerId);
        scope.teamByCustomer.set(s.stripeCustomerId, {
          teamId: s.team.id,
          teamName: s.team.name,
          teamSlug: s.team.slug,
        });
      }
      if (s.stripeSubscriptionId) scope.subscriptionIds.add(s.stripeSubscriptionId);
    }
    for (const p of plans) {
      if (!p.stripeProductId) continue;
      scope.productIds.add(p.stripeProductId);
      scope.planNameByProduct.set(p.stripeProductId, p.displayName);
    }
    return scope;
  }

  async getOverview(): Promise<StripeOverview | { configured: false; message: string }> {
    if (!this.stripe.isEnabled()) {
      return { configured: false, message: 'Stripe is not configured.' };
    }
    const client = this.stripe.getClient();
    const [charges, balanceTxns, invoices, subscriptions, scope, revenue] = await Promise.all([
      client.charges.list({ limit: STRIPE_LIST_WINDOW, expand: ['data.customer'] }),
      // The source charge carries the customer, which is how a fee is attributed.
      client.balanceTransactions.list({ limit: STRIPE_LIST_WINDOW, expand: ['data.source'] }),
      client.invoices.list({ limit: STRIPE_LIST_WINDOW, expand: ['data.customer', 'data.subscription'] }),
      client.subscriptions.list({ limit: STRIPE_LIST_WINDOW, status: 'all', expand: ['data.customer'] }),
      this.getScope(),
      this.costs.getRecurringRevenue(),
    ]);
    return buildStripeOverview(
      {
        charges: charges.data as any,
        balanceTransactions: balanceTxns.data as any,
        invoices: invoices.data as any,
        subscriptions: subscriptions.data as any,
      },
      scope,
      {
        recurringRevenueUsd: revenue.mrrUsd,
        payingTeams: revenue.payingTeams,
        paidPlanTeams: revenue.paidPlanTeams,
        pastDueTeams: revenue.byState.past_due.teams,
        definition: revenue.definition,
      },
    );
  }
}
