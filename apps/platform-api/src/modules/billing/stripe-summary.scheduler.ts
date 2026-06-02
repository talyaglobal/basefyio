import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  stripeDailySummaryTemplate,
  type StripeDailySummaryData,
} from '../email/templates/stripe-daily-summary.template';

const SUMMARY_RECIPIENT = 'support@talyasmart.com';
const SETTINGS_KEY = 'stripe_email_summary';

interface EmailSettings {
  daily: boolean;
  weekly: boolean;
  monthly: boolean;
  yearly: boolean;
}

@Injectable()
export class StripeSummaryScheduler {
  private readonly logger = new Logger(StripeSummaryScheduler.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  private async getSettings(): Promise<EmailSettings> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY },
    });
    return (row?.value as any) ?? { daily: false, weekly: false, monthly: false, yearly: false };
  }

  /** Daily — 08:00 UTC every day */
  @Cron('0 8 * * *')
  async onDaily() {
    const settings = await this.getSettings();
    if (!settings.daily) return;
    await this.sendSummary('Daily');
  }

  /** Weekly — Monday 08:00 UTC */
  @Cron('0 8 * * 1')
  async onWeekly() {
    const settings = await this.getSettings();
    if (!settings.weekly) return;
    await this.sendSummary('Weekly');
  }

  /** Monthly — 1st of month 08:00 UTC */
  @Cron('0 8 1 * *')
  async onMonthly() {
    const settings = await this.getSettings();
    if (!settings.monthly) return;
    await this.sendSummary('Monthly');
  }

  /** Yearly — Jan 1st 08:00 UTC */
  @Cron('0 8 1 1 *')
  async onYearly() {
    const settings = await this.getSettings();
    if (!settings.yearly) return;
    await this.sendSummary('Yearly');
  }

  private async sendSummary(period: string) {
    if (!this.stripe.isEnabled()) {
      this.logger.debug('Stripe not configured — skipping summary email');
      return;
    }

    this.logger.log(`Generating Stripe ${period} summary email…`);

    try {
      const client = this.stripe.getClient();

      const [charges, balanceTxns, invoices, subscriptions, customers] =
        await Promise.all([
          client.charges.list({ limit: 50, expand: ['data.customer'] }),
          client.balanceTransactions.list({ limit: 50 }),
          client.invoices.list({ limit: 50, expand: ['data.customer', 'data.subscription'] }),
          client.subscriptions.list({ limit: 100, status: 'all', expand: ['data.customer', 'data.plan'] }),
          client.customers.list({ limit: 100 }),
        ]);

      const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;

      const revenueTxns = balanceTxns.data.filter(
        (t) => t.type === 'charge' && t.status === 'available',
      );
      const totalRevenue = revenueTxns.reduce((s, t) => s + t.net, 0);
      const totalGross = revenueTxns.reduce((s, t) => s + t.amount, 0);
      const totalFees = revenueTxns.reduce((s, t) => s + t.fee, 0);

      const activeSubs = subscriptions.data.filter((s) => s.status === 'active');
      const canceledSubs = subscriptions.data.filter((s) => s.status === 'canceled');
      const pastDueSubs = subscriptions.data.filter((s) => s.status === 'past_due');
      const mrr = activeSubs.reduce((s, sub) => {
        const item = sub.items?.data[0];
        return s + (item?.price?.unit_amount || 0);
      }, 0);

      const customerName = (obj: any): string => {
        if (typeof obj === 'object' && obj && !obj.deleted) {
          return obj.name || obj.email || '—';
        }
        return '—';
      };

      const data: StripeDailySummaryData = {
        date: new Date().toLocaleDateString('en-US', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        }),
        totalRevenue: fmt(totalRevenue),
        totalGross: fmt(totalGross),
        totalFees: fmt(totalFees),
        mrr: fmt(mrr),
        activeSubscriptions: activeSubs.length,
        pastDueSubscriptions: pastDueSubs.length,
        canceledSubscriptions: canceledSubs.length,
        totalCustomers: customers.data.length,
        recentCharges: charges.data.slice(0, 15).map((c) => ({
          date: new Date(c.created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
          customer: customerName(c.customer),
          amount: fmt(c.amount),
          status: c.status,
        })),
        recentInvoices: invoices.data.slice(0, 15).map((inv) => ({
          number: inv.number || inv.id?.slice(-8) || '—',
          customer: customerName(inv.customer),
          amount: fmt(inv.amount_due),
          status: inv.status || '—',
          url: inv.hosted_invoice_url || null,
        })),
        activeSubscriptionsList: activeSubs.slice(0, 20).map((s) => ({
          customer: customerName(s.customer),
          plan: s.metadata?.planName || s.items?.data[0]?.price?.nickname || '—',
          amount: fmt(s.items?.data[0]?.price?.unit_amount || 0) + '/mo',
          periodEnd: s.current_period_end
            ? new Date(s.current_period_end * 1000).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
              })
            : '—',
        })),
      };

      const html = stripeDailySummaryTemplate(data);
      await this.email.sendRawHtml(
        SUMMARY_RECIPIENT,
        `Kolaybase Stripe ${period} Summary — ${data.date}`,
        html,
      );

      this.logger.log(`Stripe ${period} summary sent to ${SUMMARY_RECIPIENT}`);
    } catch (err: any) {
      this.logger.error(`Failed to send Stripe ${period} summary: ${err.message}`, err.stack);
    }
  }
}
