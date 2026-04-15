import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { welcomeTemplate } from './templates/welcome.template';
import { signInTemplate } from './templates/signin.template';
import { inviteTemplate } from './templates/invite.template';
import { feedbackTemplate } from './templates/feedback.template';
import { passwordResetTemplate } from './templates/password-reset.template';
import { forgotPasswordTemplate } from './templates/forgot-password.template';
import { projectVerifyEmailTemplate } from './templates/project-verify-email.template';
import { projectResetPasswordTemplate } from './templates/project-reset-password.template';
import { projectWelcomeTemplate } from './templates/project-welcome.template';
import { projectInviteUserTemplate } from './templates/project-invite-user.template';
import { projectMagicLinkTemplate } from './templates/project-magic-link.template';
import { projectChangeEmailTemplate } from './templates/project-change-email.template';
import { projectReauthTemplate } from './templates/project-reauth.template';
import { signupVerifyEmailTemplate } from './templates/signup-verify-email.template';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private resend: Resend | null = null;
  private readonly fromEmail: string;
  private readonly replyTo: string;
  private readonly appUrl: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>('resend.apiKey');
    if (apiKey) {
      this.resend = new Resend(apiKey);
    } else {
      this.logger.warn('RESEND_API_KEY is not set — emails will not be sent');
    }
    this.fromEmail = this.config.get<string>('resend.fromEmail')!;
    this.replyTo = this.config.get<string>('resend.replyTo')!;
    this.appUrl = this.config.get<string>('appUrl')!;
  }

  async sendSignupVerifyEmail(to: string, otp: string, firstName?: string) {
    const html = signupVerifyEmailTemplate({ email: to, otp, firstName });
    return this.send({ to, subject: 'Verify your email to join Kolaybase', html });
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
      subject: `Welcome to Kolaybase, ${displayName}! 🚀`,
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
      subject: 'New sign-in to your Kolaybase account',
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
      subject: `${inviterDisplay} invited you to join ${teamName} on Kolaybase`,
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
  ) {
    const resetUrl = `${this.appUrl}/reset-password?token=${resetToken}`;
    const html = forgotPasswordTemplate({
      displayName,
      resetUrl,
      expiresInMinutes: 60,
    });

    return this.send({
      to,
      subject: 'Reset your Kolaybase password',
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
      subject: `Your ${projectName} account has been migrated to Kolaybase`,
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
      return null;
    }
  }
}
