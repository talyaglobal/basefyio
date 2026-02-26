import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { welcomeTemplate } from './templates/welcome.template';
import { signInTemplate } from './templates/signin.template';
import { inviteTemplate } from './templates/invite.template';
import { feedbackTemplate } from './templates/feedback.template';
import { passwordResetTemplate } from './templates/password-reset.template';

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

  async sendWelcome(to: string, username: string) {
    const html = welcomeTemplate({
      username,
      email: to,
      loginUrl: `${this.appUrl}/login`,
      dashboardUrl: `${this.appUrl}/dashboard`,
    });

    return this.send({
      to,
      subject: `Welcome to Kolaybase, ${username}! 🚀`,
      html,
    });
  }

  async sendSignInNotification(
    to: string,
    username: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ) {
    const html = signInTemplate({
      username,
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
    invitedUsername: string,
    inviterUsername: string,
    teamName: string,
  ) {
    const html = inviteTemplate({
      invitedUsername,
      inviterUsername,
      teamName,
      acceptUrl: `${this.appUrl}/dashboard/team`,
      dashboardUrl: `${this.appUrl}/dashboard/team`,
    });

    return this.send({
      to,
      subject: `${inviterUsername} invited you to join ${teamName} on Kolaybase`,
      html,
    });
  }

  async sendFeedbackNotification(
    to: string,
    data: {
      username: string;
      email: string;
      url: string;
      title: string;
      description?: string;
      type: string;
      createdAt: string;
    },
  ) {
    const html = feedbackTemplate(data);
    return this.send({
      to,
      subject: `[Feedback] ${data.title} — by ${data.username}`,
      html,
    });
  }

  async sendImportedUserCredentials(
    to: string,
    username: string,
    tempPassword: string,
    projectName: string,
  ) {
    const html = passwordResetTemplate({
      username,
      tempPassword,
      projectName,
      loginUrl: `${this.appUrl}/login`,
    });

    return this.send({
      to,
      subject: `Your ${projectName} account has been migrated to Kolaybase`,
      html,
    });
  }

  private async send(params: { to: string; subject: string; html: string }) {
    if (!this.resend) {
      this.logger.warn(`Email skipped (no API key): "${params.subject}" → ${params.to}`);
      return null;
    }

    try {
      const result = await this.resend.emails.send({
        from: this.fromEmail,
        to: params.to,
        replyTo: this.replyTo,
        subject: params.subject,
        html: params.html,
      });

      this.logger.log(`Email sent: "${params.subject}" → ${params.to}`);
      return result;
    } catch (error: any) {
      this.logger.error(`Failed to send email: ${error.message}`, error.stack);
      return null;
    }
  }
}
