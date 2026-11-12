import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StripeService } from '../stripe/stripe.service';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  stripeDailySummaryTemplate,
  type StripeDailySummaryData,
} from '../email/templates/stripe-daily-summary.template';
import { StripeOverviewService } from './stripe-overview.service';
import {
  DEFAULT_EMAIL_REPORTS_CONFIG,
  EMAIL_REPORTS_KEY,
  EmailReportsConfig,
  ReportPeriod,
  isLastDayOfMonthUtc,
  reportPeriodStart,
  reportRecipients,
} from './email-reports';

@Injectable()
export class StripeSummaryScheduler {
  private readonly logger = new Logger(StripeSummaryScheduler.name);

  constructor(
    private readonly stripe: StripeService,
    private readonly email: EmailService,
    private readonly prisma: PrismaService,
    private readonly stripeOverview: StripeOverviewService,
  ) {}

  private async getConfig(): Promise<EmailReportsConfig> {
    const row = await this.prisma.systemSetting.findUnique({
      where: { key: EMAIL_REPORTS_KEY },
    });
    const stored = (row?.value as Partial<EmailReportsConfig> | null) ?? null;
    return {
      schedule: { ...DEFAULT_EMAIL_REPORTS_CONFIG.schedule, ...(stored?.schedule ?? {}) },
      content: stored?.content ?? {},
      recipients: Array.isArray(stored?.recipients) ? stored!.recipients : [],
    };
  }

  /** Daily — 08:00 UTC every day */
  @Cron('0 8 * * *', { timeZone: 'UTC' })
  async onDaily() {
    const config = await this.getConfig();
    if (!config.schedule.daily) return;
    await this.sendSummary('Daily', config);
  }

  /** Weekly — Friday 08:00 UTC */
  @Cron('0 8 * * 5', { timeZone: 'UTC' })
  async onWeekly() {
    const config = await this.getConfig();
    if (!config.schedule.weekly) return;
    await this.sendSummary('Weekly', config);
  }

  /**
   * Monthly — last day of the month, 08:00 UTC. Fires on the 28th–31st and
   * sends only on the month's real last day, so February is not skipped.
   */
  @Cron('0 8 28-31 * *', { timeZone: 'UTC' })
  async onMonthly() {
    if (!isLastDayOfMonthUtc(new Date())) return;
    const config = await this.getConfig();
    if (!config.schedule.monthly) return;
    await this.sendSummary('Monthly', config);
  }

  /** Yearly — December 31st 08:00 UTC, the last day of the year. */
  @Cron('0 8 31 12 *', { timeZone: 'UTC' })
  async onYearly() {
    const config = await this.getConfig();
    if (!config.schedule.yearly) return;
    await this.sendSummary('Yearly', config);
  }

  private async sendSummary(period: ReportPeriod, config: EmailReportsConfig) {
    this.logger.log(`Generating ${period} email report…`);
    const content = config.content || {};

    try {
      // Gather platform stats if any platform content is enabled
      let platformStats = '';
      if (content.newUsers || content.newProjects || content.deletedProjects || content.newTeams || content.deletedTeams) {
        const since = reportPeriodStart(period, new Date());

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
        html = baseLayout(`<div class="body"><h1 class="greeting">basefyio ${period} Report</h1>${platformStats}</div>`);
      }

      const subject = `basefyio ${period} Report — ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })}`;
      const recipients = reportRecipients(config);
      for (const to of recipients) {
        await this.email.sendRawHtml(to, subject, html);
      }

      this.logger.log(`${period} report sent to ${recipients.join(', ')}`);
    } catch (err: any) {
      this.logger.error(`Failed to send ${period} report: ${err.message}`, err.stack);
    }
  }

  /** The Stripe section, limited to basefyio customers like the console's Stripe screen. */
  private async buildStripeData(): Promise<StripeDailySummaryData | null> {
    const overview = await this.stripeOverview.getOverview();
    if (!overview.configured) return null;

    const fmt = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    const who = (x: { teamName: string | null; customerName: string | null; customerEmail: string | null }) =>
      x.teamName || x.customerName || x.customerEmail || '—';
    const s = overview.summary;

    return {
      date: new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
      totalRevenue: fmt(s.totalRevenue),
      totalGross: fmt(s.totalGross),
      totalFees: fmt(s.totalFees),
      mrr: fmt(s.mrr),
      activeSubscriptions: s.payingTeams,
      pastDueSubscriptions: s.pastDueTeams,
      canceledSubscriptions: s.canceledSubscriptions,
      totalCustomers: s.totalCustomers,
      recentCharges: overview.recentCharges.slice(0, 15).map((c) => ({
        date: new Date(c.created).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
        customer: who(c),
        amount: fmt(c.amount),
        status: c.status,
      })),
      recentInvoices: overview.recentInvoices.slice(0, 15).map((inv) => ({
        number: inv.number || inv.id?.slice(-8) || '—',
        customer: who(inv),
        amount: fmt(inv.amount),
        status: inv.status || '—',
        url: inv.hostedUrl || null,
      })),
      activeSubscriptionsList: overview.activeSubscriptions.slice(0, 20).map((sub) => ({
        customer: who(sub),
        plan: sub.planName || '—',
        amount: fmt(sub.amount) + '/mo',
        periodEnd: sub.currentPeriodEnd
          ? new Date(sub.currentPeriodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
          : '—',
      })),
    };
  }
}
