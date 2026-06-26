import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';

@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly realtime: RealtimeEventsService,
  ) {}

  async onModuleInit() {
    if (this.stripe.isEnabled()) {
      try {
        await this.syncStripePlans();
      } catch (err: any) {
        this.logger.error(`Failed to sync Stripe plans: ${err.message}`);
      }
    }
  }

  /**
   * Sync paid plans with Stripe: create products + prices if missing.
   * Replaces the need for STRIPE_PRO_PRICE_ID / STRIPE_BUSINESS_PRICE_ID env vars.
   */
  async syncStripePlans(): Promise<void> {
    const paidPlans = await this.prisma.plan.findMany({
      where: { priceMonthly: { gt: 0 } },
    });

    for (const plan of paidPlans) {
      try {
        await this.ensureStripePlanArtifacts(plan);
      } catch (err: any) {
        this.logger.error(`Failed to sync plan ${plan.name} with Stripe: ${err.message}`);
      }
    }
  }

  private async ensureStripePlanArtifacts<T extends {
    id: string;
    name: string;
    displayName: string;
    maxProjects: number | null;
    dedicatedDb: boolean;
    priceMonthly: number;
    stripeProductId: string | null;
    stripePriceId: string | null;
  }>(plan: T): Promise<T & { stripeProductId: string; stripePriceId: string }> {
    let next = { ...plan };

    if (!next.stripeProductId) {
      const product = await this.stripe.createProduct(
        `basefyio ${next.displayName}`,
        `${next.displayName} plan — ${next.maxProjects || 'unlimited'} projects, ${next.dedicatedDb ? 'dedicated' : 'shared'} database`,
      );
      next = {
        ...next,
        stripeProductId: product.id,
      };
      await this.prisma.plan.update({
        where: { id: next.id },
        data: { stripeProductId: product.id },
      });
      this.logger.log(`Stripe product created for ${next.name}: ${product.id}`);
    }

    if (!next.stripePriceId) {
      const price = await this.stripe.createPrice({
        productId: next.stripeProductId!,
        unitAmount: next.priceMonthly,
        currency: 'usd',
        interval: 'month',
      });
      next = {
        ...next,
        stripePriceId: price.id,
      };
      await this.prisma.plan.update({
        where: { id: next.id },
        data: { stripePriceId: price.id },
      });
      this.logger.log(
        `Stripe price created for ${next.name}: ${price.id} ($${(next.priceMonthly / 100).toFixed(2)}/mo)`,
      );
    }

    return next as T & { stripeProductId: string; stripePriceId: string };
  }

  /** List all publicly available plans */
  async listPlans() {
    return this.prisma.plan.findMany({
      where: { isPublic: true },
      orderBy: { priceMonthly: 'asc' },
    });
  }

  /** Get all plans including non-public (for internal use) */
  async getAllPlans() {
    return this.prisma.plan.findMany({
      orderBy: { priceMonthly: 'asc' },
    });
  }

  /** Get a plan by name */
  async getPlanByName(name: string) {
    const plan = await this.prisma.plan.findUnique({ where: { name } });
    if (!plan) throw new NotFoundException(`Plan "${name}" not found`);
    return plan;
  }

  /** Get team's current subscription with plan details. Auto-creates Free if missing. */
  async getTeamSubscription(teamId: string) {
    let sub = await this.prisma.subscription.findUnique({
      where: { teamId },
      include: { plan: true, team: true },
    });

    if (!sub) {
      this.logger.warn(`No subscription for team ${teamId} — auto-creating Free subscription`);
      try {
        await this.createFreeSubscription(teamId);
        sub = await this.prisma.subscription.findUnique({
          where: { teamId },
          include: { plan: true, team: true },
        });
      } catch (err: any) {
        this.logger.error(`Failed to auto-create Free subscription for team ${teamId}: ${err.message}`);
        return null;
      }
    }

    // Check if team has payment method
    let hasPaymentMethod = false;
    if (sub?.stripeCustomerId && this.stripe.isEnabled()) {
      try {
        const pm = await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId);
        hasPaymentMethod = !!pm;
      } catch {
        hasPaymentMethod = false;
      }
    }

    return {
      ...sub,
      hasPaymentMethod,
      accountStatus: sub?.team?.accountStatus || 'ACTIVE',
    };
  }

  /** Create a Free plan subscription for a new team + Stripe customer */
  async createFreeSubscription(teamId: string, ownerEmail?: string, teamName?: string) {
    const freePlan = await this.prisma.plan.findUnique({ where: { name: 'free' } });
    if (!freePlan) {
      this.logger.error('Free plan not found in database. Run prisma db seed.');
      throw new Error('Free plan not found');
    }

    let stripeCustomerId: string | null = null;
    if (this.stripe.isEnabled() && ownerEmail) {
      try {
        const team = teamName || (await this.prisma.team.findUnique({ where: { id: teamId }, select: { name: true } }))?.name || 'Unknown';
        const customer = await this.stripe.getOrCreateCustomer({
          teamId,
          teamName: team,
          email: ownerEmail,
        });
        stripeCustomerId = customer.id;
        this.logger.log(`Stripe customer created for team ${teamId}: ${stripeCustomerId}`);
      } catch (err: any) {
        this.logger.warn(`Failed to create Stripe customer for team ${teamId}: ${err.message}`);
      }
    }

    const subscription = await this.prisma.subscription.create({
      data: {
        teamId,
        planId: freePlan.id,
        status: 'ACTIVE',
        stripeCustomerId,
      },
    });

    await this.prisma.teamUsage.create({
      data: {
        teamId,
        projectCount: 0,
        storageBytes: BigInt(0),
        memberCount: 1,
        dbSizeBytes: BigInt(0),
        apiRequestsMonth: 0,
        bandwidthMonth: BigInt(0),
        mauCount: 0,
      },
    });

    this.logger.log(`Free subscription created for team ${teamId}`);
    return subscription;
  }

  /** Create subscription with a specific plan (deferred payment for paid plans) */
  async createSubscriptionWithPlan(teamId: string, planName: string, ownerEmail?: string, teamName?: string) {
    const plan = await this.prisma.plan.findUnique({ where: { name: planName } });
    if (!plan) {
      this.logger.warn(`Plan "${planName}" not found, falling back to free`);
      return this.createFreeSubscription(teamId, ownerEmail, teamName);
    }

    let stripeCustomerId: string | null = null;
    if (this.stripe.isEnabled() && ownerEmail) {
      try {
        const name = teamName || (await this.prisma.team.findUnique({ where: { id: teamId }, select: { name: true } }))?.name || 'Unknown';
        const customer = await this.stripe.getOrCreateCustomer({
          teamId,
          teamName: name,
          email: ownerEmail,
        });
        stripeCustomerId = customer.id;
      } catch (err: any) {
        this.logger.warn(`Failed to create Stripe customer for team ${teamId}: ${err.message}`);
      }
    }

    const subscription = await this.prisma.subscription.create({
      data: {
        teamId,
        planId: plan.id,
        status: 'ACTIVE',
        stripeCustomerId,
      },
    });

    await this.prisma.teamUsage.create({
      data: {
        teamId,
        projectCount: 0,
        storageBytes: BigInt(0),
        memberCount: 1,
        dbSizeBytes: BigInt(0),
        apiRequestsMonth: 0,
        bandwidthMonth: BigInt(0),
        mauCount: 0,
      },
    });

    this.logger.log(`Subscription created for team ${teamId} with plan ${planName}`);
    return subscription;
  }

  /** Create a Stripe Checkout session for upgrading */
  async createCheckoutSession(
    teamId: string,
    userId: string,
    planName: string,
    successUrl: string,
    cancelUrl: string,
  ) {
    await this.assertTeamOwner(teamId, userId);

    let plan = await this.getPlanByName(planName);
    if (!plan.stripePriceId) {
      if (!this.stripe.isEnabled() || plan.priceMonthly <= 0) {
        throw new BadRequestException(`Plan "${planName}" is not a paid plan`);
      }
      plan = await this.ensureStripePlanArtifacts(plan);
    }
    const checkoutPriceId = plan.stripePriceId;
    if (!checkoutPriceId) {
      throw new BadRequestException(`Plan "${planName}" has no Stripe price`);
    }

    const sub = await this.getTeamSubscription(teamId);
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!team || !user) throw new NotFoundException('Team or user not found');

    const customer = await this.stripe.getOrCreateCustomer({
      teamId,
      teamName: team.name,
      email: user.email,
      existingCustomerId: sub?.stripeCustomerId,
    });

    if (sub && !sub.stripeCustomerId) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { stripeCustomerId: customer.id },
      });
    }

    const session = await this.stripe.createCheckoutSession({
      customerId: customer.id,
      priceId: checkoutPriceId,
      teamId,
      successUrl,
      cancelUrl,
    });

    return { url: session.url, sessionId: session.id };
  }

  /** Create a Stripe Customer Portal session */
  async createPortalSession(teamId: string, userId: string, returnUrl: string) {
    await this.assertTeamOwner(teamId, userId);

    const sub = await this.getTeamSubscription(teamId);
    if (!sub?.stripeCustomerId) {
      throw new BadRequestException('No active Stripe subscription found');
    }

    const session = await this.stripe.createPortalSession({
      customerId: sub.stripeCustomerId,
      returnUrl,
    });

    return { url: session.url };
  }

  /** Get invoices for a team */
  async getInvoices(teamId: string, userId: string) {
    await this.assertTeamMember(teamId, userId);

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });

    if (this.stripe.isEnabled() && sub?.stripeCustomerId) {
      try {
        const stripeInvoices = await this.stripe.listInvoices(sub.stripeCustomerId, 50);
        for (const inv of stripeInvoices) {
          await this.prisma.invoice.upsert({
            where: { stripeInvoiceId: inv.id },
            update: {
              amountDue: inv.amount_due || 0,
              amountPaid: inv.amount_paid || 0,
              currency: inv.currency || 'usd',
              status: inv.status || 'open',
              invoiceUrl: inv.hosted_invoice_url || null,
              invoicePdf: inv.invoice_pdf || null,
              periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null,
              periodEnd: inv.period_end ? new Date(inv.period_end * 1000) : null,
            },
            create: {
              teamId,
              stripeInvoiceId: inv.id,
              amountDue: inv.amount_due || 0,
              amountPaid: inv.amount_paid || 0,
              currency: inv.currency || 'usd',
              status: inv.status || 'open',
              invoiceUrl: inv.hosted_invoice_url || null,
              invoicePdf: inv.invoice_pdf || null,
              periodStart: inv.period_start ? new Date(inv.period_start * 1000) : null,
              periodEnd: inv.period_end ? new Date(inv.period_end * 1000) : null,
            },
          });
        }
      } catch (err: any) {
        this.logger.warn(`Stripe invoice sync failed for team ${teamId}: ${err.message}`);
      }
    }

    return this.prisma.invoice.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /** Handle Stripe webhook: checkout.session.completed */
  async handleCheckoutCompleted(session: any) {
    const teamId = session.metadata?.teamId;
    if (!teamId) {
      this.logger.warn('Checkout completed without teamId metadata');
      return;
    }

    const subscriptionId = session.subscription;
    const customerId = session.customer;

    if (!subscriptionId) return;

    const stripeSub = await this.stripe.getSubscription(subscriptionId);
    const priceId = stripeSub.items.data[0]?.price?.id;

    if (!priceId) {
      this.logger.warn(`No price ID found for subscription ${subscriptionId}`);
      return;
    }

    const plan = await this.prisma.plan.findFirst({
      where: { stripePriceId: priceId },
    });

    if (!plan) {
      this.logger.warn(`No plan found for Stripe price ${priceId}`);
      return;
    }

    await this.prisma.subscription.upsert({
      where: { teamId },
      update: {
        planId: plan.id,
        status: 'ACTIVE',
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        currentPeriodStart: new Date((stripeSub as any).current_period_start * 1000),
        currentPeriodEnd: new Date((stripeSub as any).current_period_end * 1000),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      },
      create: {
        teamId,
        planId: plan.id,
        status: 'ACTIVE',
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        currentPeriodStart: new Date((stripeSub as any).current_period_start * 1000),
        currentPeriodEnd: new Date((stripeSub as any).current_period_end * 1000),
      },
    });

    this.logger.log(`Team ${teamId} upgraded to ${plan.name} via checkout`);
  }

  /** Handle Stripe webhook: customer.subscription.updated */
  async handleSubscriptionUpdated(stripeSub: any) {
    const teamId = stripeSub.metadata?.teamId;
    if (!teamId) return;

    const priceId = stripeSub.items?.data?.[0]?.price?.id;
    const plan = priceId
      ? await this.prisma.plan.findFirst({ where: { stripePriceId: priceId } })
      : null;

    const statusMap: Record<string, string> = {
      active: 'ACTIVE',
      past_due: 'PAST_DUE',
      canceled: 'CANCELED',
      trialing: 'TRIALING',
      incomplete: 'INCOMPLETE',
    };

    const data: any = {
      status: statusMap[stripeSub.status] || 'ACTIVE',
      cancelAtPeriodEnd: stripeSub.cancel_at_period_end ?? false,
      currentPeriodStart: stripeSub.current_period_start
        ? new Date(stripeSub.current_period_start * 1000)
        : undefined,
      currentPeriodEnd: stripeSub.current_period_end
        ? new Date(stripeSub.current_period_end * 1000)
        : undefined,
    };

    if (plan) data.planId = plan.id;

    const freePlan = await this.prisma.plan.findUnique({ where: { name: 'free' } });
    await this.prisma.subscription.upsert({
      where: { teamId },
      update: data,
      create: {
        teamId,
        planId: data.planId || freePlan?.id || '',
        status: data.status || 'ACTIVE',
        stripeCustomerId: stripeSub.customer || null,
        stripeSubscriptionId: stripeSub.id || null,
        currentPeriodStart: data.currentPeriodStart,
        currentPeriodEnd: data.currentPeriodEnd,
        cancelAtPeriodEnd: data.cancelAtPeriodEnd ?? false,
      },
    });

    this.logger.log(`Subscription updated for team ${teamId}: status=${stripeSub.status}`);
  }

  /** Handle Stripe webhook: customer.subscription.deleted */
  async handleSubscriptionDeleted(stripeSub: any) {
    const teamId = stripeSub.metadata?.teamId;
    if (!teamId) return;

    const freePlan = await this.prisma.plan.findUnique({ where: { name: 'free' } });
    if (!freePlan) return;

    await this.prisma.subscription.update({
      where: { teamId },
      data: {
        planId: freePlan.id,
        status: 'ACTIVE',
        stripeSubscriptionId: null,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
      },
    });

    this.logger.log(`Subscription deleted for team ${teamId}, reverted to Free plan`);
  }

  /** Handle Stripe webhook: invoice.paid */
  async handleInvoicePaid(stripeInvoice: any) {
    const customerId = stripeInvoice.customer;

    const sub = await this.prisma.subscription.findFirst({
      where: { stripeCustomerId: customerId },
    });
    if (!sub) return;

    await this.prisma.invoice.upsert({
      where: { stripeInvoiceId: stripeInvoice.id },
      update: {
        status: 'paid',
        amountPaid: stripeInvoice.amount_paid || 0,
        invoiceUrl: stripeInvoice.hosted_invoice_url || null,
        invoicePdf: stripeInvoice.invoice_pdf || null,
      },
      create: {
        teamId: sub.teamId,
        stripeInvoiceId: stripeInvoice.id,
        amountDue: stripeInvoice.amount_due || 0,
        amountPaid: stripeInvoice.amount_paid || 0,
        currency: stripeInvoice.currency || 'usd',
        status: 'paid',
        invoiceUrl: stripeInvoice.hosted_invoice_url || null,
        invoicePdf: stripeInvoice.invoice_pdf || null,
        periodStart: stripeInvoice.period_start
          ? new Date(stripeInvoice.period_start * 1000)
          : null,
        periodEnd: stripeInvoice.period_end
          ? new Date(stripeInvoice.period_end * 1000)
          : null,
      },
    });

    this.logger.log(`Invoice ${stripeInvoice.id} marked as paid for team ${sub.teamId}`);
  }

  /** Handle Stripe webhook: invoice.payment_failed */
  async handleInvoicePaymentFailed(stripeInvoice: any) {
    const customerId = stripeInvoice.customer;

    const sub = await this.prisma.subscription.findFirst({
      where: { stripeCustomerId: customerId },
    });
    if (!sub) return;

    await this.prisma.invoice.upsert({
      where: { stripeInvoiceId: stripeInvoice.id },
      update: { status: 'unpaid' },
      create: {
        teamId: sub.teamId,
        stripeInvoiceId: stripeInvoice.id,
        amountDue: stripeInvoice.amount_due || 0,
        amountPaid: 0,
        currency: stripeInvoice.currency || 'usd',
        status: 'unpaid',
        invoiceUrl: stripeInvoice.hosted_invoice_url || null,
        invoicePdf: stripeInvoice.invoice_pdf || null,
        periodStart: stripeInvoice.period_start
          ? new Date(stripeInvoice.period_start * 1000)
          : null,
        periodEnd: stripeInvoice.period_end
          ? new Date(stripeInvoice.period_end * 1000)
          : null,
      },
    });

    // Stamp firstFailureAt on initial Stripe-initiated failure if not already set
    if (!sub.firstFailureAt) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { firstFailureAt: new Date() },
      });
    }

    this.logger.warn(`Invoice payment failed for team ${sub.teamId}: ${stripeInvoice.id}`);
  }

  /** Get user's active team ID */
  async getUserActiveTeamId(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeTeamId: true },
    });
    if (!user?.activeTeamId) throw new NotFoundException('No active team');
    return user.activeTeamId;
  }

  /** Get subscription with membership check */
  async getTeamSubscriptionForUser(teamId: string, userId: string) {
    await this.assertTeamMember(teamId, userId);
    return this.getTeamSubscription(teamId);
  }

  /** Assert caller is team member (public wrapper) */
  async verifyTeamMembership(teamId: string, userId: string): Promise<void> {
    await this.assertTeamMember(teamId, userId);
  }

  private async assertTeamOwner(teamId: string, userId: string) {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m || m.role !== 'OWNER') {
      throw new ForbiddenException('Only the team owner can manage billing');
    }
  }

  private async assertTeamMember(teamId: string, userId: string) {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this team');
  }

  // ── Setup Intent & Payment Method ────────────────────

  /** Create a SetupIntent for adding a card on-site */
  async createSetupIntent(teamId: string, userId: string) {
    await this.assertTeamOwner(teamId, userId);

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (!sub) throw new BadRequestException('No subscription found');

    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!team || !user) throw new NotFoundException('Team or user not found');

    let customerId = sub.stripeCustomerId;
    if (!customerId) {
      const customer = await this.stripe.getOrCreateCustomer({
        teamId,
        teamName: team.name,
        email: user.email,
      });
      customerId = customer.id;
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const intent = await this.stripe.createSetupIntent(customerId);
    return { clientSecret: intent.client_secret, customerId };
  }

  /** Attach payment method after SetupIntent confirmation */
  async attachPaymentMethod(teamId: string, userId: string, paymentMethodId: string) {
    await this.assertTeamOwner(teamId, userId);

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (!sub?.stripeCustomerId) throw new BadRequestException('No Stripe customer found');

    // Reject non-credit cards (debit, prepaid, unknown)
    const pm = await this.stripe.retrievePaymentMethod(paymentMethodId);
    if (pm.card?.funding !== 'credit') {
      throw new BadRequestException(
        'Only credit cards are accepted. Please use a credit card to continue.',
      );
    }

    await this.stripe.attachPaymentMethod(sub.stripeCustomerId, paymentMethodId);
    await this.stripe.setDefaultPaymentMethod(sub.stripeCustomerId, paymentMethodId);
    this.logger.log(`Payment method ${paymentMethodId} attached for team ${teamId}`);

    return { success: true };
  }

  // ── Subscription Management ──────────────────────────

  /** Cancel subscription at period end */
  async cancelSubscription(teamId: string, userId: string) {
    await this.assertTeamOwner(teamId, userId);

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (!sub?.stripeSubscriptionId) {
      throw new BadRequestException('No active Stripe subscription to cancel');
    }

    await this.stripe.cancelSubscription(sub.stripeSubscriptionId);
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: true },
    });

    this.logger.log(`Subscription canceled for team ${teamId}`);
    this.realtime.publish({
      entityType: 'billing', action: 'subscription_canceled', entityId: teamId,
      actorUserId: userId, teamId,
    }).catch(() => {});
    return { message: 'Subscription will cancel at end of billing period' };
  }

  /** Resume a subscription that was set to cancel */
  async resumeSubscription(teamId: string, userId: string) {
    await this.assertTeamOwner(teamId, userId);

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (!sub?.stripeSubscriptionId) {
      throw new BadRequestException('No Stripe subscription to resume');
    }

    await this.stripe.resumeSubscription(sub.stripeSubscriptionId);
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { cancelAtPeriodEnd: false },
    });

    this.logger.log(`Subscription resumed for team ${teamId}`);
    this.realtime.publish({
      entityType: 'billing', action: 'subscription_resumed', entityId: teamId,
      actorUserId: userId, teamId,
    }).catch(() => {});
    return { message: 'Subscription resumed' };
  }

  /** Change subscription plan */
  /**
   * Change plan with PREPAID model:
   * 1. Charge immediately (no trial)
   * 2. Calculate proration credit from previous plan
   * 3. Set nextBillingDate for recurring charge
   * 4. Create invoice record
   */
  async changePlan(teamId: string, userId: string, newPlanName: string) {
    await this.assertTeamOwner(teamId, userId);

    let newPlan = await this.getPlanByName(newPlanName);
    if (!newPlan.stripePriceId) {
      if (!this.stripe.isEnabled() || newPlan.priceMonthly <= 0) {
        throw new BadRequestException(`Plan "${newPlanName}" has no Stripe price`);
      }
      newPlan = await this.ensureStripePlanArtifacts(newPlan);
    }

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (!sub) {
      throw new BadRequestException('No active subscription found');
    }

    const currentPlan = await this.prisma.plan.findUnique({ where: { id: sub.planId } });
    if (!currentPlan) {
      throw new NotFoundException('Current plan not found');
    }

    if (currentPlan.id === newPlan.id) {
      return { message: `You are already on ${newPlan.displayName}` };
    }

    // Business rule: downgrades not allowed mid-cycle
    if (newPlan.priceMonthly < currentPlan.priceMonthly) {
      const periodText = sub.currentPeriodEnd
        ? ` Current billing cycle ends on ${sub.currentPeriodEnd.toISOString()}.`
        : '';
      throw new BadRequestException(
        `Downgrade is not allowed after an upgrade in the active billing period. Current plan is ${currentPlan.displayName}.${periodText}`,
      );
    }

    if (!sub?.stripeCustomerId) {
      throw new BadRequestException('No payment method on file. Add a card first.');
    }

    const pm = await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId);
    if (!pm) {
      throw new BadRequestException('No payment method on file. Add a card first.');
    }

    // Calculate proration credit (remaining value from current plan)
    const prorationCredit = this.calculateProrationCredit(
      currentPlan.priceMonthly,
      sub.currentPeriodStart || new Date(),
      sub.currentPeriodEnd || new Date(),
    );

    // Calculate amount to charge immediately
    const amountDue = Math.max(0, newPlan.priceMonthly - prorationCredit);

    // Calculate next billing date (same day of month, next month)
    const now = new Date();
    const billingDayOfMonth = now.getDate();
    const nextBillingDate = new Date(now);
    nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
    nextBillingDate.setDate(billingDayOfMonth);
    nextBillingDate.setHours(now.getHours(), 0, 0, 0);

    // Invoice exists as soon as the plan change is initiated (open → paid or unpaid).
    const upgradeInvoice = await this.prisma.invoice.create({
      data: {
        teamId,
        stripeInvoiceId: null,
        amountDue,
        amountPaid: 0,
        currency: 'usd',
        status: amountDue > 0 ? 'open' : 'paid',
        periodStart: now,
        periodEnd: nextBillingDate,
        retryCount: 0,
      },
    });

    // PREPAID: Charge immediately when there is an amount due
    let paymentIntent: any;
    if (amountDue > 0) {
      try {
        paymentIntent = await this.stripe.createPaymentIntent({
          amount: amountDue,
          currency: 'usd',
          customerId: sub.stripeCustomerId,
          paymentMethodId: pm.id,
          metadata: {
            teamId,
            planId: newPlan.id,
            type: 'plan_upgrade',
          },
        });

        if (paymentIntent.status !== 'succeeded') {
          throw new BadRequestException(
            `Payment failed: ${paymentIntent.status}. Please check your payment method.`,
          );
        }
      } catch (err: any) {
        this.logger.error(`Payment failed for team ${teamId}: ${err.message}`);
        await this.prisma.invoice.update({
          where: { id: upgradeInvoice.id },
          data: { status: 'unpaid' },
        });
        const firstFailureAt = sub.firstFailureAt ?? new Date();
        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: {
            pendingPlanId: newPlan.id,
            pendingAmountDue: amountDue,
            firstFailureAt,
            lastRetryDate: new Date(),
            retryCount: { increment: 1 },
            status: 'PAST_DUE',
          },
        });
        throw new BadRequestException(`Payment failed: ${err.message}`);
      }
    }

    // Update subscription (paid path or $0 upgrade)
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: {
        planId: newPlan.id,
        status: 'ACTIVE',
        currentPeriodStart: now,
        currentPeriodEnd: nextBillingDate,
        nextBillingDate,
        billingDayOfMonth,
        retryCount: 0,
        lastRetryDate: null,
        firstFailureAt: null,
        pendingPlanId: null,
        pendingAmountDue: null,
      },
    });

    await this.prisma.invoice.update({
      where: { id: upgradeInvoice.id },
      data: {
        stripeInvoiceId: paymentIntent?.id || null,
        amountPaid: amountDue,
        status: 'paid',
      },
    });

    // Ensure team account is active
    await this.prisma.team.update({
      where: { id: teamId },
      data: { accountStatus: 'ACTIVE' },
    });

    this.logger.log(
      `Team ${teamId} upgraded to ${newPlanName}. Charged $${(amountDue / 100).toFixed(2)} (proration credit: $${(prorationCredit / 100).toFixed(2)})`,
    );
    this.realtime.publish({
      entityType: 'billing', action: 'plan_changed', entityId: teamId,
      actorUserId: userId, teamId,
      payload: { planName: newPlan.displayName },
    }).catch(() => {});

    return {
      message: `Plan upgraded to ${newPlan.displayName}`,
      billing: {
        dueNow: amountDue,
        charged: amountDue,
        prorationCredit,
        nextBillingDate: nextBillingDate.toISOString(),
        currency: 'usd',
      },
    };
  }

  /**
   * Calculate proration credit: remaining value from current plan
   * based on unused days in the current billing period.
   */
  private calculateProrationCredit(
    currentPlanPrice: number,
    periodStart: Date,
    periodEnd: Date,
  ): number {
    const now = new Date();
    const totalMs = periodEnd.getTime() - periodStart.getTime();
    const remainingMs = periodEnd.getTime() - now.getTime();

    if (remainingMs <= 0 || totalMs <= 0) {
      return 0;
    }

    const remainingRatio = remainingMs / totalMs;
    const credit = Math.round(currentPlanPrice * remainingRatio);

    return Math.max(0, credit);
  }

  /**
   * Charge recurring subscriptions (called by cronjob)
   * Returns list of teams processed with their charge status
   */
  /** Freeze accounts whose first payment failure is more than 3 days old */
  private async freezeOverdueAccounts(): Promise<void> {
    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const overdue = await this.prisma.subscription.findMany({
      where: {
        firstFailureAt: { not: null, lt: cutoff },
        team: { accountStatus: 'ACTIVE' },
      },
      select: { id: true, teamId: true, firstFailureAt: true },
    });

    for (const sub of overdue) {
      await this.prisma.team.update({
        where: { id: sub.teamId },
        data: { accountStatus: 'FROZEN' },
      });
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'PAST_DUE' },
      });
      this.logger.warn(
        `Account frozen for team ${sub.teamId} (time-based): firstFailureAt=${sub.firstFailureAt?.toISOString()}`,
      );
    }
  }

  async processRecurringCharges(): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    details: Array<{ teamId: string; status: 'success' | 'failed' | 'retry' | 'frozen'; message?: string }>;
  }> {
    // Freeze accounts that have had an unresolved failure for 3+ days
    await this.freezeOverdueAccounts();

    const today = new Date();
    const dayOfMonth = today.getDate();
    const startOfLocalDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const graceStart = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);

    const scheduled = await this.prisma.subscription.findMany({
      where: {
        billingDayOfMonth: dayOfMonth,
        status: 'ACTIVE',
        team: { accountStatus: 'ACTIVE' },
        pendingPlanId: null,
      },
      include: { team: true, plan: true },
    });

    const retryCandidates = await this.prisma.subscription.findMany({
      where: {
        team: { accountStatus: 'ACTIVE' },
        firstFailureAt: { not: null, gte: graceStart },
        retryCount: { lt: 3 },
        OR: [{ pendingPlanId: { not: null } }, { status: 'PAST_DUE' }],
      },
      include: { team: true, plan: true },
    });

    const byId = new Map<string, (typeof scheduled)[number]>();
    for (const s of scheduled) byId.set(s.id, s);
    for (const s of retryCandidates) {
      if (!byId.has(s.id)) byId.set(s.id, s);
    }

    this.logger.log(
      `Processing recurring/retry charges for day ${dayOfMonth}. Unique subscriptions: ${byId.size}`,
    );

    const results: Array<{ teamId: string; status: 'success' | 'failed' | 'retry' | 'frozen'; message?: string }> =
      [];
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const sub of byId.values()) {
      if (sub.lastRetryDate && sub.lastRetryDate >= startOfLocalDay) {
        skipped++;
        continue;
      }
      try {
        const result = await this.chargeSubscription(sub.teamId, sub.id);
        results.push(result);
        if (result.status === 'success') {
          succeeded++;
        } else {
          failed++;
        }
      } catch (err: any) {
        this.logger.error(`Failed to process subscription ${sub.id}: ${err.message}`);
        results.push({
          teamId: sub.teamId,
          status: 'failed',
          message: err.message,
        });
        failed++;
      }
    }

    return {
      processed: byId.size - skipped,
      succeeded,
      failed,
      details: results,
    };
  }

  /**
   * Charge a single subscription (for recurring billing or retry)
   * Implements 3-day retry logic and account freeze
   */
  private async chargeSubscription(
    teamId: string,
    subscriptionId: string,
  ): Promise<{ teamId: string; status: 'success' | 'failed' | 'retry' | 'frozen'; message?: string }> {
    const sub = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      include: { plan: true, team: true },
    });

    if (!sub) {
      throw new NotFoundException(`Subscription not found: ${subscriptionId}`);
    }

    if (!sub.stripeCustomerId) {
      throw new BadRequestException('No payment method on file');
    }

    const pm = await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId);
    if (!pm) {
      throw new BadRequestException('No payment method on file');
    }

    const hasPendingUpgrade =
      sub.pendingPlanId != null &&
      sub.pendingAmountDue != null &&
      sub.pendingAmountDue > 0;
    const amountDue = hasPendingUpgrade ? sub.pendingAmountDue! : sub.plan.priceMonthly;

    try {
      const paymentIntent = await this.stripe.createPaymentIntent({
        amount: amountDue,
        currency: 'usd',
        customerId: sub.stripeCustomerId,
        paymentMethodId: pm.id,
        metadata: {
          teamId: sub.teamId,
          subscriptionId: sub.id,
          type: hasPendingUpgrade ? 'pending_plan_charge' : 'recurring_charge',
        },
      });

      if (paymentIntent.status === 'succeeded') {
        const now = new Date();
        const nextBillingDate = new Date(now);
        nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
        nextBillingDate.setDate(sub.billingDayOfMonth || now.getDate());

        if (hasPendingUpgrade && sub.pendingPlanId) {
          const openInv = await this.prisma.invoice.findFirst({
            where: {
              teamId: sub.teamId,
              status: { in: ['open', 'unpaid'] },
              amountPaid: 0,
            },
            orderBy: { createdAt: 'desc' },
          });
          if (openInv) {
            await this.prisma.invoice.update({
              where: { id: openInv.id },
              data: {
                status: 'paid',
                amountPaid: amountDue,
                stripeInvoiceId: paymentIntent.id,
              },
            });
          } else {
            await this.prisma.invoice.create({
              data: {
                teamId: sub.teamId,
                stripeInvoiceId: paymentIntent.id,
                amountDue,
                amountPaid: amountDue,
                currency: 'usd',
                status: 'paid',
                periodStart: now,
                periodEnd: nextBillingDate,
                retryCount: 0,
              },
            });
          }

          await this.prisma.subscription.update({
            where: { id: sub.id },
            data: {
              planId: sub.pendingPlanId,
              pendingPlanId: null,
              pendingAmountDue: null,
              status: 'ACTIVE',
              currentPeriodStart: now,
              currentPeriodEnd: nextBillingDate,
              nextBillingDate,
              billingDayOfMonth: sub.billingDayOfMonth || now.getDate(),
              retryCount: 0,
              lastRetryDate: null,
              firstFailureAt: null,
            },
          });

          await this.prisma.team.update({
            where: { id: sub.teamId },
            data: { accountStatus: 'ACTIVE' },
          });

          this.logger.log(
            `Pending plan charge succeeded for team ${teamId}. Amount: $${(amountDue / 100).toFixed(2)}`,
          );
          return { teamId, status: 'success' };
        }

        await this.prisma.subscription.update({
          where: { id: sub.id },
          data: {
            currentPeriodStart: now,
            currentPeriodEnd: nextBillingDate,
            nextBillingDate,
            retryCount: 0,
            lastRetryDate: null,
            firstFailureAt: null,
          },
        });

        // Reuse an existing open/unpaid draft for this team instead of creating a
        // second record — otherwise the paid charge and the leftover draft both
        // show up and the user sees a phantom outstanding balance (duplicate invoice).
        const openInv = await this.prisma.invoice.findFirst({
          where: {
            teamId: sub.teamId,
            status: { in: ['open', 'unpaid'] },
            amountPaid: 0,
          },
          orderBy: { createdAt: 'desc' },
        });
        if (openInv) {
          await this.prisma.invoice.update({
            where: { id: openInv.id },
            data: {
              status: 'paid',
              amountPaid: amountDue,
              stripeInvoiceId: paymentIntent.id,
              periodStart: now,
              periodEnd: nextBillingDate,
            },
          });
        } else {
          await this.prisma.invoice.create({
            data: {
              teamId: sub.teamId,
              stripeInvoiceId: paymentIntent.id,
              amountDue,
              amountPaid: amountDue,
              currency: 'usd',
              status: 'paid',
              periodStart: now,
              periodEnd: nextBillingDate,
              retryCount: 0,
            },
          });
        }

        this.logger.log(
          `Recurring charge succeeded for team ${teamId}. Amount: $${(amountDue / 100).toFixed(2)}`,
        );

        return { teamId, status: 'success' };
      } else {
        return await this.handleFailedPayment(sub.id, sub.teamId, sub.retryCount, amountDue);
      }
    } catch (err: any) {
      this.logger.error(`Payment failed for team ${teamId}: ${err.message}`);
      return await this.handleFailedPayment(sub.id, sub.teamId, sub.retryCount, amountDue);
    }
  }

  /**
   * Handle failed payment: increment retry; freeze is time-based (firstFailureAt + 3d) in freezeOverdueAccounts.
   */
  private async handleFailedPayment(
    subscriptionId: string,
    teamId: string,
    currentRetryCount: number,
    chargeAmountCents: number,
  ): Promise<{ teamId: string; status: 'retry'; message: string }> {
    const newRetryCount = currentRetryCount + 1;

    const existing = await this.prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { firstFailureAt: true },
    });
    const firstFailureAt = existing?.firstFailureAt ?? new Date();

    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: 'PAST_DUE',
        retryCount: newRetryCount,
        lastRetryDate: new Date(),
        firstFailureAt,
      },
    });

    if (chargeAmountCents > 0) {
      const openUnpaid = await this.prisma.invoice.findFirst({
        where: {
          teamId,
          status: { in: ['open', 'unpaid'] },
          amountPaid: 0,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!openUnpaid) {
        await this.prisma.invoice.create({
          data: {
            teamId,
            stripeInvoiceId: null,
            amountDue: chargeAmountCents,
            amountPaid: 0,
            currency: 'usd',
            status: 'unpaid',
            periodStart: new Date(),
            periodEnd: null,
            retryCount: newRetryCount,
          },
        });
      }
    }

    this.logger.warn(
      `Payment failed for team ${teamId}. Retry count=${newRetryCount}/3 (account freezes after 3 days if still unpaid)`,
    );

    return {
      teamId,
      status: 'retry',
      message: `Payment failed. Retry ${newRetryCount}/3`,
    };
  }

  /**
   * Retry payment for a frozen or past_due account (called from UI)
   */
  async retryPayment(
    teamId: string,
    userId: string,
    newPaymentMethodId?: string,
  ): Promise<{ message: string; success: boolean }> {
    await this.assertTeamOwner(teamId, userId);

    const sub = await this.prisma.subscription.findUnique({
      where: { teamId },
      include: { plan: true },
    });

    if (!sub) {
      throw new NotFoundException('No subscription found');
    }

    if (!sub.stripeCustomerId) {
      throw new BadRequestException('No Stripe customer');
    }

    // Update payment method if provided
    if (newPaymentMethodId) {
      // Reject non-credit cards
      const newPm = await this.stripe.retrievePaymentMethod(newPaymentMethodId);
      if (newPm.card?.funding !== 'credit') {
        throw new BadRequestException(
          'Only credit cards are accepted. Please use a credit card to continue.',
        );
      }
      await this.stripe.attachPaymentMethod(sub.stripeCustomerId, newPaymentMethodId);
      await this.stripe.setDefaultPaymentMethod(sub.stripeCustomerId, newPaymentMethodId);
      this.logger.log(`Payment method updated for team ${teamId}`);
    }

    const pm = await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId);
    if (!pm) {
      throw new BadRequestException('No payment method on file. Please add a card first.');
    }

    const hasPendingUpgrade =
      sub.pendingPlanId != null &&
      sub.pendingAmountDue != null &&
      sub.pendingAmountDue > 0;
    const amountDue = hasPendingUpgrade ? sub.pendingAmountDue! : sub.plan.priceMonthly;

    try {
      const paymentIntent = await this.stripe.createPaymentIntent({
        amount: amountDue,
        currency: 'usd',
        customerId: sub.stripeCustomerId,
        paymentMethodId: pm.id,
        metadata: {
          teamId,
          subscriptionId: sub.id,
          type: hasPendingUpgrade ? 'pending_plan_retry' : 'retry_payment',
        },
      });

      if (paymentIntent.status === 'succeeded') {
        const now = new Date();
        const nextBillingDate = new Date(now);
        nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
        nextBillingDate.setDate(sub.billingDayOfMonth || now.getDate());

        await this.prisma.team.update({
          where: { id: teamId },
          data: { accountStatus: 'ACTIVE' },
        });

        if (hasPendingUpgrade && sub.pendingPlanId) {
          const openInv = await this.prisma.invoice.findFirst({
            where: {
              teamId,
              status: { in: ['open', 'unpaid'] },
              amountPaid: 0,
            },
            orderBy: { createdAt: 'desc' },
          });
          if (openInv) {
            await this.prisma.invoice.update({
              where: { id: openInv.id },
              data: {
                status: 'paid',
                amountPaid: amountDue,
                stripeInvoiceId: paymentIntent.id,
              },
            });
          } else {
            await this.prisma.invoice.create({
              data: {
                teamId,
                stripeInvoiceId: paymentIntent.id,
                amountDue,
                amountPaid: amountDue,
                currency: 'usd',
                status: 'paid',
                periodStart: now,
                periodEnd: nextBillingDate,
                retryCount: 0,
              },
            });
          }

          await this.prisma.subscription.update({
            where: { id: sub.id },
            data: {
              planId: sub.pendingPlanId,
              pendingPlanId: null,
              pendingAmountDue: null,
              status: 'ACTIVE',
              currentPeriodStart: now,
              currentPeriodEnd: nextBillingDate,
              nextBillingDate,
              billingDayOfMonth: sub.billingDayOfMonth || now.getDate(),
              retryCount: 0,
              lastRetryDate: null,
              firstFailureAt: null,
            },
          });
        } else {
          await this.prisma.subscription.update({
            where: { id: sub.id },
            data: {
              status: 'ACTIVE',
              currentPeriodStart: now,
              currentPeriodEnd: nextBillingDate,
              nextBillingDate,
              retryCount: 0,
              lastRetryDate: null,
              firstFailureAt: null,
            },
          });

          await this.prisma.invoice.create({
            data: {
              teamId,
              stripeInvoiceId: paymentIntent.id,
              amountDue,
              amountPaid: amountDue,
              currency: 'usd',
              status: 'paid',
              periodStart: now,
              periodEnd: nextBillingDate,
              retryCount: 0,
            },
          });
        }

        this.logger.log(`Retry payment succeeded for team ${teamId}. Account unfrozen.`);

        return { message: 'Payment successful. Your account is now active.', success: true };
      } else {
        throw new BadRequestException(`Payment failed: ${paymentIntent.status}`);
      }
    } catch (err: any) {
      this.logger.error(`Retry payment failed for team ${teamId}: ${err.message}`);
      throw new BadRequestException(`Payment failed: ${err.message}`);
    }
  }

  /**
   * Preview plan change with PREPAID model:
   * Shows proration credit and amount due immediately.
   */
  async previewPlanChange(teamId: string, userId: string, newPlanName: string) {
    await this.assertTeamOwner(teamId, userId);

    let newPlan = await this.getPlanByName(newPlanName);
    if (!newPlan.stripePriceId) {
      if (!this.stripe.isEnabled() || newPlan.priceMonthly <= 0) {
        throw new BadRequestException(`Plan "${newPlanName}" has no Stripe price`);
      }
      newPlan = await this.ensureStripePlanArtifacts(newPlan);
    }

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (!sub) {
      throw new BadRequestException('No active subscription found');
    }
    const currentPlan = await this.prisma.plan.findUnique({ where: { id: sub.planId } });
    if (!currentPlan) {
      throw new NotFoundException('Current plan not found');
    }
    if (newPlan.priceMonthly < currentPlan.priceMonthly) {
      throw new BadRequestException('Downgrade preview is not supported');
    }

    // Calculate proration credit
    const prorationCredit = this.calculateProrationCredit(
      currentPlan.priceMonthly,
      sub.currentPeriodStart || new Date(),
      sub.currentPeriodEnd || new Date(),
    );

    const amountDue = Math.max(0, newPlan.priceMonthly - prorationCredit);

    const now = new Date();
    const billingDayOfMonth = now.getDate();
    const nextBillingDate = new Date(now);
    nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
    nextBillingDate.setDate(billingDayOfMonth);

    return {
      currentPlan: {
        name: currentPlan.name,
        displayName: currentPlan.displayName,
        priceMonthly: currentPlan.priceMonthly,
      },
      targetPlan: {
        name: newPlan.name,
        displayName: newPlan.displayName,
        priceMonthly: newPlan.priceMonthly,
      },
      currency: 'usd',
      dueNow: amountDue,
      subtotal: newPlan.priceMonthly,
      prorationCredit,
      prorationTotal: prorationCredit,
      total: amountDue,
      nextPaymentAt: nextBillingDate.toISOString(),
      currentPeriodEnd: sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
      lines: [
        {
          description: `basefyio ${newPlan.displayName} (full month)`,
          amount: newPlan.priceMonthly,
          currency: 'usd',
          proration: false,
        },
        {
          description: `Credit from ${currentPlan.displayName} (unused time)`,
          amount: prorationCredit,
          currency: 'usd',
          proration: true,
        },
      ],
    };
  }

  // ── Billing Account ──────────────────────────────────

  async getBillingAccount(teamId: string) {
    return this.prisma.billingAccount.findUnique({ where: { teamId } });
  }

  async upsertBillingAccount(
    teamId: string,
    userId: string,
    data: {
      companyName?: string;
      taxId?: string;
      vatNumber?: string;
      addressLine1?: string;
      addressLine2?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
      billingEmail?: string;
      phone?: string;
    },
  ) {
    await this.assertTeamOwner(teamId, userId);

    const account = await this.prisma.billingAccount.upsert({
      where: { teamId },
      update: data,
      create: { teamId, ...data },
    });

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (sub?.stripeCustomerId && this.stripe.isEnabled()) {
      try {
        await this.stripe.updateCustomer(sub.stripeCustomerId, {
          name: data.companyName || undefined,
          email: data.billingEmail || undefined,
          phone: data.phone || undefined,
          address: {
            line1: data.addressLine1 || undefined,
            line2: data.addressLine2 || undefined,
            city: data.city || undefined,
            state: data.state || undefined,
            postal_code: data.postalCode || undefined,
            country: data.country || undefined,
          },
        });

        if (data.taxId) {
          try {
            await this.stripe.addCustomerTaxId(sub.stripeCustomerId, 'eu_vat', data.taxId);
          } catch {
            this.logger.warn(`Could not add tax ID for team ${teamId}`);
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to sync billing account to Stripe for team ${teamId}: ${err.message}`);
      }
    }

    return account;
  }

  async getPaymentMethod(teamId: string, userId: string) {
    await this.assertTeamMember(teamId, userId);

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (!sub?.stripeCustomerId || !this.stripe.isEnabled()) return null;

    try {
      const pm = await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId);
      if (!pm) return null;
      return {
        brand: pm.card?.brand || null,
        last4: pm.card?.last4 || null,
        expMonth: pm.card?.exp_month || null,
        expYear: pm.card?.exp_year || null,
      };
    } catch {
      return null;
    }
  }

  async listManagementPlans() {
    return this.getAllPlans();
  }

  async updateManagementPlan(
    planName: string,
    data: {
      displayName?: string;
      priceMonthly?: number;
      maxProjects?: number | null;
      maxStorageBytes?: bigint | null;
      maxTeamMembers?: number | null;
      maxDbSizeBytes?: bigint | null;
      maxApiRequests?: number | null;
      maxBandwidthBytes?: bigint | null;
      maxMau?: number | null;
      isPublic?: boolean;
    },
  ) {
    const plan = await this.getPlanByName(planName);
    const prevPrice = plan.priceMonthly;
    const updated = await this.prisma.plan.update({
      where: { id: plan.id },
      data,
    });
    if (this.stripe.isEnabled()) {
      try {
        if (updated.stripeProductId) {
          await this.stripe.getClient().products.update(updated.stripeProductId, {
            name: `basefyio ${updated.displayName}`,
          });
        } else if (updated.priceMonthly > 0) {
          const product = await this.stripe.createProduct(
            `basefyio ${updated.displayName}`,
            `${updated.displayName} plan`,
          );
          await this.prisma.plan.update({
            where: { id: updated.id },
            data: { stripeProductId: product.id },
          });
          updated.stripeProductId = product.id;
        }

        if (updated.priceMonthly > 0 && updated.stripeProductId) {
          let nextPriceId = updated.stripePriceId;
          if (!nextPriceId || prevPrice !== updated.priceMonthly) {
            const price = await this.stripe.createPrice({
              productId: updated.stripeProductId,
              unitAmount: updated.priceMonthly,
              currency: 'usd',
              interval: 'month',
            });
            nextPriceId = price.id;
            await this.prisma.plan.update({
              where: { id: updated.id },
              data: { stripePriceId: nextPriceId },
            });
            updated.stripePriceId = nextPriceId;
          }
          if (prevPrice !== updated.priceMonthly && nextPriceId) {
            const subs = await this.prisma.subscription.findMany({
              where: { planId: updated.id, stripeSubscriptionId: { not: null } },
              select: { id: true, stripeSubscriptionId: true },
            });
            for (const s of subs) {
              if (!s.stripeSubscriptionId) continue;
              try {
                await this.stripe.changeSubscriptionPlan(s.stripeSubscriptionId, nextPriceId);
              } catch (err: any) {
                this.logger.warn(
                  `Failed to migrate stripe subscription ${s.id} to new price: ${err.message}`,
                );
              }
            }
          }
        }
      } catch (err: any) {
        this.logger.warn(`Stripe sync failed on plan update (${updated.name}): ${err.message}`);
      }
    }
    return updated;
  }

  async deleteManagementPlan(planName: string, replacementPlanName = 'free') {
    const plan = await this.getPlanByName(planName);
    if (plan.name === 'free') {
      throw new BadRequestException('Free plan cannot be deleted');
    }
    const replacement = await this.getPlanByName(replacementPlanName);
    if (replacement.id === plan.id) {
      throw new BadRequestException('Replacement plan must be different');
    }
    const subs = await this.prisma.subscription.findMany({
      where: { planId: plan.id },
      select: { id: true, stripeSubscriptionId: true },
    });
    if (this.stripe.isEnabled() && replacement.stripePriceId) {
      for (const s of subs) {
        if (!s.stripeSubscriptionId) continue;
        try {
          await this.stripe.changeSubscriptionPlan(s.stripeSubscriptionId, replacement.stripePriceId);
        } catch (err: any) {
          this.logger.warn(
            `Failed to migrate stripe subscription ${s.id} while deleting plan ${plan.name}: ${err.message}`,
          );
        }
      }
    }
    await this.prisma.subscription.updateMany({
      where: { planId: plan.id },
      data: { planId: replacement.id },
    });
    await this.prisma.plan.delete({ where: { id: plan.id } });
    return {
      deletedPlan: plan.name,
      replacementPlan: replacement.name,
      migratedSubscriptions: subs.length,
    };
  }

  async createManagementPlan(data: {
    name: string;
    displayName: string;
    priceMonthly?: number;
    maxProjects?: number | null;
    maxStorageBytes?: bigint | null;
    maxTeamMembers?: number | null;
    maxDbSizeBytes?: bigint | null;
    maxApiRequests?: number | null;
    maxBandwidthBytes?: bigint | null;
    maxMau?: number | null;
    isPublic?: boolean;
  }) {
    const name = data.name.trim().toLowerCase();
    const displayName = data.displayName.trim();
    if (!name || !displayName) {
      throw new BadRequestException('Plan name and display name are required');
    }
    let created = await this.prisma.plan.create({
      data: {
        name,
        displayName,
        priceMonthly: data.priceMonthly ?? 0,
        maxProjects: data.maxProjects ?? null,
        maxStorageBytes: data.maxStorageBytes ?? null,
        maxTeamMembers: data.maxTeamMembers ?? null,
        maxDbSizeBytes: data.maxDbSizeBytes ?? null,
        maxApiRequests: data.maxApiRequests ?? null,
        maxBandwidthBytes: data.maxBandwidthBytes ?? null,
        maxMau: data.maxMau ?? null,
        isPublic: data.isPublic ?? true,
      },
    });
    if (this.stripe.isEnabled() && created.priceMonthly > 0) {
      try {
        const product = await this.stripe.createProduct(
          `basefyio ${created.displayName}`,
          `${created.displayName} plan`,
        );
        const price = await this.stripe.createPrice({
          productId: product.id,
          unitAmount: created.priceMonthly,
          currency: 'usd',
          interval: 'month',
        });
        created = await this.prisma.plan.update({
          where: { id: created.id },
          data: { stripeProductId: product.id, stripePriceId: price.id },
        });
      } catch (err: any) {
        this.logger.warn(`Stripe setup failed for new plan ${created.name}: ${err.message}`);
      }
    }
    return created;
  }

  private mapUsersToManagementPackages(
    users: Array<{
      id: string;
      email: string;
      personalTeam: {
        id: string;
        name: string;
        subscription: {
          status: string;
          plan: { name: string; displayName: string; priceMonthly: number };
        } | null;
      } | null;
    }>,
  ) {
    return users.map((u) => ({
      userId: u.id,
      email: u.email,
      teamId: u.personalTeam?.id ?? null,
      teamName: u.personalTeam?.name ?? null,
      planName: u.personalTeam?.subscription?.plan?.name ?? null,
      planDisplayName: u.personalTeam?.subscription?.plan?.displayName ?? null,
      planPriceMonthly: u.personalTeam?.subscription?.plan?.priceMonthly ?? null,
      subscriptionStatus: u.personalTeam?.subscription?.status ?? null,
    }));
  }

  async listManagementUserPackages() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        personalTeam: {
          select: {
            id: true,
            name: true,
            subscription: {
              select: {
                status: true,
                plan: {
                  select: { name: true, displayName: true, priceMonthly: true },
                },
              },
            },
          },
        },
      },
    });

    return this.mapUsersToManagementPackages(users);
  }

  async listManagementUserPackagesForUserIds(userIds: string[]) {
    const unique = [...new Set(userIds.filter((id) => typeof id === 'string' && id.length > 0))].slice(
      0,
      100,
    );
    if (unique.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: {
        id: true,
        email: true,
        personalTeam: {
          select: {
            id: true,
            name: true,
            subscription: {
              select: {
                status: true,
                plan: {
                  select: { name: true, displayName: true, priceMonthly: true },
                },
              },
            },
          },
        },
      },
    });

    return this.mapUsersToManagementPackages(users);
  }

  async updateManagementUserPackage(userId: string, planName: string) {
    const plan = await this.getPlanByName(planName);
    const personalTeam = await this.prisma.team.findUnique({
      where: { personalForUserId: userId },
      select: { id: true, name: true },
    });
    if (!personalTeam) {
      throw new NotFoundException('Personal team not found for this user');
    }

    await this.prisma.subscription.upsert({
      where: { teamId: personalTeam.id },
      update: { planId: plan.id, status: 'ACTIVE' },
      create: { teamId: personalTeam.id, planId: plan.id, status: 'ACTIVE' },
    });

    return {
      userId,
      teamId: personalTeam.id,
      teamName: personalTeam.name,
      planName: plan.name,
      planDisplayName: plan.displayName,
      planPriceMonthly: plan.priceMonthly,
    };
  }
}
