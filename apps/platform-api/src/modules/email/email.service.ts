import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { MetricsService } from '../health/metrics.service';
import { welcomeTemplate } from './templates/welcome.template';
import { signInTemplate } from './templates/signin.template';
import { inviteTemplate } from './templates/invite.template';
import { feedbackTemplate } from './templates/feedback.template';
import { passwordResetTemplate } from './templates/password-reset.template';
import { forgotPasswordTemplate } from './templates/forgot-password.template';
import { projectVerifyEmailTemplate } from './templates/project-verify-email.template';
import { projectResetPasswordTemplate } from './templates/project-reset-password.template';
import { projectWelcomeTemplate } from './templates/project-welcome.template';
import {
  projectAsleepTemplate,
  projectSleepWarningTemplate,
} from './templates/project-sleep.template';
import { projectInviteUserTemplate } from './templates/project-invite-user.template';
import { projectMagicLinkTemplate } from './templates/project-magic-link.template';
import { projectChangeEmailTemplate } from './templates/project-change-email.template';
import { projectReauthTemplate } from './templates/project-reauth.template';
import { signupVerifyEmailTemplate } from './templates/signup-verify-email.template';

/** Domain states a provider reports for a sender domain that cannot send yet. */
const UNSENDABLE_DOMAIN_STATUS = new Set(['not_started', 'pending', 'failed']);

/** `basefyio <noreply@basefyio.com>` → `basefyio.com`; undefined when there is no address. */
export function senderDomain(from: string | undefined): string | undefined {
  const match = /@([^\s<>@]+?)>?\s*$/.exec(from ?? '');
  return match ? match[1].toLowerCase() : undefined;
}

/**
 * What a domains listing says about the sender domain.
 *
 * `problem` is set only when the listing proves mail from that domain cannot
 * leave: the list is complete and the domain is missing from it, or the
 * provider names it with a status that cannot send. A listing in a shape we do
 * not recognise, or one with more pages, proves nothing, so `confirmed` is
 * false and no verdict is passed.
 */
export function senderDomainVerdict(
  from: string | undefined,
  listing: unknown,
): { confirmed: boolean; problem?: string } {
  const domain = senderDomain(from);
  const body = listing as { data?: unknown; has_more?: unknown } | unknown[] | null | undefined;
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : undefined;
  if (!domain || !rows) return { confirmed: false };
  const named = rows.filter(
    (r): r is { name: string; status?: unknown } => typeof (r as { name?: unknown })?.name === 'string',
  );
  if (named.length !== rows.length) return { confirmed: false };

  // A domain verified at the provider also covers its subdomains' mailboxes on
  // most providers; matching the parent too keeps a false alarm off the table.
  const match = named.find((r) => {
    const name = r.name.toLowerCase();
    return domain === name || domain.endsWith(`.${name}`);
  });
  if (!match) {
    const complete = Array.isArray(body) || (body as { has_more?: unknown }).has_more !== true;
    return complete
      ? {
          confirmed: false,
          problem: `sender_domain_not_registered — ${domain} is not registered with the mail provider`,
        }
      : { confirmed: false };
  }
  const status = typeof match.status === 'string' ? match.status : '';
  if (UNSENDABLE_DOMAIN_STATUS.has(status)) {
    return {
      confirmed: false,
      problem: `sender_domain_not_verified — ${match.name} is ${status} at the mail provider`,
    };
  }
  return { confirmed: true };
}

@Injectable()
export class EmailService implements OnModuleInit, OnModuleDestroy {
  /** Provider errors that mean the key is unusable, as opposed to limited. */
  private static readonly KEY_IS_BAD = new Set(['invalid_api_key', 'missing_api_key']);

  /**
   * Send rejections about the sender rather than the message: the key, the
   * from address or its domain. The probe can see all of them, so once it
   * confirms the key works and the domain may send, such a rejection is over.
   * `validation_error` is here because that is how a provider reports an
   * unverified from domain; its other use, a bad recipient, is one message's
   * problem and must not keep the whole mail path marked down either.
   */
  private static readonly SENDER_IS_BAD = new Set([
    'invalid_api_key',
    'missing_api_key',
    'invalid_from_address',
    'validation_error',
  ]);

  /** How often the probe runs again after startup. */
  static readonly REPROBE_INTERVAL_MS = 10 * 60 * 1000;

  private readonly logger = new Logger(EmailService.name);
  private reprobeTimer?: NodeJS.Timeout;
  /** Who reported the current failure, and with which provider error. */
  private failure?: { source: 'probe' | 'send'; code: string };
  private resend: Resend | null = null;
  private readonly fromEmail: string;
  private readonly replyTo: string;
  private readonly appUrl: string;

  /**
   * What we last knew about whether mail can actually leave.
   *
   * 'unchecked' until the startup probe answers. Kept so /health can say so:
   * a dead provider key rejected every send for weeks while the only sign was
   * an ERROR line in a log nobody reads, and the first person to notice was a
   * customer who never got a password reset.
   */
  private deliverability: {
    state: 'unchecked' | 'ok' | 'failing' | 'not-configured';
    detail?: string;
    checkedAt?: string;
  } = { state: 'unchecked' };

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly metrics?: MetricsService,
  ) {
    const apiKey = this.config.get<string>('resend.apiKey');
    if (apiKey) {
      this.resend = new Resend(apiKey);
    } else {
      this.deliverability = { state: 'not-configured' };
      this.logger.warn('No mail provider API key is set — emails will not be sent');
    }
    this.fromEmail = this.config.get<string>('resend.fromEmail')!;
    this.replyTo = this.config.get<string>('resend.replyTo')!;
    this.appUrl = this.config.get<string>('appUrl')!;
  }

  /**
   * Ask the provider whether mail can leave: at startup, then every ten minutes.
   *
   * Cheaper than discovering it on the first password reset, and it fails in
   * the one place an operator looks. Never throws: mail being down must not
   * stop the API from starting, since everything else still works.
   *
   * Running again matters both ways. Without it a fixed sender domain kept
   * /health on 'failing' until someone happened to request a mail, and a
   * restart reported 'ok' for a key that worked but a from domain that could
   * not send, until the first password reset bounced.
   */
  async onModuleInit(): Promise<void> {
    if (!this.resend) return;
    await this.probe();
    this.reprobeTimer = setInterval(() => void this.probe(), EmailService.REPROBE_INTERVAL_MS);
    this.reprobeTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.reprobeTimer) clearInterval(this.reprobeTimer);
  }

  /** One look at the provider: is the key accepted, and may the from domain send? */
  async probe(): Promise<void> {
    if (!this.resend) return;
    let probe: Awaited<ReturnType<Resend['domains']['list']>>;
    try {
      probe = await this.resend.domains.list();
    } catch (err: any) {
      // A network blip is not proof the key is bad, so say what happened
      // rather than condemning the key — and never overwrite a verdict we
      // already had with "could not tell".
      if (this.deliverability.state === 'unchecked') {
        this.deliverability = {
          state: 'unchecked',
          detail: `startup probe did not complete: ${err?.message ?? err}`,
          checkedAt: new Date().toISOString(),
        };
      }
      this.logger.warn(`[EMAIL] Could not reach the mail provider to check the key: ${err?.message ?? err}`);
      return;
    }

    if (probe.error) {
      // Only a refusal that means the KEY ITSELF is bad counts as mail being
      // down. The probe reads the domains endpoint, which a key can be
      // refused on for reasons that have nothing to do with sending — it may
      // be scoped to sending only, or its creator may lack a console right.
      // Listing those instead would mean a false 'mail is down' every time
      // the provider adds a new one, so the narrow list is the one that
      // condemns the key and everything else is treated as valid-but-limited.
      const err = String(probe.error.name ?? '');
      if (EmailService.KEY_IS_BAD.has(err)) {
        this.markFailing(`${probe.error.name ?? 'error'} — ${probe.error.message ?? 'unknown'}`, 'probe', err);
        return;
      }
      // A limited key cannot list domains, so the sender domain stays unchecked.
      this.markProbeHealthy(false, `limited: ${err || 'unspecified'}`);
      return;
    }

    const verdict = senderDomainVerdict(this.fromEmail, probe.data);
    if (verdict.problem) {
      this.markFailing(verdict.problem, 'probe', 'sender_domain');
      return;
    }
    this.markProbeHealthy(verdict.confirmed);
  }

  /**
   * The probe found nothing wrong. That clears what the probe can see, and a
   * send rejection about the sender once the domain is positively confirmed;
   * a rejection the probe cannot see (an exhausted quota) waits for the next
   * successful send instead.
   */
  private markProbeHealthy(senderConfirmed: boolean, note?: string): void {
    if (this.deliverability.state === 'failing' && this.failure) {
      const cleared =
        this.failure.source === 'probe' ||
        (senderConfirmed && EmailService.SENDER_IS_BAD.has(this.failure.code));
      if (!cleared) return;
      this.logger.log('[EMAIL] The mail provider now accepts the key and the sender domain — delivery recovered');
    } else if (this.deliverability.state !== 'ok') {
      this.logger.log(`[EMAIL] Provider key accepted${note ? ` (${note})` : ''} — mail can be sent`);
    }
    this.failure = undefined;
    this.deliverability = { state: 'ok', checkedAt: new Date().toISOString() };
  }

  private markFailing(detail: string, source: 'probe' | 'send' = 'send', code = ''): void {
    const repeated = this.deliverability.state === 'failing' && this.deliverability.detail === detail;
    this.failure = { source, code };
    this.deliverability = { state: 'failing', detail, checkedAt: new Date().toISOString() };
    // The re-probe repeats the same finding every ten minutes; count and shout once.
    if (repeated && source === 'probe') return;
    this.metrics?.increment('email_provider_rejected');
    this.logger.error(
      `[EMAIL] MAIL IS NOT BEING DELIVERED — the provider rejected the request: ${detail}. ` +
        'Password resets, team invitations and verification codes are all silently failing until this is fixed.',
    );
  }

  /** What /health reports, so a dead mail path is visible without reading logs. */
  getDeliverability(): { state: string; detail?: string; checkedAt?: string } {
    return this.deliverability;
  }

  async sendSignupVerifyEmail(to: string, otp: string, firstName?: string) {
    const html = signupVerifyEmailTemplate({ email: to, otp, firstName });
    return this.send({ to, subject: 'Verify your email to join basefyio', html });
  }

  async sendStudentVerifyEmail(to: string, otp: string) {
    const html = signupVerifyEmailTemplate({ email: to, otp });
    return this.send({
      to,
      subject: 'Your basefyio student verification code',
      html,
    });
  }

  async sendWelcome(to: string, displayName: string) {
    const html = welcomeTemplate({
      displayName,
      email: to,
      loginUrl: `${this.appUrl}/login`,
      dashboardUrl: `${this.appUrl}/dashboard`,
    });

    return this.send({
      to,
      subject: `Welcome to basefyio, ${displayName}! 🚀`,
      html,
    });
  }

  async sendSignInNotification(
    to: string,
    displayName: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ) {
    const html = signInTemplate({
      displayName,
      ipAddress: meta?.ipAddress,
      userAgent: meta?.userAgent,
      timestamp: new Date().toLocaleString('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
      dashboardUrl: `${this.appUrl}/dashboard`,
    });

    return this.send({
      to,
      subject: 'New sign-in to your basefyio account',
      html,
    });
  }

  async sendTeamInvite(
    to: string,
    invitedDisplay: string,
    inviterDisplay: string,
    teamName: string,
    isNewUser = false,
  ) {
    const acceptUrl = isNewUser
      ? `${this.appUrl}/signup?email=${encodeURIComponent(to)}`
      : `${this.appUrl}/dashboard/team`;

    const html = inviteTemplate({
      invitedUsername: invitedDisplay,
      inviterUsername: inviterDisplay,
      teamName,
      acceptUrl,
      dashboardUrl: `${this.appUrl}/dashboard/team`,
      isNewUser,
    });

    return this.send({
      to,
      subject: `${inviterDisplay} invited you to join ${teamName} on basefyio`,
      html,
    });
  }

  async sendFeedbackNotification(
    to: string,
    data: {
      displayName: string;
      email: string;
      url: string;
      title: string;
      description?: string;
      type: string;
      createdAt: string;
      attachments?: { url: string; mimeType: string; kind: string }[];
    },
  ) {
    const html = feedbackTemplate(data);
    return this.send({
      to,
      subject: `[Feedback] ${data.title} — by ${data.displayName}`,
      html,
    });
  }

  async sendPasswordResetLink(
    to: string,
    displayName: string,
    resetToken: string,
    expiresInMinutes: number,
  ) {
    const resetUrl = `${this.appUrl}/reset-password?token=${resetToken}`;
    const html = forgotPasswordTemplate({
      displayName,
      resetUrl,
      expiresInMinutes,
    });

    return this.send({
      to,
      subject: 'Reset your basefyio password',
      html,
    });
  }

  async sendImportedUserCredentials(
    to: string,
    username: string,
    tempPassword: string,
    projectName: string,
    resetToken?: string,
  ) {
    const setPasswordUrl = resetToken
      ? `${this.appUrl}/reset-password?token=${resetToken}`
      : `${this.appUrl}/forgot-password`;

    const html = passwordResetTemplate({
      username,
      tempPassword,
      projectName,
      loginUrl: `${this.appUrl}/login`,
      setPasswordUrl,
    });

    return this.send({
      to,
      subject: `Your ${projectName} account has been migrated to basefyio`,
      html,
    });
  }

  async sendProjectVerifyEmail(
    to: string,
    projectName: string,
    otp: string,
    verifyUrl: string,
  ) {
    const html = projectVerifyEmailTemplate({
      email: to,
      projectName,
      otp,
      verifyUrl,
    });

    return this.send({
      to,
      subject: `[${projectName}] Verify your email`,
      html,
    });
  }

  async sendProjectResetPassword(
    to: string,
    projectName: string,
    otp: string,
  ) {
    const html = projectResetPasswordTemplate({
      email: to,
      projectName,
      otp,
    });

    return this.send({
      to,
      subject: `[${projectName}] Reset your password`,
      html,
    });
  }

  /** Warns the owner that a quiet project is about to be put to sleep. */
  async sendProjectSleepWarning(
    to: string,
    projectName: string,
    projectId: string,
    idleDays: number,
    daysLeft: number,
  ) {
    const dashboardUrl = `${this.appUrl}/dashboard/projects/${projectId}`;
    const html = projectSleepWarningTemplate({ projectName, idleDays, daysLeft, dashboardUrl });
    return this.send({
      to,
      subject: `${projectName} goes to sleep in ${daysLeft} day${daysLeft === 1 ? '' : 's'}`,
      html,
    });
  }

  /** Tells the owner a quiet project has been put to sleep, and how to wake it. */
  async sendProjectAsleep(to: string, projectName: string, projectId: string, idleDays: number) {
    const dashboardUrl = `${this.appUrl}/dashboard/projects/${projectId}`;
    const html = projectAsleepTemplate({ projectName, idleDays, dashboardUrl });
    return this.send({ to, subject: `${projectName} is asleep — wake it any time`, html });
  }

  async sendProjectWelcome(to: string, projectName: string) {
    const html = projectWelcomeTemplate({ email: to, projectName });
    return this.send({ to, subject: `Welcome to ${projectName}!`, html });
  }

  async sendProjectInviteUser(to: string, projectName: string, inviteUrl: string) {
    const html = projectInviteUserTemplate({ email: to, projectName, inviteUrl });
    return this.send({ to, subject: `You've been invited to ${projectName}`, html });
  }

  async sendProjectMagicLink(to: string, projectName: string, magicLinkUrl: string, otp: string) {
    const html = projectMagicLinkTemplate({ email: to, projectName, magicLinkUrl, otp });
    return this.send({ to, subject: `Sign in to ${projectName}`, html });
  }

  async sendProjectChangeEmail(to: string, newEmail: string, projectName: string, otp: string, confirmUrl: string) {
    const html = projectChangeEmailTemplate({ email: to, newEmail, projectName, otp, confirmUrl });
    return this.send({ to, subject: `[${projectName}] Confirm your new email`, html });
  }

  async sendProjectReauth(to: string, projectName: string, otp: string) {
    const html = projectReauthTemplate({ email: to, projectName, otp });
    return this.send({ to, subject: `[${projectName}] Confirm your identity`, html });
  }

  async sendRawHtml(to: string, subject: string, html: string) {
    return this.send({ to, subject, html });
  }

  private async send(params: { to: string; subject: string; html: string }) {
    if (!this.resend) {
      this.logger.warn(`[EMAIL] Skipped (no API key): "${params.subject}" → ${params.to}`);
      return null;
    }

    try {
      this.logger.debug(`[EMAIL] Attempting to send: "${params.subject}" → ${params.to} from ${this.fromEmail}`);

      const result = await this.resend.emails.send({
        from: this.fromEmail,
        to: params.to,
        replyTo: this.replyTo,
        subject: params.subject,
        html: params.html,
      });

      // The Resend SDK resolves (does NOT throw) on API errors — it returns
      // { data: null, error }. Without this check a rejected send (e.g. an
      // unverified "from" domain) was logged as a success with "ID: unknown",
      // hiding a fully-broken email pipeline. Treat result.error as a failure.
      if (result.error) {
        this.logger.error(
          `[EMAIL] ✗ Rejected by the mail provider: "${params.subject}" → ${params.to}\n` +
            `From: ${this.fromEmail}\n` +
            `Error: ${result.error.name || ''} — ${result.error.message || JSON.stringify(result.error)}`,
        );
        this.markFailing(
          `${result.error.name || ''} — ${result.error.message || 'rejected'}`,
          'send',
          String(result.error.name ?? ''),
        );
        return null;
      }

      if (this.deliverability.state !== 'ok') {
        this.failure = undefined;
        this.deliverability = { state: 'ok', checkedAt: new Date().toISOString() };
        this.logger.log('[EMAIL] Delivery recovered');
      }
      this.metrics?.increment('email_sent');
      this.logger.log(`[EMAIL] ✓ Sent successfully: "${params.subject}" → ${params.to} (ID: ${result.data?.id || 'unknown'})`);
      return result;
    } catch (error: any) {
      this.logger.error(
        `[EMAIL] ✗ Failed to send: "${params.subject}" → ${params.to}\n` +
        `Error: ${error.message}\n` +
        `From: ${this.fromEmail}\n` +
        `Status: ${error.statusCode || 'unknown'}`,
        error.stack
      );
      this.metrics?.increment('email_send_failed');
      return null;
    }
  }
}
