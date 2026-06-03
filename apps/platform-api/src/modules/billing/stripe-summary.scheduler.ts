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
const SETTINGS_KEY = 'email_reports_config';

interface EmailReportsConfig {
  schedule: { daily: boolean; weekly: boolean; monthly: boolean; yearly: boolean };
  content: Record<string, boolean>;
}

@Injectable()
export class StripeSummaryScheduler {
  private readonly logger = new Logger(StripeSummaryScheduler.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
  ) {}

  private async getConfig(): Promise<EmailReportsConfig> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: SETTINGS_KEY },
    });
    return (row?.value as any) ?? {
      schedule: { daily: false, weekly: false, monthly: false, yearly: false },
      content: {},
    };
  }

  /** Daily — 08:00 UTC every day */
  @Cron('0 8 * * *')
  async onDaily() {
    const config = await this.getConfig();
    if (!config.schedule.daily) return;
    await this.sendSummary('Daily', config);
  }

  /** Weekly — Friday 08:00 UTC */
  @Cron('0 8 * * 5')
  async onWeekly() {
    const config = await this.getConfig();
    if (!config.schedule.weekly) return;
    await this.sendSummary('Weekly', config);
  }

  /** Monthly — 30th of month 08:00 UTC */
  @Cron('0 8 30 * *')
  async onMonthly() {
    const config = await this.getConfig();
    if (!config.schedule.monthly) return;
    await this.sendSummary('Monthly', config);
  }

  /** Yearly — December 30th 08:00 UTC */
  @Cron('0 8 30 12 *')
  async onYearly() {
    const config = await this.getConfig();
    if (!config.schedule.yearly) return;
    await this.sendSummary('Yearly', config);
  }

  private async sendSummary(period: string, config: EmailReportsConfig) {
    this.logger.log(`Generating ${period} email report…`);
    const content = config.content || {};

    try {
      // Gather platform stats if any platform content is enabled
      let platformStats = '';
      if (content.newUsers || content.newProjects || content.deletedProjects || content.newTeams || content.deletedTeams) {
        const now = new Date();
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const since = period === 'Daily' ? dayAgo : period === 'Weekly' ? weekAgo : new Date(now.getFullYear(), now.getMonth(), 1);

        const [users, projects, deletedProjects, teams] = await Promise.all([
          content.newUsers ? this.prisma.user.count({ where: { createdAt: { gte: since } } }) : Promise.resolve(0),
          content.newProjects ? this.prisma.project.count({ where: { createdAt: { gte: since }, status: 'ACTIVE' } }) : Promise.resolve(0),
          content.deletedProjects ? this.prisma.project.count({ where: { updatedAt: { gte: since }, status: 'DELETED' } }) : Promise.resolve(0),
          content.newTeams ? this.prisma.team.count({ where: { createdAt: { gte: since } } }) : Promise.resolve(0),
        ]);

        const rows: string[] = [];
        if (content.newUsers) rows.push(`<tr><td style="padding:6px 0;font-size:14px;color:#64748b">New Users</td><td style="padding:6px 0;font-size:14px;font-weight:600;text-align:right">${users}</td></tr>`);
        if (content.newProjects) rows.push(`<tr><td style="padding:6px 0;font-size:14px;color:#64748b">New Projects</td><td style="padding:6px 0;font-size:14px;font-weight:600;text-align:right">${projects}</td></tr>`);
        if (content.deletedProjects) rows.push(`<tr><td style="padding:6px 0;font-size:14px;color:#64748b">Deleted Projects</td><td style="padding:6px 0;font-size:14px;font-weight:600;text-align:right">${deletedProjects}</td></tr>`);
        if (content.newTeams) rows.push(`<tr><td style="padding:6px 0;font-size:14px;color:#64748b">New Teams</td><td style="padding:6px 0;font-size:14px;font-weight:600;text-align:right">${teams}</td></tr>`);

        if (rows.length > 0) {
          platformStats = `
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin-bottom:20px">
              <div style="font-size:14px;font-weight:600;margin-bottom:10px">Platform Activity (${period})</div>
              <table style="width:100%;border-collapse:collapse">${rows.join('')}</table>
            </div>`;
        }
      }

      // Stripe data
      let stripeHtml = '';
      if (content.stripe && this.stripe.isEnabled()) {
        const data = await this.buildStripeData();
        if (data) {
          stripeHtml = stripeDailySummaryTemplate(data);
        }
      }

      // If no content was generated, skip
      if (!platformStats && !stripeHtml) {
        this.logger.debug('No email report content enabled — skipping');
        return;
      }

      // Build final email — if stripe template is used, inject platform stats before it
      // Otherwise send platform stats alone
      let html: string;
      if (stripeHtml && platformStats) {
        // Insert platform stats into the stripe template body
        html = stripeHtml.replace('</h1>', `</h1>${platformStats}`);
      } else if (stripeHtml) {
        html = stripeHtml;
      } else {
        const { baseLayout } = await import('../email/templates/base.template');
        html = baseLayout(`<div class="body"><h1 class="greeting">Kolaybase ${period} Report</h1>${platformStats}</div>`);
      }

      await this.email.sendRawHtml(
        SUMMARY_RECIPIENT,
        `Kolaybase ${period} Report — ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`,
        html,
      );

      this.logger.log(`${period} report sent to ${SUMMARY_RECIPIENT}`);
    } catch (err: any) {
      this.logger.error(`Failed to send ${period} report: ${err.message}`, err.stack);
    }
  }

  private async buildStripeData(): Promise<StripeDailySummaryData | null> {
    if (!this.stripe.isEnabled()) return null;

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
    const revenueTxns = balanceTxns.data.filter((t) => t.type === 'charge' && t.status === 'available');
    const totalRevenue = revenueTxns.reduce((s, t) => s + t.net, 0);
    const totalGross = revenueTxns.reduce((s, t) => s + t.amount, 0);
    const totalFees = revenueTxns.reduce((s, t) => s + t.fee, 0);
    const activeSubs = subscriptions.data.filter((s) => s.status === 'active');
    const canceledSubs = subscriptions.data.filter((s) => s.status === 'canceled');
    const pastDueSubs = subscriptions.data.filter((s) => s.status === 'past_due');
    const mrr = activeSubs.reduce((s, sub) => s + (sub.items?.data[0]?.price?.unit_amount || 0), 0);
    const customerName = (obj: any): string =>
      typeof obj === 'object' && obj && !obj.deleted ? (obj.name || obj.email || '—') : '—';

    return {
      date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
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
          ? new Date(s.current_period_end * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          : '—',
      })),
    };
  }
}
