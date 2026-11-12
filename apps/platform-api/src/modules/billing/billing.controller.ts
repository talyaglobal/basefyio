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
  BadRequestException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { RequireManagementPermission } from '../../common/decorators/management-permission.decorator';
import { BillingService } from './billing.service';
import { DB_SIZE_FRESH_MS, UsageService } from './usage.service';
import { QuotaService } from './quota.service';
import { ProjectCostService } from './project-cost.service';
import { StripeOverviewService } from './stripe-overview.service';
import {
  DEFAULT_EMAIL_REPORTS_CONFIG,
  DEFAULT_REPORT_RECIPIENT,
  EMAIL_REPORTS_KEY,
  EmailReportsConfig,
  normalizeRecipients,
} from './email-reports';
import { StripeService } from '../stripe/stripe.service';
import { ObservabilityService } from '../observability/observability.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RequestWithTraceId } from '../../common/middleware/trace-id.middleware';


@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly billing: BillingService,
    private readonly usage: UsageService,
    private readonly projectCosts: ProjectCostService,
    private readonly stripe: StripeService,
    private readonly observability: ObservabilityService,
    private readonly prisma: PrismaService,
    private readonly stripeOverviewService: StripeOverviewService,
    private readonly quota: QuotaService,
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
    // Database sizes are cheap to measure, so the meter is at most minutes old.
    await this.usage.ensureFreshDbSizes(teamId, DB_SIZE_FRESH_MS);
    return this.usage.getTeamUsage(teamId);
  }

  /**
   * The plan's project and member limits next to live usage, so the dashboard
   * can say "limit reached" before a request fails with 402.
   */
  @UseGuards(JwtAuthGuard)
  @Get('limits')
  async getLimits(@Req() req: any, @Query('teamId') teamId?: string) {
    const userId = req.user.sub;
    if (!teamId) {
      teamId = await this.billing.getUserActiveTeamId(userId);
    }
    await this.billing.verifyTeamMembership(teamId, userId);
    return this.quota.getTeamLimitSummary(teamId);
  }

  /**
   * Per-project cost breakdown for the current UTC calendar month, or a closed
   * month with `?period=YYYY-MM`. Customers only ever see priced figures; the
   * raw infrastructure cost stays in management.
   */
  @UseGuards(JwtAuthGuard)
  @Get('project-costs')
  async getProjectCosts(
    @Req() req: any,
    @Query('teamId') teamId?: string,
    @Query('period') period?: string,
  ) {
    const userId = req.user.sub;
    if (!teamId) {
      teamId = await this.billing.getUserActiveTeamId(userId);
    }
    await this.billing.verifyTeamMembership(teamId, userId);
    return this.projectCosts.getTeamReport(teamId, { period });
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
  @Get('invoices/:invoiceId/pdf')
  async downloadInvoicePdf(
    @Req() req: any,
    @Param('invoiceId') invoiceId: string,
    @Res() res: Response,
    @Query('teamId') teamId?: string,
    @Query('type') type?: string,
  ) {
    const userId = req.user.sub;
    const resolvedTeam = teamId || (await this.billing.getUserActiveTeamId(userId));
    const kind = type === 'receipt' ? 'receipt' : 'invoice';
    const pdf = await this.billing.generateInvoicePdf(resolvedTeam, userId, invoiceId, kind);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${kind}-${invoiceId}.pdf"`,
      'Content-Length': pdf.length,
    });
    res.end(pdf);
  }

  @UseGuards(JwtAuthGuard)
  @Post('student-verification/request')
  async requestStudentOtp(
    @Req() req: any,
    @Body() body: { email: string; teamId?: string },
  ) {
    const userId = req.user.sub;
    const teamId = body.teamId || (await this.billing.getUserActiveTeamId(userId));
    return this.billing.requestStudentOtp(teamId, userId, body.email);
  }

  @UseGuards(JwtAuthGuard)
  @Post('student-verification/confirm')
  async confirmStudentOtp(
    @Req() req: any,
    @Body() body: { email: string; code: string; teamId?: string },
  ) {
    const userId = req.user.sub;
    const teamId = body.teamId || (await this.billing.getUserActiveTeamId(userId));
    return this.billing.confirmStudentOtp(teamId, userId, body.email, body.code);
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
      /** Default pooler connection cap per project database; null = platform default. */
      maxDbConnections?: number | null;
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
        maxDbConnections: body.maxDbConnections,
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
  @Get('management/email-reports')
  async getEmailReportsConfig() {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: EMAIL_REPORTS_KEY },
    });
    const stored = (row?.value as Partial<EmailReportsConfig> | null) ?? null;
    return {
      schedule: { ...DEFAULT_EMAIL_REPORTS_CONFIG.schedule, ...(stored?.schedule ?? {}) },
      content: stored ? stored.content ?? {} : DEFAULT_EMAIL_REPORTS_CONFIG.content,
      recipients: Array.isArray(stored?.recipients) ? stored!.recipients : [],
      /** Used when the list is empty. */
      defaultRecipient: DEFAULT_REPORT_RECIPIENT,
    };
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Patch('management/email-reports')
  async updateEmailReportsConfig(
    @Body()
    body: { schedule?: Record<string, boolean>; content?: Record<string, boolean>; recipients?: string[] },
  ) {
    const current = await this.prisma.systemSetting.findUnique({
      where: { key: EMAIL_REPORTS_KEY },
    });
    const prev = (current?.value as Partial<EmailReportsConfig> | null) ?? {
      schedule: { ...DEFAULT_EMAIL_REPORTS_CONFIG.schedule },
      content: {},
    };
    let recipients = Array.isArray(prev.recipients) ? prev.recipients : [];
    if (body.recipients !== undefined) {
      try {
        recipients = normalizeRecipients(body.recipients);
      } catch (err: any) {
        throw new BadRequestException(err.message);
      }
    }
    const next = {
      schedule: { ...prev.schedule, ...(body.schedule || {}) },
      content: { ...prev.content, ...(body.content || {}) },
      recipients,
    };
    await this.prisma.systemSetting.upsert({
      where: { key: EMAIL_REPORTS_KEY },
      create: { key: EMAIL_REPORTS_KEY, value: next },
      update: { value: next },
    });
    return { ...next, defaultRecipient: DEFAULT_REPORT_RECIPIENT };
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Get('management/stripe-overview')
  async stripeOverview() {
    // basefyio customers only; the Stripe account is shared with other products.
    return this.stripeOverviewService.getOverview();
  }

  /** Every team's projects with raw infrastructure cost, customer price and margin. */
  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Get('management/project-costs')
  async managementProjectCosts() {
    return this.projectCosts.getPlatformReport();
  }

  /** Re-measure database sizes and flush live counters right now. */
  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Post('management/project-costs/refresh')
  async refreshManagementProjectCosts() {
    return this.projectCosts.refreshNow();
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Get('management/cost-config')
  async getCostConfig() {
    return this.projectCosts.getConfig();
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManagePlans')
  @Patch('management/cost-config')
  async updateCostConfig(
    @Req() req: RequestWithTraceId,
    @Body() body: Record<string, unknown>,
  ) {
    const startedAt = Date.now();
    const audit = (success: boolean) =>
      this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: (req as any).user?.sub || 'unknown',
        action: 'BILLING_COST_CONFIG_UPDATED',
        resourceType: 'system_setting',
        resourceId: 'infra_cost_config',
        severity: 'HIGH',
        success,
        latencyMs: Date.now() - startedAt,
      });
    try {
      const result = await this.projectCosts.updateConfig(body);
      await audit(true);
      return result;
    } catch (err) {
      await audit(false);
      throw err;
    }
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
