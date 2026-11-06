import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { StripeService } from '../stripe/stripe.service';
import { PlatformAlertsService } from './platform-alerts.service';

/**
 * Owner rule (2026-11-06): payment must always be active. On that day a customer
 * got "internal error" adding a card and 17 of 55 teams were found with a stored
 * Stripe customer that no longer exists. This probe walks the card form's whole
 * path every 10 minutes and raises a critical console alert when it breaks.
 *
 * Two consecutive failing runs are required, so one Stripe or network blip does
 * not page anyone (a false alarm costs trust).
 */
const FAILING_RUNS_BEFORE_ALERT = 2;

@Injectable()
export class PaymentProbeService {
  private readonly logger = new Logger(PaymentProbeService.name);
  private failingRuns = 0;

  constructor(
    private readonly stripe: StripeService,
    private readonly config: ConfigService,
    private readonly alerts: PlatformAlertsService,
  ) {}

  @Cron('*/10 * * * *')
  async run(): Promise<void> {
    if (!this.stripe.isEnabled()) return; // billing intentionally off (self-host)
    let problems: string[];
    try {
      const results = await this.stripe.probeChannels(
        this.config.get<string>('stripe.publishableKey') ?? '',
      );
      problems = results.filter((r) => r.problem).map((r) => `${r.check}: ${r.problem}`);
    } catch (err: any) {
      problems = [`probe: ${err.message}`];
    }

    if (problems.length === 0) {
      this.failingRuns = 0;
      return;
    }
    this.failingRuns += 1;
    this.logger.warn(`Payment probe failing (${this.failingRuns}): ${problems.join(' | ')}`);
    if (this.failingRuns < FAILING_RUNS_BEFORE_ALERT) return;
    await this.alerts.raise({
      kind: 'payment_probe_failed',
      severity: 'critical',
      title: 'Payments are not working: the card-form probe is failing',
      detail:
        `Customers may be unable to add a card or pay. Failing checks: ${problems.join('; ')}. ` +
        'Fix before anything else; payment must always be active.',
      metadata: { problems },
    });
  }
}
