import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  Res,
  UseGuards,
  RawBodyRequest,
  Headers,
  HttpCode,
  Logger,
  Query,
  Patch,
  Param,
  Delete,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { RequireManagementPermission } from '../../common/decorators/management-permission.decorator';
import { BillingService } from './billing.service';
import { UsageService } from './usage.service';
import { StripeService } from '../stripe/stripe.service';
import { ObservabilityService } from '../observability/observability.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestWithTraceId } from '../../common/middleware/trace-id.middleware';

const STRIPE_EMAIL_SETTINGS_KEY = 'stripe_email_summary';

@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly billing: BillingService,
    private readonly usage: UsageService,
    private readonly stripe: StripeService,
    private readonly observability: ObservabilityService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('plans')
  async getPlans() {
    return this.billing.listPlans();
  }

  @UseGuards(JwtAuthGuard)
  @Get('subscription')
  async getSubscription(@Req() req: any, @Query('teamId') teamId?: string) {
    const userId = req.user.sub;
    if (!teamId) {
      teamId = await this.billing.getUserActiveTeamId(userId);
    }
    return this.billing.getTeamSubscriptionForUser(teamId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('usage')
  async getUsage(@Req() req: any, @Query('teamId') teamId?: string) {
    const userId = req.user.sub;
    if (!teamId) {
      teamId = await this.billing.getUserActiveTeamId(userId);
    }
    await this.billing.verifyTeamMembership(teamId, userId);
    return this.usage.getTeamUsage(teamId);
  }

  @UseGuards(JwtAuthGuard)
  @Get('invoices')
  async getInvoices(@Req() req: any, @Query('teamId') teamId?: string) {
    const userId = req.user.sub;
    if (!teamId) {
      teamId = await this.billing.getUserActiveTeamId(userId);
    }
    return this.billing.getInvoices(teamId, userId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('checkout')
  async createCheckout(
    @Req() req: any,
    @Body() body: { teamId: string; planName: string; successUrl: string; cancelUrl: string },
  ) {
    return this.billing.createCheckoutSession(
      body.teamId,
      req.user.sub,
      body.planName,
      body.successUrl,
      body.cancelUrl,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('portal')
  async createPortal(
    @Req() req: any,
    @Body() body: { teamId: string; returnUrl: string },
  ) {
    return this.billing.createPortalSession(body.teamId, req.user.sub, body.returnUrl);
  }

  @UseGuards(JwtAuthGuard)
  @Get('account')
  async getBillingAccount(@Req() req: any, @Query('teamId') teamId?: string) {
    const userId = req.user.sub;
    if (!teamId) teamId = await this.billing.getUserActiveTeamId(userId);
    await this.billing.verifyTeamMembership(teamId, userId);
    return this.billing.getBillingAccount(teamId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('account')
  async updateBillingAccount(
    @Req() req: any,
    @Body() body: {
      teamId: string;
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
    const { teamId, ...data } = body;
    return this.billing.upsertBillingAccount(teamId, req.user.sub, data);
  }

  @UseGuards(JwtAuthGuard)
  @Get('payment-method')
  async getPaymentMethod(@Req() req: any, @Query('teamId') teamId?: string) {
    const userId = req.user.sub;
    if (!teamId) teamId = await this.billing.getUserActiveTeamId(userId);
    return this.billing.getPaymentMethod(teamId, userId);
  }

  /** Create a SetupIntent for adding a card via Stripe Elements */
  @UseGuards(JwtAuthGuard)
  @Post('setup-intent')
  async createSetupIntent(
    @Req() req: any,
    @Body() body: { teamId: string },
  ) {
    return this.billing.createSetupIntent(body.teamId, req.user.sub);
  }

  /** Attach payment method after card is confirmed */
  @UseGuards(JwtAuthGuard)
  @Post('attach-payment-method')
  async attachPaymentMethod(
    @Req() req: any,
    @Body() body: { teamId: string; paymentMethodId: string },
  ) {
    return this.billing.attachPaymentMethod(body.teamId, req.user.sub, body.paymentMethodId);
  }

  /** Cancel subscription at period end */
  @UseGuards(JwtAuthGuard)
  @Post('cancel')
  async cancelSubscription(
    @Req() req: any,
    @Body() body: { teamId: string },
  ) {
    return this.billing.cancelSubscription(body.teamId, req.user.sub);
  }

  /** Resume a canceled subscription */
  @UseGuards(JwtAuthGuard)
  @Post('resume')
  async resumeSubscription(
    @Req() req: any,
    @Body() body: { teamId: string },
  ) {
    return this.billing.resumeSubscription(body.teamId, req.user.sub);
  }

  /** Change subscription plan */
  @UseGuards(JwtAuthGuard)
  @Post('change-plan')
  async changePlan(
    @Req() req: any,
    @Body() body: { teamId: string; planName: string },
  ) {
    return this.billing.changePlan(body.teamId, req.user.sub, body.planName);
  }

  @UseGuards(JwtAuthGuard)
  @Post('preview-plan-change')
  async previewPlanChange(
    @Req() req: any,
    @Body() body: { teamId: string; planName: string },
  ) {
    return this.billing.previewPlanChange(body.teamId, req.user.sub, body.planName);
  }

  @UseGuards(JwtAuthGuard)
  @Post('retry-payment')
  async retryPayment(
    @Req() req: any,
    @Body() body: { teamId: string; paymentMethodId?: string },
  ) {
    return this.billing.retryPayment(body.teamId, req.user.sub, body.paymentMethodId);
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Get('management/plans')
  async managementPlans() {
    return this.billing.listManagementPlans();
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Patch('management/plans/:planName')
  async updateManagementPlan(
    @Req() req: RequestWithTraceId,
    @Param('planName') planName: string,
    @Body()
    body: {
      displayName?: string;
      priceMonthly?: number;
      maxProjects?: number | null;
      maxStorageBytes?: string | null;
      maxTeamMembers?: number | null;
      maxDbSizeBytes?: string | null;
      maxApiRequests?: number | null;
      maxBandwidthBytes?: string | null;
      maxMau?: number | null;
      isPublic?: boolean;
    },
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.billing.updateManagementPlan(planName, {
        displayName: body.displayName,
        priceMonthly: body.priceMonthly,
        maxProjects: body.maxProjects,
        maxStorageBytes:
          body.maxStorageBytes === undefined
            ? undefined
            : body.maxStorageBytes === null
              ? null
              : BigInt(body.maxStorageBytes),
        maxTeamMembers: body.maxTeamMembers,
        maxDbSizeBytes:
          body.maxDbSizeBytes === undefined
            ? undefined
            : body.maxDbSizeBytes === null
              ? null
              : BigInt(body.maxDbSizeBytes),
        maxApiRequests: body.maxApiRequests,
        maxBandwidthBytes:
          body.maxBandwidthBytes === undefined
            ? undefined
            : body.maxBandwidthBytes === null
              ? null
              : BigInt(body.maxBandwidthBytes),
        maxMau: body.maxMau,
        isPublic: body.isPublic,
      });
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: (req as any).user?.sub || 'unknown',
        action: 'BILLING_PLAN_UPDATED',
        resourceType: 'plan',
        resourceId: planName,
        severity: 'HIGH',
        success: true,
        latencyMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: (req as any).user?.sub || 'unknown',
        action: 'BILLING_PLAN_UPDATED',
        resourceType: 'plan',
        resourceId: planName,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Post('management/plans')
  async createManagementPlan(
    @Req() req: RequestWithTraceId,
    @Body()
    body: {
      name: string;
      displayName: string;
      priceMonthly?: number;
      maxProjects?: number | null;
      maxStorageBytes?: string | null;
      maxTeamMembers?: number | null;
      maxDbSizeBytes?: string | null;
      maxApiRequests?: number | null;
      maxBandwidthBytes?: string | null;
      maxMau?: number | null;
      isPublic?: boolean;
    },
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.billing.createManagementPlan({
        name: body.name,
        displayName: body.displayName,
        priceMonthly: body.priceMonthly,
        maxProjects: body.maxProjects,
        maxStorageBytes:
          body.maxStorageBytes === undefined
            ? undefined
            : body.maxStorageBytes === null
              ? null
              : BigInt(body.maxStorageBytes),
        maxTeamMembers: body.maxTeamMembers,
        maxDbSizeBytes:
          body.maxDbSizeBytes === undefined
            ? undefined
            : body.maxDbSizeBytes === null
              ? null
              : BigInt(body.maxDbSizeBytes),
        maxApiRequests: body.maxApiRequests,
        maxBandwidthBytes:
          body.maxBandwidthBytes === undefined
            ? undefined
            : body.maxBandwidthBytes === null
              ? null
              : BigInt(body.maxBandwidthBytes),
        maxMau: body.maxMau,
        isPublic: body.isPublic,
      });
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: (req as any).user?.sub || 'unknown',
        action: 'BILLING_PLAN_CREATED',
        resourceType: 'plan',
        resourceId: body.name,
        severity: 'HIGH',
        success: true,
        latencyMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: (req as any).user?.sub || 'unknown',
        action: 'BILLING_PLAN_CREATED',
        resourceType: 'plan',
        resourceId: body.name,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Delete('management/plans/:planName')
  async deleteManagementPlan(
    @Req() req: RequestWithTraceId,
    @Param('planName') planName: string,
    @Query('replacementPlanName') replacementPlanName?: string,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.billing.deleteManagementPlan(
        planName,
        replacementPlanName || 'free',
      );
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: (req as any).user?.sub || 'unknown',
        action: 'BILLING_PLAN_DELETED',
        resourceType: 'plan',
        resourceId: planName,
        severity: 'CRITICAL',
        success: true,
        latencyMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: (req as any).user?.sub || 'unknown',
        action: 'BILLING_PLAN_DELETED',
        resourceType: 'plan',
        resourceId: planName,
        severity: 'CRITICAL',
        success: false,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageUserPackages')
  @Get('management/user-packages')
  async managementUserPackages(@Query('userIds') userIds?: string) {
    if (userIds?.trim()) {
      const ids = userIds
        .split(',')
        .map((s) => s.trim())
        .filter((id) => id.length > 0);
      return this.billing.listManagementUserPackagesForUserIds(ids);
    }
    return this.billing.listManagementUserPackages();
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageUserPackages')
  @Patch('management/user-packages/:userId')
  async updateManagementUserPackage(
    @Param('userId') userId: string,
    @Body('planName') planName: string,
  ) {
    return this.billing.updateManagementUserPackage(userId, planName);
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Get('management/stripe-email-settings')
  async getStripeEmailSettings() {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: STRIPE_EMAIL_SETTINGS_KEY },
    });
    return (row?.value as any) ?? { daily: false, weekly: false, monthly: false, yearly: false };
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Patch('management/stripe-email-settings')
  async updateStripeEmailSettings(
    @Body() body: { daily?: boolean; weekly?: boolean; monthly?: boolean; yearly?: boolean },
  ) {
    const current = await this.prisma.systemSetting.findUnique({
      where: { key: STRIPE_EMAIL_SETTINGS_KEY },
    });
    const prev = (current?.value as any) ?? { daily: false, weekly: false, monthly: false, yearly: false };
    const next = { ...prev, ...body };
    await this.prisma.systemSetting.upsert({
      where: { key: STRIPE_EMAIL_SETTINGS_KEY },
      create: { key: STRIPE_EMAIL_SETTINGS_KEY, value: next },
      update: { value: next },
    });
    return next;
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Get('management/stripe-overview')
  async stripeOverview() {
    if (!this.stripe.isEnabled()) {
      return { configured: false, message: 'Stripe is not configured.' };
    }

    const client = this.stripe.getClient();

    const [charges, balanceTxns, invoices, subscriptions, customers] =
      await Promise.all([
        client.charges.list({
          limit: 50,
          expand: ['data.customer'],
        }),
        client.balanceTransactions.list({
          limit: 50,
        }),
        client.invoices.list({
          limit: 50,
          expand: ['data.customer', 'data.subscription'],
        }),
        client.subscriptions.list({
          limit: 100,
          status: 'all',
          expand: ['data.customer', 'data.plan'],
        }),
        client.customers.list({
          limit: 100,
        }),
      ]);

    // Revenue summary from balance transactions
    const revenueTxns = balanceTxns.data.filter(
      (t) => t.type === 'charge' && t.status === 'available',
    );
    const totalRevenue = revenueTxns.reduce((s, t) => s + t.net, 0);
    const totalGross = revenueTxns.reduce((s, t) => s + t.amount, 0);
    const totalFees = revenueTxns.reduce((s, t) => s + t.fee, 0);

    // Monthly revenue by month
    const monthlyRevenue: Record<string, { gross: number; net: number; fees: number; count: number }> = {};
    for (const t of balanceTxns.data) {
      if (t.type !== 'charge') continue;
      const d = new Date(t.created * 1000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (!monthlyRevenue[key]) monthlyRevenue[key] = { gross: 0, net: 0, fees: 0, count: 0 };
      monthlyRevenue[key].gross += t.amount;
      monthlyRevenue[key].net += t.net;
      monthlyRevenue[key].fees += t.fee;
      monthlyRevenue[key].count++;
    }
    const revenueByMonth = Object.entries(monthlyRevenue)
      .map(([month, v]) => ({ month, ...v }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Subscription stats
    const activeSubs = subscriptions.data.filter((s) => s.status === 'active');
    const canceledSubs = subscriptions.data.filter((s) => s.status === 'canceled');
    const pastDueSubs = subscriptions.data.filter((s) => s.status === 'past_due');
    const mrr = activeSubs.reduce((s, sub) => {
      const item = sub.items?.data[0];
      return s + (item?.price?.unit_amount || 0);
    }, 0);

    // Recent charges
    const recentCharges = charges.data.map((c) => ({
      id: c.id,
      amount: c.amount,
      currency: c.currency,
      status: c.status,
      created: new Date(c.created * 1000).toISOString(),
      customerEmail: typeof c.customer === 'object' && c.customer && 'email' in c.customer
        ? (c.customer as any).email : null,
      customerName: typeof c.customer === 'object' && c.customer && 'name' in c.customer
        ? (c.customer as any).name : null,
      description: c.description,
      paid: c.paid,
      refunded: c.refunded,
      amountRefunded: c.amount_refunded,
      failureMessage: c.failure_message,
    }));

    // Recent invoices
    const recentInvoices = invoices.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      amount: inv.amount_due,
      amountPaid: inv.amount_paid,
      currency: inv.currency,
      status: inv.status,
      created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      dueDate: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
      customerEmail: typeof inv.customer === 'object' && inv.customer && 'email' in inv.customer
        ? (inv.customer as any).email : null,
      customerName: typeof inv.customer === 'object' && inv.customer && 'name' in inv.customer
        ? (inv.customer as any).name : null,
      hostedUrl: inv.hosted_invoice_url,
      pdf: inv.invoice_pdf,
      planName: typeof inv.subscription === 'object' && inv.subscription
        ? (inv.subscription as any).metadata?.planName || null : null,
    }));

    // Active subscriptions list
    const activeSubscriptions = activeSubs.map((s) => ({
      id: s.id,
      status: s.status,
      created: new Date(s.created * 1000).toISOString(),
      currentPeriodEnd: s.current_period_end
        ? new Date(s.current_period_end * 1000).toISOString() : null,
      cancelAtPeriodEnd: s.cancel_at_period_end,
      customerEmail: typeof s.customer === 'object' && s.customer && 'email' in s.customer
        ? (s.customer as any).email : null,
      customerName: typeof s.customer === 'object' && s.customer && 'name' in s.customer
        ? (s.customer as any).name : null,
      planName: s.metadata?.planName || s.items?.data[0]?.price?.nickname || null,
      amount: s.items?.data[0]?.price?.unit_amount || 0,
      currency: s.currency,
    }));

    return {
      configured: true,
      summary: {
        totalRevenue,
        totalGross,
        totalFees,
        mrr,
        currency: 'usd',
        activeSubscriptions: activeSubs.length,
        canceledSubscriptions: canceledSubs.length,
        pastDueSubscriptions: pastDueSubs.length,
        totalCustomers: customers.data.length,
      },
      revenueByMonth,
      recentCharges,
      recentInvoices,
      activeSubscriptions,
    };
  }

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
    @Res() res: Response,
  ) {
    if (!signature) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    let event;
    try {
      const rawBody = req.rawBody;
      if (!rawBody) {
        return res.status(400).json({ error: 'Missing raw body' });
      }
      event = this.stripe.constructWebhookEvent(rawBody, signature);
    } catch (err: any) {
      this.logger.warn(`Webhook signature verification failed: ${err.message}`);
      return res.status(400).json({ error: 'Webhook signature verification failed' });
    }

    this.logger.log(`Stripe webhook received: ${event.type}`);

    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await this.billing.handleCheckoutCompleted(event.data.object);
          break;
        case 'customer.subscription.updated':
          await this.billing.handleSubscriptionUpdated(event.data.object);
          break;
        case 'customer.subscription.deleted':
          await this.billing.handleSubscriptionDeleted(event.data.object);
          break;
        case 'invoice.paid':
          await this.billing.handleInvoicePaid(event.data.object);
          break;
        case 'invoice.payment_failed':
          await this.billing.handleInvoicePaymentFailed(event.data.object);
          break;
        default:
          this.logger.debug(`Unhandled webhook event: ${event.type}`);
      }
    } catch (err: any) {
      this.logger.error(`Webhook handler error for ${event.type}: ${err.message}`);
    }

    return res.json({ received: true });
  }
}
