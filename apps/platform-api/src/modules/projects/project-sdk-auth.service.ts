import {
  Injectable,
  Logger,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  UnauthorizedException,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { randomInt } from 'crypto';
import * as nodemailer from 'nodemailer';
import { PrismaService } from '../../prisma/prisma.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { EmailService } from '../email/email.service';
import { RedisService } from '../redis/redis.service';
import { ProjectAuthConfigService } from './project-auth-config.service';

type EmailType = 'verify' | 'reset' | 'welcome' | 'invite' | 'magic_link' | 'change_email' | 'reauth';

const SUBJECT_FIELDS: Record<EmailType, string> = {
  verify: 'verifyEmailSubject',
  reset: 'resetPasswordSubject',
  welcome: 'welcomeSubject',
  invite: 'inviteUserSubject',
  magic_link: 'magicLinkSubject',
  change_email: 'changeEmailSubject',
  reauth: 'reauthSubject',
};

const BODY_FIELDS: Record<EmailType, string> = {
  verify: 'verifyEmailBody',
  reset: 'resetPasswordBody',
  welcome: 'welcomeBody',
  invite: 'inviteUserBody',
  magic_link: 'magicLinkBody',
  change_email: 'changeEmailBody',
  reauth: 'reauthBody',
};

const DEFAULT_SUBJECTS: Record<EmailType, string> = {
  verify: '[{{project_name}}] Verify your email',
  reset: '[{{project_name}}] Reset your password',
  welcome: 'Welcome to {{project_name}}!',
  invite: "You've been invited to {{project_name}}",
  magic_link: 'Sign in to {{project_name}}',
  change_email: '[{{project_name}}] Confirm your new email',
  reauth: '[{{project_name}}] Confirm your identity',
};

@Injectable()
export class ProjectSdkAuthService {
  private readonly logger = new Logger(ProjectSdkAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keycloak: KeycloakAdminService,
    private readonly email: EmailService,
    private readonly redis: RedisService,
    private readonly http: HttpService,
    private readonly config: ConfigService,
    private readonly authConfig: ProjectAuthConfigService,
  ) {}

  private getRealmAnonClientId(realmName: string): string {
    return `${realmName}-anon`;
  }

  /** Returns the public-facing API base URL including the /api prefix. */
  private getPublicApiBase(): string {
    const raw = this.config.get<string>('publicApiUrl') || 'http://localhost:4000';
    const base = raw.replace(/\/+$/, '');
    return base.endsWith('/api') ? base : `${base}/api`;
  }

  /* ───────── Sign Up ───────── */
  async signup(
    projectId: string,
    data: { email: string; password: string; firstName?: string; lastName?: string },
  ) {
    const project = await this.getProject(projectId);
    const cfg = await this.authConfig.getOrCreate(projectId);

    if (!cfg.allowSignup) {
      throw new ForbiddenException('Self-signup is disabled for this project');
    }

    const existing = await this.keycloak.findUserInRealm(project.keycloakRealm, data.email);
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    if (data.password.length < cfg.minPasswordLength) {
      throw new BadRequestException(`Password must be at least ${cfg.minPasswordLength} characters`);
    }

    let userId: string;
    try {
      userId = await this.keycloak.createProjectUser(project.keycloakRealm, data);
    } catch (err: any) {
      throw new InternalServerErrorException(`Failed to create user: ${err.message}`);
    }

    if (cfg.requireEmailVerify) {
      const otp = this.generateOtp();
      const tokenData = JSON.stringify({ userId, realmName: project.keycloakRealm, projectId });
      await this.redis.set(`verify_email:${projectId}:${otp}`, tokenData, 86400);

      const apiBase = this.getPublicApiBase();
      const verifyUrl = `${apiBase}/rest/v1/auth/verify-email-callback?otp=${otp}&apikey=${project.anonKey}`;

      this.sendEmail(projectId, data.email, project.name, 'verify', {
        otp, verify_url: verifyUrl,
      }).catch((err) => this.logger.warn(`Verification email failed: ${err.message}`));
    } else {
      await this.keycloak.setEmailVerified(project.keycloakRealm, userId);
    }

    const kcClientId = this.getRealmAnonClientId(project.keycloakRealm);
    const tokens = await this.authenticateInRealm(
      project.keycloakRealm, kcClientId, data.email, data.password,
    );

    return { ...tokens, userId, emailVerified: !cfg.requireEmailVerify };
  }

  /* ───────── Sign In ───────── */
  async signin(projectId: string, email: string, password: string) {
    const project = await this.getProject(projectId);
    const kcClientId = this.getRealmAnonClientId(project.keycloakRealm);
    const tokens = await this.authenticateInRealm(
      project.keycloakRealm, kcClientId, email, password,
    );
    const user = await this.keycloak.findUserInRealm(project.keycloakRealm, email);
    return { ...tokens, userId: user?.id, emailVerified: user?.emailVerified ?? false };
  }

  /* ───────── Verify Email ───────── */
  async verifyEmail(projectId: string, otp: string) {
    const key = `verify_email:${projectId}:${otp}`;
    const raw = await this.redis.get(key);
    if (!raw) throw new BadRequestException('Invalid or expired verification code');

    const { userId, realmName } = JSON.parse(raw);
    await this.keycloak.setEmailVerified(realmName, userId);
    await this.redis.del(key);

    const project = await this.getProject(projectId);
    const user = await this.keycloak.getRealmUserById(realmName, userId);
    if (user?.email) {
      this.sendEmail(projectId, user.email, project.name, 'welcome', {})
        .catch((err) => this.logger.warn(`Welcome email failed: ${err.message}`));
    }

    return { message: 'Email verified successfully' };
  }

  /* ───────── Forgot Password ───────── */
  async forgotPassword(projectId: string, email: string) {
    const project = await this.getProject(projectId);
    const user = await this.keycloak.findUserInRealm(project.keycloakRealm, email);
    if (!user) return { message: 'If an account exists, a reset code has been sent' };

    const otp = this.generateOtp();
    const tokenData = JSON.stringify({ userId: user.id, realmName: project.keycloakRealm, projectId });
    await this.redis.set(`reset_password:${projectId}:${otp}`, tokenData, 3600);

    this.sendEmail(projectId, email, project.name, 'reset', { otp })
      .catch((err) => this.logger.warn(`Reset email failed: ${err.message}`));

    return { message: 'If an account exists, a reset code has been sent' };
  }

  /* ───────── Reset Password ───────── */
  async resetPassword(projectId: string, otp: string, newPassword: string) {
    const cfg = await this.authConfig.getOrCreate(projectId);
    if (newPassword.length < cfg.minPasswordLength) {
      throw new BadRequestException(`Password must be at least ${cfg.minPasswordLength} characters`);
    }

    const key = `reset_password:${projectId}:${otp}`;
    const raw = await this.redis.get(key);
    if (!raw) throw new BadRequestException('Invalid or expired reset code');

    const { userId, realmName } = JSON.parse(raw);
    await this.keycloak.resetRealmUserPassword(realmName, userId, newPassword);
    await this.redis.del(key);

    return { message: 'Password reset successfully' };
  }

  /* ───────── Magic Link ───────── */
  async sendMagicLink(projectId: string, email: string) {
    const project = await this.getProject(projectId);
    const user = await this.keycloak.findUserInRealm(project.keycloakRealm, email);
    if (!user) return { message: 'If an account exists, a magic link has been sent' };

    const otp = this.generateOtp();
    const tokenData = JSON.stringify({ userId: user.id, email, realmName: project.keycloakRealm, projectId });
    await this.redis.set(`magic_link:${projectId}:${otp}`, tokenData, 600);

    const apiBase = this.getPublicApiBase();
    const magicLinkUrl = `${apiBase}/rest/v1/auth/magic-link-callback?otp=${otp}&apikey=${project.anonKey}`;

    this.sendEmail(projectId, email, project.name, 'magic_link', {
      otp, magic_link_url: magicLinkUrl,
    }).catch((err) => this.logger.warn(`Magic link email failed: ${err.message}`));

    return { message: 'If an account exists, a magic link has been sent' };
  }

  async verifyMagicLink(projectId: string, otp: string) {
    const key = `magic_link:${projectId}:${otp}`;
    const raw = await this.redis.get(key);
    if (!raw) throw new BadRequestException('Invalid or expired magic link');

    const { userId, realmName } = JSON.parse(raw);
    await this.redis.del(key);

    const user = await this.keycloak.getRealmUserById(realmName, userId);
    if (!user) throw new NotFoundException('User not found');

    if (!user.emailVerified) {
      await this.keycloak.setEmailVerified(realmName, userId);
    }

    return { message: 'Magic link verified', userId, email: user.email, emailVerified: true };
  }

  /* ───────── Change Email ───────── */
  async requestChangeEmail(projectId: string, accessToken: string, newEmail: string) {
    const project = await this.getProject(projectId);
    const currentUser = await this.getUserFromToken(project, accessToken);

    const existingNew = await this.keycloak.findUserInRealm(project.keycloakRealm, newEmail);
    if (existingNew) throw new ConflictException('Email already in use');

    const otp = this.generateOtp();
    const tokenData = JSON.stringify({
      userId: currentUser.id, realmName: project.keycloakRealm, projectId, newEmail,
    });
    await this.redis.set(`change_email:${projectId}:${otp}`, tokenData, 3600);

    const apiBase = this.getPublicApiBase();
    const confirmUrl = `${apiBase}/rest/v1/auth/change-email-callback?otp=${otp}&apikey=${project.anonKey}`;

    this.sendEmail(projectId, newEmail, project.name, 'change_email', {
      otp, confirm_url: confirmUrl, new_email: newEmail, email: currentUser.email,
    }).catch((err) => this.logger.warn(`Change email failed: ${err.message}`));

    return { message: 'Confirmation code sent to new email' };
  }

  async confirmChangeEmail(projectId: string, otp: string) {
    const key = `change_email:${projectId}:${otp}`;
    const raw = await this.redis.get(key);
    if (!raw) throw new BadRequestException('Invalid or expired confirmation code');

    const { userId, realmName, newEmail } = JSON.parse(raw);
    await this.keycloak.updateRealmUserEmail(realmName, userId, newEmail);
    await this.redis.del(key);

    return { message: 'Email changed successfully', newEmail };
  }

  /* ───────── Reauthentication ───────── */
  async requestReauth(projectId: string, accessToken: string) {
    const project = await this.getProject(projectId);
    const currentUser = await this.getUserFromToken(project, accessToken);

    const otp = this.generateOtp();
    const tokenData = JSON.stringify({ userId: currentUser.id, realmName: project.keycloakRealm, projectId });
    await this.redis.set(`reauth:${projectId}:${otp}`, tokenData, 600);

    this.sendEmail(projectId, currentUser.email, project.name, 'reauth', { otp })
      .catch((err) => this.logger.warn(`Reauth email failed: ${err.message}`));

    return { message: 'Reauthentication code sent' };
  }

  async verifyReauth(projectId: string, otp: string) {
    const key = `reauth:${projectId}:${otp}`;
    const raw = await this.redis.get(key);
    if (!raw) throw new BadRequestException('Invalid or expired reauthentication code');

    const { userId } = JSON.parse(raw);
    await this.redis.del(key);

    return { message: 'Reauthentication successful', userId, verified: true };
  }

  /* ───────── Invite User ───────── */
  async inviteUser(projectId: string, email: string) {
    const project = await this.getProject(projectId);
    const existing = await this.keycloak.findUserInRealm(project.keycloakRealm, email);
    if (existing) throw new ConflictException('User already exists in this project');

    const otp = this.generateOtp();
    const tokenData = JSON.stringify({ email, realmName: project.keycloakRealm, projectId });
    await this.redis.set(`invite_user:${projectId}:${otp}`, tokenData, 86400 * 7);

    const apiBase = this.getPublicApiBase();
    const inviteUrl = `${apiBase}/rest/v1/auth/invite-callback?otp=${otp}&apikey=${project.anonKey}`;

    this.sendEmail(projectId, email, project.name, 'invite', { invite_url: inviteUrl })
      .catch((err) => this.logger.warn(`Invite email failed: ${err.message}`));

    return { message: `Invitation sent to ${email}` };
  }

  /* ───────── OAuth Provider Sign In ───────── */
  async getOAuthRedirectUrl(projectId: string, provider: string, redirectTo?: string) {
    const project = await this.getProject(projectId);
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const apiBase = this.getPublicApiBase();
    const callbackUrl = `${apiBase}/rest/v1/auth/callback/${projectId}/${provider}`;
    const kcClientId = this.getRealmAnonClientId(project.keycloakRealm);

    const stateData = JSON.stringify({
      redirectTo: redirectTo || '/',
    });
    const state = Buffer.from(stateData).toString('base64url');

    const authUrl = `${keycloakUrl}/realms/${project.keycloakRealm}/protocol/openid-connect/auth`;
    const params = new URLSearchParams({
      client_id: kcClientId,
      response_type: 'code',
      scope: 'openid email profile',
      redirect_uri: callbackUrl,
      state,
      kc_idp_hint: provider,
    });

    return { url: `${authUrl}?${params.toString()}`, provider };
  }

  async handleOAuthCallback(projectId: string, provider: string, code: string, state: string) {
    const project = await this.getProject(projectId);
    const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    const { redirectTo } = stateData;

    const keycloakUrl = this.config.get<string>('keycloak.url');
    const apiBase = this.getPublicApiBase();
    const callbackUrl = `${apiBase}/rest/v1/auth/callback/${projectId}/${provider}`;
    const tokenUrl = `${keycloakUrl}/realms/${project.keycloakRealm}/protocol/openid-connect/token`;
    const kcClientId = this.getRealmAnonClientId(project.keycloakRealm);

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: kcClientId,
      code,
      redirect_uri: callbackUrl,
    });

    try {
      const { data } = await firstValueFrom(
        this.http.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        tokenType: data.token_type,
        redirectTo,
      };
    } catch (err: any) {
      this.logger.error(`OAuth callback failed: ${err.message}`);
      throw new InternalServerErrorException('OAuth authentication failed');
    }
  }

  /* ───────── Refresh & Me ───────── */
  async refresh(projectId: string, refreshToken: string) {
    const project = await this.getProject(projectId);
    const kcClientId = this.getRealmAnonClientId(project.keycloakRealm);
    return this.refreshInRealm(project.keycloakRealm, kcClientId, refreshToken);
  }

  async me(projectId: string, accessToken: string) {
    const project = await this.getProject(projectId);
    return this.getUserFromToken(project, accessToken);
  }

  /* ═══════════════════ Private Helpers ═══════════════════ */

  private async getUserFromToken(
    project: { keycloakRealm: string },
    accessToken: string,
  ) {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const userinfoUrl = `${keycloakUrl}/realms/${project.keycloakRealm}/protocol/openid-connect/userinfo`;

    try {
      const { data } = await firstValueFrom(
        this.http.get(userinfoUrl, { headers: { Authorization: `Bearer ${accessToken}` } }),
      );
      return {
        id: data.sub,
        email: data.email,
        emailVerified: data.email_verified,
        username: data.preferred_username,
        firstName: data.given_name,
        lastName: data.family_name,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  private async authenticateInRealm(
    realmName: string,
    clientId: string,
    email: string,
    password: string,
    retried = false,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; tokenType: string }> {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const tokenUrl = `${keycloakUrl}/realms/${realmName}/protocol/openid-connect/token`;

    const params = new URLSearchParams({
      grant_type: 'password', client_id: clientId, username: email, password,
      scope: 'openid email profile',
    });

    try {
      const { data } = await firstValueFrom(
        this.http.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        tokenType: data.token_type,
      };
    } catch (err: any) {
      const kcError: string = err?.response?.data?.error ?? '';
      const kcDesc: string = err?.response?.data?.error_description ?? '';

      // Legacy realm whose anon client lacks direct access grants — enable it
      // once and retry, so SDK email/password signin self-heals instead of
      // failing forever.
      if (
        !retried &&
        (kcError === 'unauthorized_client' || /direct access grants/i.test(kcDesc))
      ) {
        const fixed = await this.keycloak.ensureRealmClientDirectGrant(realmName, clientId);
        if (fixed) {
          return this.authenticateInRealm(realmName, clientId, email, password, true);
        }
        throw new UnauthorizedException(
          'Auth is misconfigured for this project (direct access grants). Please retry shortly.',
        );
      }

      // The grant sends the email in the username field. Keycloak's password
      // grant resolves the literal username, so a user whose KC username drifted
      // from their email (e.g. an email change) fails here even with the right
      // password. Resolve the real username by email and retry once.
      if (kcError === 'invalid_grant' && !retried) {
        const user = (await this.keycloak
          .findUserInRealm(realmName, email)
          .catch(() => null)) as
          | {
              id?: string;
              username?: string;
              emailVerified?: boolean;
              requiredActions?: string[];
              firstName?: string;
              lastName?: string;
            }
          | null;
        if (user?.id) {
          // A fully-set-up account can still fail the grant ("Account is not fully
          // set up") when realm-default required actions, an unverified email, or
          // — on Keycloak 24 — missing firstName/lastName (User Profile) got left
          // at creation. Heal those and retry with the SAME password (a wrong
          // password still 401s).
          const blocked =
            user.emailVerified === false ||
            (user.requiredActions?.length ?? 0) > 0 ||
            !user.firstName?.trim() ||
            !user.lastName?.trim();
          if (blocked) {
            await this.keycloak
              .clearRealmUserLoginBlockers(realmName, user.id)
              .catch(() => {});
          }
          // Also handle a username that drifted from the email.
          const realUsername =
            user.username && user.username.toLowerCase() !== email.toLowerCase()
              ? user.username
              : email;
          if (blocked || realUsername !== email) {
            try {
              const retry = await firstValueFrom(
                this.http.post(
                  tokenUrl,
                  new URLSearchParams({
                    grant_type: 'password', client_id: clientId, username: realUsername, password,
                    scope: 'openid email profile',
                  }).toString(),
                  { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
                ),
              );
              const d = retry.data;
              return {
                accessToken: d.access_token,
                refreshToken: d.refresh_token,
                expiresIn: d.expires_in,
                tokenType: d.token_type,
              };
            } catch {
              /* fall through to invalid-credentials below */
            }
          }
        }
      }

      // Genuine bad email/password — the common case. Anything else surfaces
      // its real reason instead of a blanket "Invalid credentials".
      if (kcError === 'invalid_grant') {
        throw new UnauthorizedException('Invalid email or password');
      }
      throw new UnauthorizedException(kcDesc || 'Authentication failed');
    }
  }

  private async refreshInRealm(realmName: string, clientId: string, refreshToken: string) {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const tokenUrl = `${keycloakUrl}/realms/${realmName}/protocol/openid-connect/token`;

    const params = new URLSearchParams({
      grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken,
    });

    try {
      const { data } = await firstValueFrom(
        this.http.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  private async getProject(projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: 'ACTIVE' },
      select: { id: true, name: true, keycloakRealm: true, anonKey: true },
    });
    if (!project) throw new NotFoundException('Project not found');
    return project;
  }

  /* ───────── Unified Email Sender ───────── */
  private async sendEmail(
    projectId: string,
    to: string,
    projectName: string,
    type: EmailType,
    extraVars: Record<string, string>,
  ): Promise<void> {
    const rawCfg = await this.authConfig.getRaw(projectId);

    const customSubject = (rawCfg as any)[SUBJECT_FIELDS[type]] as string | null;
    const customBody = (rawCfg as any)[BODY_FIELDS[type]] as string | null;

    const vars: Record<string, string> = {
      '{{otp}}': extraVars.otp || '',
      '{{project_name}}': projectName,
      '{{verify_url}}': extraVars.verify_url || '',
      '{{email}}': to,
      '{{invite_url}}': extraVars.invite_url || '',
      '{{magic_link_url}}': extraVars.magic_link_url || '',
      '{{confirm_url}}': extraVars.confirm_url || '',
      '{{new_email}}': extraVars.new_email || '',
    };

    const resolvedSubject = this.applyVars(customSubject || DEFAULT_SUBJECTS[type], vars);
    const resolvedBody = customBody ? this.applyVars(customBody, vars) : null;

    const smtpOpts = this.resolveSmtpConfig(rawCfg);

    if (smtpOpts) {
      await this.sendViaSmtp(rawCfg, smtpOpts, to, projectName, resolvedSubject, resolvedBody, type, extraVars);
      return;
    }

    if (resolvedBody) {
      await this.email.sendRawHtml(to, resolvedSubject, resolvedBody);
      return;
    }

    await this.sendDefaultEmail(to, projectName, type, extraVars);
  }

  private resolveSmtpConfig(rawCfg: any): { host: string; port: number; user: string; pass: string } | null {
    const provider = rawCfg.emailProvider as string | null;

    if (provider === 'resend' && rawCfg.resendApiKey) {
      return { host: 'smtp.resend.com', port: 465, user: 'resend', pass: rawCfg.resendApiKey };
    }
    if (provider === 'sendgrid' && rawCfg.sendgridApiKey) {
      return { host: 'smtp.sendgrid.net', port: 465, user: 'apikey', pass: rawCfg.sendgridApiKey };
    }
    if (provider === 'ses' && rawCfg.sesAccessKey && rawCfg.sesSecretKey) {
      const region = rawCfg.sesRegion || 'us-east-1';
      return { host: `email-smtp.${region}.amazonaws.com`, port: 465, user: rawCfg.sesAccessKey, pass: rawCfg.sesSecretKey };
    }
    if ((provider === 'smtp' || !provider) && rawCfg.smtpHost) {
      return { host: rawCfg.smtpHost, port: rawCfg.smtpPort || 587, user: rawCfg.smtpUser, pass: rawCfg.smtpPass };
    }
    return null;
  }

  private async sendViaSmtp(
    rawCfg: any, smtp: { host: string; port: number; user: string; pass: string },
    to: string, projectName: string,
    subject: string, htmlBody: string | null, type: EmailType, vars: Record<string, string>,
  ) {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.pass ? { user: smtp.user, pass: smtp.pass } : undefined,
    } as nodemailer.TransportOptions);

    const from = rawCfg.senderEmail
      ? `${rawCfg.senderName || projectName} <${rawCfg.senderEmail}>`
      : `${projectName} <noreply@basefyio.com>`;

    await transporter.sendMail({
      from, to, subject,
      ...(htmlBody ? { html: htmlBody } : { text: `Code: ${vars.otp || 'N/A'}` }),
    });
  }

  private async sendDefaultEmail(to: string, projectName: string, type: EmailType, vars: Record<string, string>) {
    switch (type) {
      case 'verify':
        return this.email.sendProjectVerifyEmail(to, projectName, vars.otp, vars.verify_url);
      case 'reset':
        return this.email.sendProjectResetPassword(to, projectName, vars.otp);
      case 'welcome':
        return this.email.sendProjectWelcome(to, projectName);
      case 'invite':
        return this.email.sendProjectInviteUser(to, projectName, vars.invite_url);
      case 'magic_link':
        return this.email.sendProjectMagicLink(to, projectName, vars.magic_link_url, vars.otp);
      case 'change_email':
        return this.email.sendProjectChangeEmail(to, vars.new_email, projectName, vars.otp, vars.confirm_url);
      case 'reauth':
        return this.email.sendProjectReauth(to, projectName, vars.otp);
    }
  }

  private applyVars(template: string, vars: Record<string, string>): string {
    return Object.entries(vars).reduce((s, [k, v]) => s.replaceAll(k, v), template);
  }

  private generateOtp(): string {
    return String(randomInt(100000, 999999));
  }
}
