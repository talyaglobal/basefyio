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

@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
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
        let productId = plan.stripeProductId;
        if (!productId) {
          const product = await this.stripe.createProduct(
            `Kolaybase ${plan.displayName}`,
            `${plan.displayName} plan — ${plan.maxProjects || 'unlimited'} projects, ${plan.dedicatedDb ? 'dedicated' : 'shared'} database`,
          );
          productId = product.id;
          await this.prisma.plan.update({
            where: { id: plan.id },
            data: { stripeProductId: productId },
          });
          this.logger.log(`Stripe product created for ${plan.name}: ${productId}`);
        }

        if (!plan.stripePriceId) {
          const price = await this.stripe.createPrice({
            productId,
            unitAmount: plan.priceMonthly,
            currency: 'usd',
            interval: 'month',
          });
          await this.prisma.plan.update({
            where: { id: plan.id },
            data: { stripePriceId: price.id },
          });
          this.logger.log(`Stripe price created for ${plan.name}: ${price.id} ($${(plan.priceMonthly / 100).toFixed(2)}/mo)`);
        }
      } catch (err: any) {
        this.logger.error(`Failed to sync plan ${plan.name} with Stripe: ${err.message}`);
      }
    }
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
      include: { plan: true },
    });

    if (!sub) {
      this.logger.warn(`No subscription for team ${teamId} — auto-creating Free subscription`);
      try {
        await this.createFreeSubscription(teamId);
        sub = await this.prisma.subscription.findUnique({
          where: { teamId },
          include: { plan: true },
        });
      } catch (err: any) {
        this.logger.error(`Failed to auto-create Free subscription for team ${teamId}: ${err.message}`);
        return null;
      }
    }

    return sub;
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

    const plan = await this.getPlanByName(planName);
    if (!plan.stripePriceId) {
      throw new BadRequestException(`Plan "${planName}" is not a paid plan`);
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
      priceId: plan.stripePriceId,
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

    const localInvoices = await this.prisma.invoice.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return localInvoices;
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
      update: { status: 'payment_failed' },
      create: {
        teamId: sub.teamId,
        stripeInvoiceId: stripeInvoice.id,
        amountDue: stripeInvoice.amount_due || 0,
        amountPaid: 0,
        currency: stripeInvoice.currency || 'usd',
        status: 'payment_failed',
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

    await this.stripe.attachPaymentMethod(sub.stripeCustomerId, paymentMethodId);
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
    return { message: 'Subscription resumed' };
  }

  /** Change subscription plan */
  async changePlan(teamId: string, userId: string, newPlanName: string) {
    await this.assertTeamOwner(teamId, userId);

    const newPlan = await this.getPlanByName(newPlanName);
    if (!newPlan.stripePriceId) {
      throw new BadRequestException(`Plan "${newPlanName}" has no Stripe price`);
    }

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });

    if (!sub?.stripeSubscriptionId) {
      if (!sub?.stripeCustomerId) {
        throw new BadRequestException('No payment method on file. Add a card first.');
      }

      const pm = await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId);
      if (!pm) {
        throw new BadRequestException('No payment method on file. Add a card first.');
      }

      const client = this.stripe.getClient();
      const stripeSub = await client.subscriptions.create({
        customer: sub.stripeCustomerId,
        items: [{ price: newPlan.stripePriceId }],
        metadata: { teamId },
        default_payment_method: pm.id,
      });

      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: {
          planId: newPlan.id,
          status: 'ACTIVE',
          stripeSubscriptionId: stripeSub.id,
          currentPeriodStart: new Date((stripeSub as any).current_period_start * 1000),
          currentPeriodEnd: new Date((stripeSub as any).current_period_end * 1000),
        },
      });

      return { message: `Subscribed to ${newPlan.displayName}` };
    }

    await this.stripe.changeSubscriptionPlan(sub.stripeSubscriptionId, newPlan.stripePriceId);
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { planId: newPlan.id },
    });

    this.logger.log(`Team ${teamId} changed plan to ${newPlanName}`);
    return { message: `Plan changed to ${newPlan.displayName}` };
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
    return this.prisma.plan.update({
      where: { id: plan.id },
      data,
    });
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
    return this.prisma.plan.create({
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
  }

  async listManagementUserPackages() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        username: true,
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

    return users.map((u) => ({
      userId: u.id,
      email: u.email,
      username: u.username,
      teamId: u.personalTeam?.id ?? null,
      teamName: u.personalTeam?.name ?? null,
      planName: u.personalTeam?.subscription?.plan?.name ?? null,
      planDisplayName: u.personalTeam?.subscription?.plan?.displayName ?? null,
      planPriceMonthly: u.personalTeam?.subscription?.plan?.priceMonthly ?? null,
      subscriptionStatus: u.personalTeam?.subscription?.status ?? null,
    }));
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
