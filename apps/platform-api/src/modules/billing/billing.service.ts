import { randomInt } from 'crypto';
import { isBeta, RELEASE_LABEL } from '../../common/utils/release-stage';
import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { RealtimeEventsService } from '../../common/realtime/realtime-events.service';
import { RedisService } from '../redis/redis.service';
import { EmailService } from '../email/email.service';
import { QuickbooksService } from '../quickbooks/quickbooks.service';
import { PayPalService } from './paypal.service';
import { ACADEMIC_DOMAINS } from './academic-domains';
import { DEFAULT_PLANS, ENTERPRISE_CONTACT_EMAIL, ENTERPRISE_PLAN } from './default-plans';
import { UsageService } from './usage.service';
import {
  LimitFinding,
  UNPAID_INVOICE_STATUSES,
  UsageSnapshot,
  invoiceOutstanding,
  isCardExempt,
  isEnterprisePlan,
  planLimitFindings,
  planRequiresCard,
} from './billing-plan-rules';
import { grantedByRole, requireRolePermission } from '../teams/role-permissions';
import PDFDocument = require('pdfkit');

/** Set once the Enterprise plan has been created, so it is never re-created after a deliberate delete. */
const ENTERPRISE_SEEDED_KEY = 'plans.enterprise_seeded';

/** Worldwide university/college domains, built once for O(1) lookup. */
const ACADEMIC_DOMAIN_SET = new Set(ACADEMIC_DOMAINS);

/** A subscription's current period: top-level on older API versions, on the first item since 2025-03-31. */
function subscriptionPeriod(stripeSub: any): { start: number | null; end: number | null } {
  const item = stripeSub?.items?.data?.[0];
  const start = stripeSub?.current_period_start ?? item?.current_period_start ?? null;
  const end = stripeSub?.current_period_end ?? item?.current_period_end ?? null;
  return { start: typeof start === 'number' ? start : null, end: typeof end === 'number' ? end : null };
}


@Injectable()
export class BillingService implements OnModuleInit {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly realtime: RealtimeEventsService,
    private readonly redis: RedisService,
    private readonly email: EmailService,
    private readonly quickbooks: QuickbooksService,
    private readonly paypal: PayPalService,
    private readonly usage?: UsageService,
  ) {}

  /** Fire-and-forget: push a paid sale to QuickBooks as a Sales Receipt. */
  private recordQbSale(invoiceId: string | undefined) {
    if (!invoiceId) return;
    void this.quickbooks.recordSale(invoiceId).catch(() => {});
  }

  async onModuleInit() {
    await this.ensureDefaultPlans();
    await this.ensureEnterprisePlan();
    if (this.stripe.isEnabled()) {
      try {
        await this.syncStripePlans();
      } catch (err: any) {
        this.logger.error(`Failed to sync Stripe plans: ${err.message}`);
      }
    }
  }

  /**
   * A new installation starts with an empty plans table, and without the free
   * plan no organization gets a subscription and nobody can create a project.
   * Write the default plans then — only when there is no plan at all, so an
   * installation whose plans exist (edited or not) is never touched.
   */
  private async ensureDefaultPlans(): Promise<void> {
    try {
      if ((await this.prisma.plan.count()) > 0) return;
      const { count } = await this.prisma.plan.createMany({
        data: DEFAULT_PLANS,
        skipDuplicates: true,
      });
      this.logger.log(`The plans table was empty; created ${count} default plans`);
    } catch (err: any) {
      this.logger.error(`Could not create the default plans: ${err?.message ?? err}`);
    }
  }

  /**
   * Enterprise is added to installations that predate it: created once, only
   * when no plan of that name exists, and never again after that (a marker in
   * system_settings), so a root who deletes or renames it is not overruled at
   * the next boot. An existing row is only looked up by name, never written.
   */
  private async ensureEnterprisePlan(): Promise<void> {
    try {
      const existing = await this.prisma.plan.findUnique({ where: { name: 'enterprise' }, select: { id: true } });
      if (existing) return;
      const marker = await this.prisma.systemSetting.findUnique({ where: { key: ENTERPRISE_SEEDED_KEY } });
      if (marker) return;
      const { count } = await this.prisma.plan.createMany({ data: [ENTERPRISE_PLAN], skipDuplicates: true });
      await this.prisma.systemSetting.upsert({
        where: { key: ENTERPRISE_SEEDED_KEY },
        create: { key: ENTERPRISE_SEEDED_KEY, value: { at: new Date().toISOString() } },
        update: {},
      });
      if (count > 0) this.logger.log('Created the Enterprise plan (not public, arranged with sales)');
    } catch (err: any) {
      this.logger.error(`Could not create the Enterprise plan: ${err?.message ?? err}`);
    }
  }

  /** Enterprise is arranged with sales: no checkout, no self-serve plan change. */
  private assertSelfServePlan(plan: { name: string; features?: unknown }): void {
    if (isEnterprisePlan(plan)) {
      throw new BadRequestException(
        `The Enterprise plan is arranged with our team and cannot be bought here. Write to ${ENTERPRISE_CONTACT_EMAIL} and we will set it up for your organization.`,
      );
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
    this.assertSelfServePlan(plan);
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

    // Also covers a stored id Stripe no longer knows (test-mode leftover): getOrCreateCustomer replaced it.
    if (sub && sub.stripeCustomerId !== customer.id) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { stripeCustomerId: customer.id },
      });
    }

    // A paid plan is never chosen without a saved default card (owner, 2026-11-20).
    if (planRequiresCard(plan) && !(await this.stripe.getDefaultPaymentMethod(customer.id))) {
      throw this.cardRequired(plan);
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

  // ── Student / education discount ───────────────────────────────────────────

  /** Apply a team's student discount to a base amount in cents. */
  private withStudentDiscount(amountCents: number, discountPercent?: number | null): number {
    const pct = Math.min(Math.max(discountPercent ?? 0, 0), 100);
    if (!pct) return amountCents;
    return Math.round((amountCents * (100 - pct)) / 100);
  }

  /**
   * Is this an academic (student/teacher) email? Two layers of coverage:
   *  1) Suffix rules — catch ANY institution under the common academic patterns
   *     used worldwide: .edu, .edu.<cc>, .ac.<cc>, .sch.<cc>, and US K-12
   *     (.k12.<state>.us). Works even for institutions not in the dataset.
   *  2) A bundled dataset of 10k+ real university/college domains — catches
   *     institutions on generic TLDs (e.g. Canada .ca, Germany .de, France .fr)
   *     that the suffix rules can't express. Subdomains (mail.uni.de,
   *     student.x.ac.uk) match via their registrable parent.
   */
  private isAcademicEmail(email: string): boolean {
    const domain = (email || '').trim().toLowerCase().split('@')[1] || '';
    if (!domain) return false;

    // Layer 1: academic suffix patterns.
    if (
      /(?:\.edu|\.edu\.[a-z]{2,3}|\.ac\.[a-z]{2,3}|\.sch\.[a-z]{2,3})$/.test(domain) ||
      domain.includes('.k12.')
    ) {
      return true;
    }

    // Layer 2: known university domain (exact or any parent suffix).
    const parts = domain.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
      if (ACADEMIC_DOMAIN_SET.has(parts.slice(i).join('.'))) return true;
    }
    return false;
  }

  /**
   * Verify student/teacher status for the education discount.
   * Uses SheerID when SHEERID_API_KEY + SHEERID_PROGRAM_ID are configured;
   * otherwise falls back to academic-email-domain verification.
   */
  private async checkStudentEligibility(email: string): Promise<boolean> {
    const sheerKey = process.env.SHEERID_API_KEY;
    const sheerProgram = process.env.SHEERID_PROGRAM_ID;
    if (sheerKey && sheerProgram) {
      try {
        const res = await fetch(
          `https://services.sheerid.com/rest/v2/verification/program/${sheerProgram}/step/collectStudentPersonalInfo`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${sheerKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email }),
          },
        );
        const data: any = await res.json().catch(() => ({}));
        if (data?.currentStep === 'success' || data?.verificationStatus === 'success') {
          return true;
        }
        // SheerID inconclusive → fall through to domain heuristic.
      } catch (err: any) {
        this.logger.warn(`SheerID verification failed, falling back to domain check: ${err.message}`);
      }
    }
    return this.isAcademicEmail(email);
  }

  private studentOtpKey(teamId: string, email: string): string {
    return `student_otp:${teamId}:${email.trim().toLowerCase()}`;
  }

  /**
   * Step 1 — the email must be an academic address AND the person must prove they
   * own it: we email a one-time code. Domain alone isn't enough (anyone could
   * type name@harvard.edu), so the OTP is what actually grants the discount.
   */
  async requestStudentOtp(teamId: string, userId: string, email: string) {
    await this.assertTeamOwner(teamId, userId);
    const clean = (email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) {
      throw new BadRequestException('Please enter a valid email address');
    }

    const eligible = await this.checkStudentEligibility(clean);
    if (!eligible) {
      return {
        otpSent: false,
        message:
          'This does not look like a recognized academic email. Use your school/university address (e.g. name@university.edu).',
      };
    }

    // Rate-limit: one code per 60s per (team,email).
    const rateKey = `${this.studentOtpKey(teamId, clean)}:rate`;
    if (await this.redis.get(rateKey)) {
      throw new BadRequestException('Please wait a moment before requesting a new code.');
    }

    // Math.random is not a cryptographic generator: its output is predictable
    // from previous values, and this code is a verification credential sent by
    // email. auth.service.ts already uses randomInt for exactly this, so the
    // difference here was an oversight rather than a decision.
    const otp = String(randomInt(100000, 1000000));
    await this.redis.set(this.studentOtpKey(teamId, clean), otp, 600); // 10 min
    await this.redis.set(rateKey, '1', 60);
    await this.email.sendStudentVerifyEmail(clean, otp).catch((err) => {
      this.logger.error(`Failed to send student OTP to ${clean}: ${err.message}`);
    });

    this.logger.log(`Student verification code sent to ${clean} (team ${teamId})`);
    return { otpSent: true, message: `We sent a 6-digit code to ${clean}.` };
  }

  /**
   * Step 2 — confirm the emailed code. Only on a correct code do we apply the
   * 90% discount, which proves the person controls the academic mailbox.
   */
  async confirmStudentOtp(teamId: string, userId: string, email: string, code: string) {
    await this.assertTeamOwner(teamId, userId);
    const clean = (email || '').trim().toLowerCase();
    const key = this.studentOtpKey(teamId, clean);
    const stored = await this.redis.get(key);
    if (!stored) {
      return { verified: false, discountPercent: 0, message: 'Code expired. Please request a new one.' };
    }
    if (stored !== (code || '').trim()) {
      return { verified: false, discountPercent: 0, message: 'Invalid code. Please try again.' };
    }

    await this.redis.del(key);
    const DISCOUNT = 90;
    await this.prisma.subscription.update({
      where: { teamId },
      data: {
        studentDiscountPercent: DISCOUNT,
        studentVerifiedEmail: clean,
        studentVerifiedAt: new Date(),
      },
    });
    this.logger.log(`Student discount (${DISCOUNT}%) applied to team ${teamId} via verified ${clean}`);

    return {
      verified: true,
      discountPercent: DISCOUNT,
      message: `Verified! ${DISCOUNT}% education discount applied to your subscription.`,
    };
  }

  /**
   * Generate a professional Invoice or Receipt PDF (Stripe-independent), styled
   * after a standard billing document: header, seller/bill-to, line items, totals.
   */
  async generateInvoicePdf(
    teamId: string,
    userId: string,
    invoiceId: string,
    kind: 'invoice' | 'receipt' = 'invoice',
  ): Promise<Buffer> {
    await this.assertTeamMember(teamId, userId);
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, teamId },
      include: { team: true, lineItems: true },
    });
    if (!invoice) throw new NotFoundException('Invoice not found');

    const account = await this.prisma.billingAccount.findUnique({ where: { teamId } });
    const sub = await this.prisma.subscription.findUnique({
      where: { teamId },
      include: { plan: true },
    });

    const isReceipt = kind === 'receipt';
    let pm: { brand?: string; last4?: string } | null = null;
    if (isReceipt && this.stripe.isEnabled() && sub?.stripeCustomerId) {
      const m = await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId).catch(() => null);
      if (m?.card) pm = { brand: m.card.brand, last4: m.card.last4 };
    }

    const cur = invoice.currency.toUpperCase();
    const money = (c: number) => `$${(c / 100).toFixed(2)}`;
    const dt = (d: Date | null) =>
      d ? new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
    const outstanding = Math.max(invoice.amountDue - invoice.amountPaid, 0);

    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

    const DARK = '#0f172a', GREY = '#475569', MUTE = '#94a3b8', LINE = '#e2e8f0';

    // Header — title left, brand right
    doc.fillColor(DARK).font('Helvetica-Bold').fontSize(28).text(isReceipt ? 'Receipt' : 'Invoice', 50, 50);
    doc.fillColor('#3b82f6').fontSize(18).text('basefyio', 350, 56, { width: 195, align: 'right' });
    if (isBeta()) {
      // The same small "beta" that sits next to the mark everywhere else.
      doc.fillColor(MUTE).font('Helvetica').fontSize(8).text(RELEASE_LABEL, 350, 78, { width: 195, align: 'right' });
    }

    // Meta block
    let y = 100;
    doc.fontSize(9);
    const meta = (label: string, val: string) => {
      doc.font('Helvetica-Bold').fillColor(DARK).text(label, 50, y, { width: 95 });
      doc.font('Helvetica').fillColor(GREY).text(val, 150, y, { width: 250 });
      y += 15;
    };
    meta(isReceipt ? 'Receipt number' : 'Invoice number', invoice.stripeInvoiceId || invoice.id.slice(0, 18));
    meta('Date of issue', dt(invoice.createdAt));
    if (isReceipt) {
      meta('Payment date', dt(invoice.createdAt));
      if (pm) meta('Payment method', `${(pm.brand || 'CARD').toUpperCase()} •••• ${pm.last4 || '••••'}`);
    } else {
      meta('Date due', dt(invoice.periodStart || invoice.createdAt));
    }

    // Seller / Bill to
    y += 12;
    const colTop = y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK).text('basefyio (Talya Smart)', 50, y);
    doc.font('Helvetica').fillColor(GREY)
      .text('support@talyasmart.com', 50, y + 14)
      .text('basefyio.com', 50, y + 28);

    let by = colTop;
    doc.font('Helvetica-Bold').fillColor(DARK).text('Bill to', 320, by);
    by += 14;
    doc.font('Helvetica').fillColor(GREY);
    const bl = (t?: string | null) => { if (t && t.trim()) { doc.text(t, 320, by, { width: 225 }); by += 14; } };
    bl(account?.companyName || invoice.team?.name);
    bl(account?.addressLine1);
    bl(account?.addressLine2);
    bl([account?.city, account?.state, account?.postalCode].filter(Boolean).join(', '));
    bl(account?.country);
    bl(account?.billingEmail);

    // Big amount line
    y = Math.max(colTop + 42, by) + 26;
    doc.font('Helvetica-Bold').fontSize(15).fillColor(DARK);
    if (isReceipt) {
      doc.text(`${money(invoice.amountPaid)} ${cur} paid on ${dt(invoice.createdAt)}`, 50, y);
    } else {
      doc.text(`${money(invoice.amountDue)} ${cur}${outstanding > 0 ? ` due ${dt(invoice.periodStart || invoice.createdAt)}` : ''}`, 50, y);
    }
    y += 34;

    // Line items table
    const C = { desc: 50, qty: 330, unit: 390, amt: 480 };
    doc.font('Helvetica').fontSize(8).fillColor(MUTE);
    doc.text('Description', C.desc, y);
    doc.text('Qty', C.qty, y);
    doc.text('Unit price', C.unit, y);
    doc.text('Amount', C.amt, y, { width: 65, align: 'right' });
    y += 12;
    doc.moveTo(50, y).lineTo(545, y).strokeColor(LINE).stroke();
    y += 10;

    const items = invoice.lineItems?.length
      ? invoice.lineItems.map((li) => ({
          desc: li.description,
          period: '',
          qty: li.quantity,
          unit: li.unitPriceCents,
          amt: li.amountCents,
        }))
      : [{
          desc: `basefyio ${sub?.plan?.displayName || 'subscription'}`,
          period: invoice.periodStart && invoice.periodEnd ? `${dt(invoice.periodStart)} – ${dt(invoice.periodEnd)}` : '',
          qty: 1,
          unit: invoice.amountDue,
          amt: invoice.amountDue,
        }];

    for (const it of items) {
      doc.font('Helvetica').fontSize(9).fillColor(DARK);
      doc.text(it.desc, C.desc, y, { width: 270 });
      doc.text(String(it.qty), C.qty, y);
      doc.text(money(it.unit), C.unit, y);
      doc.text(money(it.amt), C.amt, y, { width: 65, align: 'right' });
      y += 13;
      if (it.period) {
        doc.fontSize(8).fillColor(MUTE).text(it.period, C.desc, y, { width: 270 });
        y += 13;
      }
      y += 4;
    }

    // Totals
    y += 6;
    doc.moveTo(330, y).lineTo(545, y).strokeColor(LINE).stroke();
    y += 10;
    const tot = (label: string, val: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(DARK);
      doc.text(label, 330, y);
      doc.text(val, 430, y, { width: 115, align: 'right' });
      y += 16;
    };
    tot('Subtotal', money(invoice.amountDue));
    tot('Total', money(invoice.amountDue));
    if (isReceipt) tot('Amount paid', `${money(invoice.amountPaid)} ${cur}`, true);
    else tot('Amount due', `${money(outstanding)} ${cur}`, true);

    // Footer
    doc.font('Helvetica').fontSize(8).fillColor(MUTE)
      .text('basefyio by Talya Smart · support@talyasmart.com · basefyio.com', 50, 770, { width: 495, align: 'center' });

    doc.end();
    return done;
  }

  /** Get invoices for a team */
  async getInvoices(teamId: string, userId: string) {
    await this.assertCanViewBilling(teamId, userId);

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
        currentPeriodStart: new Date((subscriptionPeriod(stripeSub).start ?? 0) * 1000),
        currentPeriodEnd: new Date((subscriptionPeriod(stripeSub).end ?? 0) * 1000),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      },
      create: {
        teamId,
        planId: plan.id,
        status: 'ACTIVE',
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        currentPeriodStart: new Date((subscriptionPeriod(stripeSub).start ?? 0) * 1000),
        currentPeriodEnd: new Date((subscriptionPeriod(stripeSub).end ?? 0) * 1000),
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
      currentPeriodStart: subscriptionPeriod(stripeSub).start
        ? new Date((subscriptionPeriod(stripeSub).start as number) * 1000)
        : undefined,
      currentPeriodEnd: subscriptionPeriod(stripeSub).end
        ? new Date((subscriptionPeriod(stripeSub).end as number) * 1000)
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
    await this.assertCanViewBilling(teamId, userId);
    const sub = await this.getTeamSubscription(teamId);
    // The UI shows billing forms read-only for callers the server would answer with 403.
    const canManage = await this.assertTeamOwner(teamId, userId).then(() => true, () => false);
    return sub ? { ...sub, canManage } : sub;
  }

  /** Assert caller is team member (public wrapper) */
  async verifyTeamMembership(teamId: string, userId: string): Promise<void> {
    await this.assertTeamMember(teamId, userId);
  }

  /** Member, and — as far as ORG_PERMISSIONS_ENFORCED reaches — holder of canViewBilling. */
  async verifyCanViewBilling(teamId: string, userId: string): Promise<void> {
    await this.assertCanViewBilling(teamId, userId);
  }

  /**
   * Billing is managed by the OWNER, and by a role whose stored
   * canManageBilling flag says so (off for ADMIN and MEMBER unless the owner
   * turned it on).
   */
  private async assertTeamOwner(teamId: string, userId: string) {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this team');
    if (m.role !== 'OWNER' && !(await grantedByRole(this.prisma, teamId, m.role, 'canManageBilling'))) {
      throw new ForbiddenException('Only the team owner can manage billing');
    }
  }

  /**
   * Reading billing (subscription, usage, invoices, costs) used to need
   * membership only, while the role-permissions page showed canViewBilling as
   * off for members. The flag is applied as far as ORG_PERMISSIONS_ENFORCED
   * allows: logged first, denied once the operator switches to enforce.
   */
  private async assertCanViewBilling(teamId: string, userId: string) {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!m) throw new ForbiddenException('Not a member of this team');
    await requireRolePermission(this.prisma, this.logger, { teamId, userId, role: m.role, key: 'canViewBilling' });
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

    // A stored id Stripe no longer knows (17 teams on 2026-11-06, test-mode leftovers) used to
    // make this a 500; getOrCreateCustomer replaces it and we persist the new one.
    const customer = await this.stripe.getOrCreateCustomer({
      teamId,
      teamName: team.name,
      email: user.email,
      existingCustomerId: sub.stripeCustomerId,
    });
    const customerId = customer.id;
    if (customerId !== sub.stripeCustomerId) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const intent = await this.stripe.createSetupIntent(customerId);
    return { clientSecret: intent.client_secret, customerId };
  }

  /**
   * Attach a card after SetupIntent confirmation. It becomes the default unless
   * the caller asks otherwise and the team already has a default card.
   */
  async attachPaymentMethod(teamId: string, userId: string, paymentMethodId: string, makeDefault = true) {
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
    const keepCurrentDefault =
      makeDefault === false && !!(await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId).catch(() => null));
    if (!keepCurrentDefault) {
      await this.stripe.setDefaultPaymentMethod(sub.stripeCustomerId, paymentMethodId);
    }
    this.logger.log(`Payment method ${paymentMethodId} attached for team ${teamId}`);

    return { success: true };
  }

  // ── Saved cards ──────────────────────────────────────

  private cardRequired(plan: { displayName?: string; name: string }) {
    return new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      code: 'card_required',
      message: `Add a card and make it your default before choosing the ${plan.displayName || plan.name} plan.`,
    });
  }

  /** What the team owes: unpaid invoices, a failed renewal, a failed upgrade still being retried. */
  private async outstandingBalance(teamId: string, sub: any) {
    const rows = await this.prisma.invoice.findMany({
      where: { teamId, status: { in: UNPAID_INVOICE_STATUSES } },
      orderBy: { createdAt: 'asc' },
    });
    const invoices = (rows as any[])
      .map((inv) => ({
        id: inv.id as string,
        stripeInvoiceId: (inv.stripeInvoiceId ?? null) as string | null,
        amount: invoiceOutstanding(inv),
        currency: (inv.currency || 'usd') as string,
      }))
      .filter((i) => i.amount > 0);
    const pendingUpgrade: number = sub?.pendingPlanId && (sub.pendingAmountDue ?? 0) > 0 ? sub.pendingAmountDue : 0;
    // A renewal that failed leaves no invoice; the debt is the plan's own price (owner, 2026-11-20).
    const renewal =
      sub?.status === 'PAST_DUE' && !pendingUpgrade && (sub.plan?.priceMonthly ?? 0) > 0
        ? this.withStudentDiscount(sub.plan.priceMonthly, sub.studentDiscountPercent)
        : 0;
    const invoiceTotal = invoices.reduce((s, i) => s + i.amount, 0);
    return { invoices, renewal, pendingUpgrade, total: invoiceTotal + renewal };
  }

  /** Whether the team's last card may be removed, and why not. */
  private async cardRemovalPolicy(teamId: string, sub: any) {
    const plan = sub?.plan;
    const cardRequired = planRequiresCard(plan);
    if (isCardExempt(plan)) return { cardRequired: false, lastCardRemovable: true, lastCardReason: null as string | null };
    if (cardRequired) {
      return {
        cardRequired,
        lastCardRemovable: false,
        lastCardReason: `Your ${plan.displayName || plan.name} plan needs a card on file. Add another card before removing this one, or move to the Free plan first.` as string | null,
      };
    }
    const owed = await this.outstandingBalance(teamId, sub);
    if (owed.total > 0 || owed.pendingUpgrade > 0) {
      return {
        cardRequired,
        lastCardRemovable: false,
        lastCardReason: 'Pay your outstanding balance before removing your last card.' as string | null,
      };
    }
    return { cardRequired, lastCardRemovable: true, lastCardReason: null as string | null };
  }

  /** The card must be saved on this team's own customer; anything else is "not found". */
  private async ownedCard(customerId: string, paymentMethodId: string) {
    let pm: any;
    try {
      pm = await this.stripe.retrievePaymentMethod(paymentMethodId);
    } catch {
      throw new NotFoundException('Card not found');
    }
    const owner = typeof pm?.customer === 'string' ? pm.customer : pm?.customer?.id;
    if (!owner || owner !== customerId) throw new NotFoundException('Card not found');
    return pm;
  }

  /** Every saved card of the team, the default marked, plus the last-card rule for the UI. */
  async listPaymentMethods(teamId: string, userId: string) {
    await this.assertCanViewBilling(teamId, userId);
    const sub = await this.prisma.subscription.findUnique({ where: { teamId }, include: { plan: true } });
    const policy = await this.cardRemovalPolicy(teamId, sub);
    if (!sub?.stripeCustomerId || !this.stripe.isEnabled()) return { methods: [], ...policy };
    try {
      const [cards, def] = await Promise.all([
        this.stripe.listPaymentMethods(sub.stripeCustomerId),
        this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId).catch(() => null),
      ]);
      return {
        methods: cards.map((pm) => ({
          id: pm.id,
          brand: pm.card?.brand || null,
          last4: pm.card?.last4 || null,
          expMonth: pm.card?.exp_month || null,
          expYear: pm.card?.exp_year || null,
          isDefault: !!def && def.id === pm.id,
        })),
        ...policy,
      };
    } catch (err: any) {
      this.logger.warn(`Could not list cards for team ${teamId}: ${err.message}`);
      return { methods: [], unavailable: true, ...policy };
    }
  }

  async setDefaultPaymentMethod(teamId: string, userId: string, paymentMethodId: string) {
    await this.assertTeamOwner(teamId, userId);
    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (!sub?.stripeCustomerId) throw new NotFoundException('Card not found');
    await this.ownedCard(sub.stripeCustomerId, paymentMethodId);
    await this.stripe.setDefaultPaymentMethod(sub.stripeCustomerId, paymentMethodId);
    this.logger.log(`Default card ${paymentMethodId} set for team ${teamId}`);
    return { success: true };
  }

  /**
   * Remove a saved card. A paid plan keeps at least one card; legacy and
   * grandfathered accounts may remove all; a Free team keeps its last card
   * while it owes money. Removing the default promotes another card first.
   */
  async removePaymentMethod(teamId: string, userId: string, paymentMethodId: string) {
    await this.assertTeamOwner(teamId, userId);
    const sub = await this.prisma.subscription.findUnique({ where: { teamId }, include: { plan: true } });
    if (!sub?.stripeCustomerId) throw new NotFoundException('Card not found');
    const customerId = sub.stripeCustomerId;
    await this.ownedCard(customerId, paymentMethodId);

    // Two removals at once could each see "another card is left" and end at zero cards.
    const lockKey = `billing:card-change:${teamId}`;
    let locked = true;
    try {
      locked = (await this.redis.getClient().set(lockKey, '1', 'EX', 30, 'NX')) === 'OK';
    } catch (err: any) {
      this.logger.warn(`Card change lock unavailable for team ${teamId}: ${err.message}`);
    }
    if (!locked) {
      throw new ConflictException('Another card change for this team is in progress. Try again in a moment.');
    }
    try {
      const cards = await this.stripe.listPaymentMethods(customerId);
      if (!cards.some((c) => c.id === paymentMethodId)) throw new NotFoundException('Card not found');
      const remaining = cards.filter((c) => c.id !== paymentMethodId);
      if (remaining.length === 0) {
        const policy = await this.cardRemovalPolicy(teamId, sub);
        if (!policy.lastCardRemovable) {
          throw new BadRequestException({
            statusCode: 400,
            error: 'Bad Request',
            code: 'last_card_required',
            message: policy.lastCardReason,
          });
        }
      } else {
        const def = await this.stripe.getDefaultPaymentMethod(customerId).catch(() => null);
        if (!def || def.id === paymentMethodId) {
          await this.stripe.setDefaultPaymentMethod(customerId, remaining[0].id);
        }
      }
      await this.stripe.detachPaymentMethod(paymentMethodId);
      this.logger.log(`Card ${paymentMethodId} removed for team ${teamId}`);
      return { success: true };
    } finally {
      await this.redis.del(lockKey).catch(() => undefined);
    }
  }

  // ── Moving to the Free plan ──────────────────────────

  private async usageSnapshot(teamId: string): Promise<UsageSnapshot> {
    const [projects, members, usage] = await Promise.all([
      // Counted as recalculateTeamUsage does: live projects, preview branches excluded.
      this.prisma.project.count({
        where: { teamId, status: { notIn: ['DELETED', 'DEACTIVATED'] }, parentProjectId: null },
      }),
      this.prisma.teamMember.count({ where: { teamId } }),
      this.usage ? this.usage.getTeamUsage(teamId) : this.prisma.teamUsage.findUnique({ where: { teamId } }),
    ]);
    return {
      projects,
      members,
      storageBytes: BigInt(usage?.storageBytes ?? 0),
      dbSizeBytes: BigInt(usage?.dbSizeBytes ?? 0),
      apiRequestsMonth: Number(usage?.apiRequestsMonth ?? 0),
      bandwidthMonth: BigInt(usage?.bandwidthMonth ?? 0),
      mau: Number(usage?.mauCount ?? 0),
    };
  }

  /** When a move to Free takes effect: the end of a paid period still running, otherwise now (null). */
  private downgradeEffectiveAt(sub: any): Date | null {
    const end: Date | null = sub.stripeSubscriptionId
      ? sub.currentPeriodEnd
      : (sub.plan?.priceMonthly ?? 0) > 0
        ? sub.nextBillingDate ?? sub.currentPeriodEnd
        : null;
    return end && new Date(end).getTime() > Date.now() ? new Date(end) : null;
  }

  private async downgradeContext(teamId: string) {
    const sub: any = await this.prisma.subscription.findUnique({ where: { teamId }, include: { plan: true } });
    if (!sub) throw new BadRequestException('No subscription found');
    if (sub.plan?.name === 'free') throw new BadRequestException('You are already on the Free plan');
    const freePlan = await this.prisma.plan.findUnique({ where: { name: 'free' } });
    if (!freePlan) throw new NotFoundException('The Free plan is not available');
    const [outstanding, usage] = await Promise.all([this.outstandingBalance(teamId, sub), this.usageSnapshot(teamId)]);
    const limits = planLimitFindings(freePlan as any, usage);
    let card: { brand: string | null; last4: string | null } | null = null;
    if (sub.stripeCustomerId && this.stripe.isEnabled()) {
      const pm = await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId).catch(() => null);
      if (pm) card = { brand: pm.card?.brand || null, last4: pm.card?.last4 || null };
    }
    // Only a move this flow scheduled counts (a processor subscription's own flag, or our marker).
    const scheduled =
      !!sub.cancelAtPeriodEnd && (!!sub.stripeSubscriptionId || (await this.hasScheduledDowngrade(teamId)));
    return { sub, freePlan, outstanding, limits, card, scheduled };
  }

  private describeLimit(f: LimitFinding): string {
    const fmt = (v: string) =>
      f.unit === 'bytes' ? `${(Number(v) / 1024 ** 3).toFixed(2)} GB` : Number(v).toLocaleString('en-US');
    return `${f.label}: ${fmt(f.current)} of ${fmt(f.limit)}`;
  }

  /** The three steps of a move to Free, with what blocks each, for the confirmation dialog. */
  async previewDowngrade(teamId: string, userId: string) {
    await this.assertTeamOwner(teamId, userId);
    const { sub, freePlan, outstanding, limits, card, scheduled } = await this.downgradeContext(teamId);
    const effectiveAt = this.downgradeEffectiveAt(sub);
    const needsCard = outstanding.total > 0 && !card;
    return {
      currentPlan: { name: sub.plan.name, displayName: sub.plan.displayName },
      targetPlan: { name: freePlan.name, displayName: freePlan.displayName },
      currency: 'usd',
      alreadyScheduled: scheduled,
      outstanding: {
        invoices: outstanding.invoices.map(({ id, amount, currency }) => ({ id, amount, currency })),
        renewal: outstanding.renewal,
        total: outstanding.total,
        droppedUpgrade: outstanding.pendingUpgrade,
        card,
      },
      limits,
      effectiveAt: effectiveAt ? effectiveAt.toISOString() : null,
      canProceed: !scheduled && limits.blockers.length === 0 && !needsCard,
      steps: [
        {
          key: 'pay',
          title: 'Pay outstanding invoices',
          status: outstanding.total === 0 ? 'done' : needsCard ? 'blocked' : 'pending',
          detail:
            outstanding.total === 0
              ? 'Nothing is outstanding.'
              : needsCard
                ? 'Add a card to pay the outstanding balance.'
                : `${(outstanding.total / 100).toFixed(2)} USD is charged to your default card first.`,
        },
        {
          key: 'limits',
          title: 'Fit within the Free plan limits',
          status: limits.blockers.length ? 'blocked' : 'done',
          detail: limits.blockers.length
            ? `Reduce first: ${limits.blockers.map((b) => this.describeLimit(b)).join('; ')}.`
            : 'Your usage fits the Free plan.',
        },
        {
          key: 'switch',
          title: 'Switch to Free',
          status: 'pending',
          detail: effectiveAt
            ? `Your plan stays ${sub.plan.displayName} until ${effectiveAt.toISOString().slice(0, 10)}, then moves to Free. The remaining days are not refunded.`
            : 'Your plan moves to Free right away.',
        },
      ],
    };
  }

  /** Charge everything the team owes to its default card; any failure stops the move. */
  private async settleOutstanding(
    teamId: string,
    sub: any,
    outstanding: { invoices: Array<{ id: string; stripeInvoiceId: string | null; amount: number; currency: string }>; renewal: number },
  ) {
    const pm = sub.stripeCustomerId
      ? await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId).catch(() => null)
      : null;
    if (!pm) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'card_required',
        message: 'Add a card to pay your outstanding balance before moving to the Free plan.',
      });
    }
    const failed = (reason: string) =>
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'payment_failed',
        message: `We could not charge your card for the outstanding balance (${reason}). Your plan has not changed. Update your card and try again.`,
      });

    for (const inv of outstanding.invoices) {
      let reference: string | null = inv.stripeInvoiceId;
      try {
        if (inv.stripeInvoiceId?.startsWith('in_')) {
          const paid = await this.stripe.payInvoice(inv.stripeInvoiceId, pm.id);
          if (paid.status !== 'paid') throw new Error(paid.status || 'not paid');
        } else {
          const pi = await this.stripe.createPaymentIntent({
            amount: inv.amount,
            currency: inv.currency,
            customerId: sub.stripeCustomerId,
            paymentMethodId: pm.id,
            metadata: { teamId, invoiceId: inv.id, type: 'downgrade_settlement' },
          });
          if (pi.status !== 'succeeded') throw new Error(pi.status);
          reference = inv.stripeInvoiceId || pi.id;
        }
      } catch (err: any) {
        this.logger.error(`Downgrade settlement failed for team ${teamId}, invoice ${inv.id}: ${err.message}`);
        throw failed(err.message);
      }
      const row = await this.prisma.invoice.findUnique({ where: { id: inv.id } });
      await this.prisma.invoice.update({
        where: { id: inv.id },
        data: { status: 'paid', amountPaid: row?.amountDue ?? inv.amount, stripeInvoiceId: reference },
      });
      this.recordQbSale(inv.id);
    }

    if (outstanding.renewal > 0) {
      const now = new Date();
      const nextBillingDate = new Date(now);
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 1);
      let pi: any;
      try {
        pi = await this.stripe.createPaymentIntent({
          amount: outstanding.renewal,
          currency: 'usd',
          customerId: sub.stripeCustomerId,
          paymentMethodId: pm.id,
          metadata: { teamId, subscriptionId: sub.id, type: 'downgrade_renewal' },
        });
        if (pi.status !== 'succeeded') throw new Error(pi.status);
      } catch (err: any) {
        this.logger.error(`Downgrade renewal charge failed for team ${teamId}: ${err.message}`);
        throw failed(err.message);
      }
      const inv = await this.prisma.invoice.create({
        data: {
          teamId,
          stripeInvoiceId: pi.id,
          amountDue: outstanding.renewal,
          amountPaid: outstanding.renewal,
          currency: 'usd',
          status: 'paid',
          periodStart: now,
          periodEnd: nextBillingDate,
          retryCount: 0,
        },
      });
      this.recordQbSale(inv.id);
      // The renewal is paid, so the period it buys runs before the move to Free.
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { currentPeriodStart: now, currentPeriodEnd: nextBillingDate, nextBillingDate },
      });
    }

    // As a successful retry does: lift the freeze and clear the failure counters.
    await this.prisma.team.updateMany({ where: { id: teamId, accountStatus: 'FROZEN' }, data: { accountStatus: 'ACTIVE' } });
    await this.prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'ACTIVE', retryCount: 0, lastRetryDate: null, firstFailureAt: null },
    });
  }

  /**
   * A move to Free scheduled by downgradeToFree is recorded in system_settings, so the
   * renewal job only ever switches teams that asked for it: a cancelAtPeriodEnd flag set
   * any other way (older rows, processor events) keeps being billed exactly as before.
   */
  private scheduledDowngradeKey(teamId: string) {
    return `billing_scheduled_free:${teamId}`;
  }

  private async markScheduledDowngrade(teamId: string, at: Date, userId: string) {
    const key = this.scheduledDowngradeKey(teamId);
    const value = { at: at.toISOString(), requestedBy: userId, requestedAt: new Date().toISOString() };
    await this.prisma.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  }

  private async clearScheduledDowngrade(teamId: string) {
    await this.prisma.systemSetting.deleteMany({ where: { key: this.scheduledDowngradeKey(teamId) } });
  }

  private async hasScheduledDowngrade(teamId: string): Promise<boolean> {
    return !!(await this.prisma.systemSetting.findUnique({ where: { key: this.scheduledDowngradeKey(teamId) } }));
  }

  /** Put a subscription on the Free plan now. */
  private async switchToFree(subscriptionId: string, freePlanId: string) {
    await this.prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        planId: freePlanId,
        status: 'ACTIVE',
        cancelAtPeriodEnd: false,
        currentPeriodStart: null,
        currentPeriodEnd: null,
        nextBillingDate: null,
        billingDayOfMonth: null,
        pendingPlanId: null,
        pendingAmountDue: null,
        retryCount: 0,
        lastRetryDate: null,
        firstFailureAt: null,
      },
    });
  }

  /**
   * Move to Free in the owner's order (2026-11-20): (a) pay what is owed with
   * the default card, (b) fit within the Free limits (projects, members,
   * storage, database size; monthly counters only warn), (c) switch — at the
   * end of a paid period still running, otherwise now. Nothing is deleted.
   */
  async downgradeToFree(teamId: string, userId: string) {
    await this.assertTeamOwner(teamId, userId);
    const { sub, freePlan, outstanding, scheduled } = await this.downgradeContext(teamId);
    if (scheduled) {
      const at = this.downgradeEffectiveAt(sub);
      return {
        message: at ? `Your plan already moves to Free on ${at.toISOString().slice(0, 10)}` : 'Your plan already moves to Free',
        scheduled: true,
        effectiveAt: at ? at.toISOString() : null,
      };
    }

    // (a) Pay outstanding invoices first.
    if (outstanding.total > 0) await this.settleOutstanding(teamId, sub, outstanding);

    // (b) Usage within the Free limits, measured now.
    const { blockers } = planLimitFindings(freePlan as any, await this.usageSnapshot(teamId));
    if (blockers.length) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'over_free_limits',
        message: `Reduce your usage to the Free plan limits first. ${blockers.map((b) => this.describeLimit(b)).join('; ')}.`,
        blockers,
      });
    }

    // (c) Switch. A failed upgrade still being retried never happened: it is dropped, not charged.
    const fresh: any = await this.prisma.subscription.findUnique({ where: { id: sub.id }, include: { plan: true } });
    const effectiveAt = this.downgradeEffectiveAt(fresh ?? sub);
    if (sub.stripeSubscriptionId) await this.stripe.cancelSubscription(sub.stripeSubscriptionId);
    if (effectiveAt) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAtPeriodEnd: true, pendingPlanId: null, pendingAmountDue: null },
      });
      if (!sub.stripeSubscriptionId) await this.markScheduledDowngrade(teamId, effectiveAt, userId);
    } else {
      await this.switchToFree(sub.id, freePlan.id);
      await this.clearScheduledDowngrade(teamId);
    }
    if (outstanding.pendingUpgrade > 0) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { status: 'ACTIVE', retryCount: 0, lastRetryDate: null, firstFailureAt: null },
      });
      await this.prisma.team.updateMany({ where: { id: teamId, accountStatus: 'FROZEN' }, data: { accountStatus: 'ACTIVE' } });
    }

    this.logger.log(`Team ${teamId} moves to Free ${effectiveAt ? `on ${effectiveAt.toISOString()}` : 'now'}`);
    this.realtime.publish({
      entityType: 'billing', action: 'subscription_canceled', entityId: teamId,
      actorUserId: userId, teamId,
    }).catch(() => {});
    return {
      message: effectiveAt
        ? `Your plan moves to Free on ${effectiveAt.toISOString().slice(0, 10)}`
        : 'Your plan is now Free',
      scheduled: !!effectiveAt,
      effectiveAt: effectiveAt ? effectiveAt.toISOString() : null,
    };
  }

  // ── Subscription Management ──────────────────────────

  /** Cancel = move to Free at the end of the paid period, through the same checks. */
  async cancelSubscription(teamId: string, userId: string) {
    return this.downgradeToFree(teamId, userId);
  }

  /** Resume a subscription that was set to move to Free */
  async resumeSubscription(teamId: string, userId: string) {
    await this.assertTeamOwner(teamId, userId);

    const sub = await this.prisma.subscription.findUnique({ where: { teamId } });
    if (!sub?.stripeSubscriptionId) {
      // Prepaid billing: the scheduled move is only a flag the renewal job reads.
      if (!sub?.cancelAtPeriodEnd) throw new BadRequestException('No scheduled change to undo');
      await this.prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: false } });
      await this.clearScheduledDowngrade(teamId);
      this.logger.log(`Scheduled move to Free undone for team ${teamId}`);
      return { message: 'Subscription resumed' };
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
    this.assertSelfServePlan(newPlan);
    // Moving to Free has its own order: pay what is owed, fit the limits, then switch.
    if (newPlan.name === 'free') return this.downgradeToFree(teamId, userId);
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
      throw this.cardRequired(newPlan);
    }

    const pm = await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId);
    if (!pm) {
      throw this.cardRequired(newPlan);
    }

    // Calculate proration credit (remaining value from current plan)
    const prorationCredit = this.calculateProrationCredit(
      currentPlan.priceMonthly,
      sub.currentPeriodStart || new Date(),
      sub.currentPeriodEnd || new Date(),
    );

    // Calculate amount to charge immediately (after any student discount)
    const amountDue = Math.max(
      0,
      this.withStudentDiscount(newPlan.priceMonthly, sub.studentDiscountPercent) - prorationCredit,
    );

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
        // A failed charge must not leave an invoice behind — drop the draft so
        // the user only ever has the invoice once payment actually succeeds.
        await this.prisma.invoice.delete({ where: { id: upgradeInvoice.id } }).catch(() => {});
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
        // An upgrade undoes a scheduled move to Free (prepaid billing; a processor subscription keeps its own flag).
        ...(sub.stripeSubscriptionId ? {} : { cancelAtPeriodEnd: false }),
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
    this.recordQbSale(upgradeInvoice.id);
    if (!sub.stripeSubscriptionId) {
      await this.clearScheduledDowngrade(teamId).catch((e: any) =>
        this.logger.warn(`Could not clear a scheduled move to Free for team ${teamId}: ${e.message}`),
      );
    }

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

    // A move to Free was scheduled for the end of the paid period: switch instead of charging.
    // Usage over the Free limits does not stop it; nothing is deleted, quotas stop new use.
    if (sub.cancelAtPeriodEnd && !sub.stripeSubscriptionId && (await this.hasScheduledDowngrade(sub.teamId))) {
      const freePlan = await this.prisma.plan.findUnique({ where: { name: 'free' } });
      if (freePlan) {
        await this.switchToFree(sub.id, freePlan.id);
        await this.clearScheduledDowngrade(sub.teamId);
        this.logger.log(`Team ${teamId} moved to the Free plan at the end of its paid period`);
        return { teamId, status: 'success', message: 'Moved to the Free plan as scheduled' };
      }
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
    const amountDue = hasPendingUpgrade
      ? sub.pendingAmountDue!
      : this.withStudentDiscount(sub.plan.priceMonthly, sub.studentDiscountPercent);

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
          const paidInv = openInv
            ? await this.prisma.invoice.update({
                where: { id: openInv.id },
                data: { status: 'paid', amountPaid: amountDue, stripeInvoiceId: paymentIntent.id },
              })
            : await this.prisma.invoice.create({
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
          this.recordQbSale(paidInv.id);

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
        const recurInv = openInv
          ? await this.prisma.invoice.update({
              where: { id: openInv.id },
              data: {
                status: 'paid',
                amountPaid: amountDue,
                stripeInvoiceId: paymentIntent.id,
                periodStart: now,
                periodEnd: nextBillingDate,
              },
            })
          : await this.prisma.invoice.create({
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
        this.recordQbSale(recurInv.id);

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

    // Do NOT create an invoice for a failed charge. A failed payment should
    // leave no invoice record at all — the invoice appears only once payment
    // succeeds. Clear any lingering local draft from this attempt. (Retry state
    // lives on the subscription: pendingPlanId/pendingAmountDue/firstFailureAt.)
    if (chargeAmountCents > 0) {
      await this.prisma.invoice.deleteMany({
        where: {
          teamId,
          status: { in: ['open', 'unpaid'] },
          amountPaid: 0,
          stripeInvoiceId: null,
        },
      });
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
    const amountDue = hasPendingUpgrade
      ? sub.pendingAmountDue!
      : this.withStudentDiscount(sub.plan.priceMonthly, sub.studentDiscountPercent);

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
          const retryInv = openInv
            ? await this.prisma.invoice.update({
                where: { id: openInv.id },
                data: { status: 'paid', amountPaid: amountDue, stripeInvoiceId: paymentIntent.id },
              })
            : await this.prisma.invoice.create({
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
          this.recordQbSale(retryInv.id);

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

          const retryInv2 = await this.prisma.invoice.create({
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
          this.recordQbSale(retryInv2.id);
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

  private static readonly UNPAID = ['open', 'unpaid', 'payment_failed'];

  /** The invoice must be the team's, still unpaid, and collectable here (not a Stripe-hosted invoice). */
  private payableInvoiceError(inv: any, teamId: string): string | null {
    if (!inv || inv.teamId !== teamId) return 'Invoice not found for this team';
    if (!BillingService.UNPAID.includes((inv.status || '').toLowerCase())) return 'Invoice is not payable';
    if (inv.amountDue - inv.amountPaid <= 0) return 'Invoice has nothing outstanding';
    // shortcut: a Stripe invoice (in_...) is re-synced from Stripe and would undo a PayPal payment; allow when Stripe invoices stop being synced.
    if (inv.stripeInvoiceId?.startsWith('in_')) return 'This invoice is collected through Stripe and cannot be paid with PayPal';
    return null;
  }

  async createPayPalOrder(teamId: string, userId: string, invoiceId: string) {
    await this.assertTeamOwner(teamId, userId);
    if (!this.paypal.isEnabled()) throw new BadRequestException('PayPal is not available');
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    const err = this.payableInvoiceError(inv, teamId);
    if (err) throw new BadRequestException(err);
    const base = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
    try {
      return await this.paypal.createOrder({
        invoiceId: inv!.id,
        amountCents: inv!.amountDue - inv!.amountPaid,
        currency: inv!.currency,
        returnUrl: `${base}/dashboard/billing?paypal=return`,
        cancelUrl: `${base}/dashboard/billing?paypal=cancel`,
      });
    } catch (e: any) {
      this.logger.error(`PayPal order failed for invoice ${invoiceId}: ${e.message}`);
      throw new BadRequestException('Could not start the PayPal payment. Please try again.');
    }
  }

  /** Verify the approved order against the invoice, capture it, then settle the invoice (idempotent). */
  async capturePayPalOrder(teamId: string, userId: string, orderId: string): Promise<{ message: string; success: boolean }> {
    await this.assertTeamOwner(teamId, userId);
    if (!this.paypal.isEnabled()) throw new BadRequestException('PayPal is not available');
    let order;
    try {
      order = await this.paypal.getOrder(orderId);
    } catch {
      throw new BadRequestException('PayPal order not found');
    }
    const unit = order.purchase_units?.[0];
    const inv = unit?.custom_id ? await this.prisma.invoice.findUnique({ where: { id: unit.custom_id } }) : null;
    if (!inv || inv.teamId !== teamId) throw new BadRequestException('This PayPal order does not belong to this team');
    if (inv.status === 'paid') return { message: 'Invoice already paid', success: true };

    const err = this.payableInvoiceError(inv, teamId);
    if (err) throw new BadRequestException(err);
    const outstanding = inv.amountDue - inv.amountPaid;
    if (
      unit?.amount?.value !== PayPalService.formatAmount(outstanding) ||
      (unit?.amount?.currency_code || '').toUpperCase() !== inv.currency.toUpperCase()
    ) {
      throw new BadRequestException('The invoice amount changed since the PayPal order was created. Please pay again.');
    }

    let status = order.status;
    if (status === 'APPROVED') {
      try {
        status = (await this.paypal.captureOrder(orderId)).status;
      } catch (e: any) {
        this.logger.error(`PayPal capture failed for order ${orderId}: ${e.message}`);
        throw new BadRequestException('PayPal could not complete the payment');
      }
    }
    // COMPLETED before our capture = an earlier attempt captured it and then failed to settle; settle now.
    if (status !== 'COMPLETED') throw new BadRequestException(`PayPal payment not completed (${status})`);

    const settled = await this.prisma.invoice.updateMany({
      where: { id: inv.id, status: { in: BillingService.UNPAID } },
      data: { status: 'paid', amountPaid: inv.amountDue },
    });
    if (settled.count === 0) return { message: 'Invoice already paid', success: true };
    this.recordQbSale(inv.id);

    // As a successful Stripe retry does: lift the freeze and clear the failure counters.
    await this.prisma.team.updateMany({ where: { id: teamId, accountStatus: 'FROZEN' }, data: { accountStatus: 'ACTIVE' } });
    await this.prisma.subscription.updateMany({
      where: { teamId, OR: [{ status: 'PAST_DUE' }, { firstFailureAt: { not: null } }] },
      data: { status: 'ACTIVE', retryCount: 0, lastRetryDate: null, firstFailureAt: null },
    });
    this.logger.log(`Invoice ${inv.id} paid with PayPal for team ${teamId}`);
    return { message: 'Payment successful', success: true };
  }

  /**
   * Preview plan change with PREPAID model:
   * Shows proration credit and amount due immediately.
   */
  async previewPlanChange(teamId: string, userId: string, newPlanName: string) {
    await this.assertTeamOwner(teamId, userId);

    let newPlan = await this.getPlanByName(newPlanName);
    this.assertSelfServePlan(newPlan);
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
    // A paid plan is never chosen without a saved default card (owner, 2026-11-20).
    if (planRequiresCard(newPlan)) {
      const pm =
        sub.stripeCustomerId && this.stripe.isEnabled()
          ? await this.stripe.getDefaultPaymentMethod(sub.stripeCustomerId).catch(() => null)
          : null;
      if (!pm) throw this.cardRequired(newPlan);
    }

    // Calculate proration credit
    const prorationCredit = this.calculateProrationCredit(
      currentPlan.priceMonthly,
      sub.currentPeriodStart || new Date(),
      sub.currentPeriodEnd || new Date(),
    );

    const amountDue = Math.max(
      0,
      this.withStudentDiscount(newPlan.priceMonthly, sub.studentDiscountPercent) - prorationCredit,
    );

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

  /** Plans with the number of teams on each, so the console can tell which plans are safe to delete. */
  async listManagementPlans() {
    const plans = await this.prisma.plan.findMany({
      orderBy: { priceMonthly: 'asc' },
      include: { _count: { select: { subscriptions: true } } },
    });
    return plans.map(({ _count, ...plan }) => ({ ...plan, subscriptionCount: _count.subscriptions }));
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
      maxDbConnections?: number | null;
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

  /** A plan with teams on it is never deleted: that would silently move paying teams to another plan. */
  async deleteManagementPlan(planName: string) {
    const plan = await this.getPlanByName(planName);
    if (plan.name === 'free') {
      throw new BadRequestException('Free plan cannot be deleted');
    }
    const teams = await this.prisma.subscription.count({ where: { planId: plan.id } });
    if (teams > 0) {
      throw new BadRequestException(
        `Plan "${plan.name}" is used by ${teams} team(s). Move them to another plan first.`,
      );
    }
    await this.prisma.plan.delete({ where: { id: plan.id } });
    return { deletedPlan: plan.name };
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
