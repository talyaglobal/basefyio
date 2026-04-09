import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { randomBytes } from 'crypto';
import * as Minio from 'minio';
import { PassThrough } from 'stream';
import { KeycloakAdminService } from './keycloak-admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { BillingService } from '../billing/billing.service';

type RolePermissionKey =
  | 'canAccessManagement'
  | 'canManageUsers'
  | 'canManageTeams'
  | 'canManagePlans'
  | 'canManageUserPackages'
  | 'canModerateFeedback'
  | 'canViewAuditLogs'
  | 'canViewRootAlerts';

type RolePermissionMatrix = Record<RolePermissionKey, boolean>;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly minioClient: Minio.Client;
  private readonly minioPublicEndpoint: string;
  private readonly minioPublicPort: number;
  private readonly minioPublicSsl: boolean;
  private static readonly AVATAR_BUCKET = 'kb-platform-avatars';
  private static readonly MAX_FAILED_ATTEMPTS = 10;
  private static readonly CAPTCHA_AFTER_CONSECUTIVE_FAILED = 4;
  private static readonly CAPTCHA_TTL_MS = 5 * 60 * 1000;
  private static readonly ACCOUNT_LOCK_MS = 30 * 60 * 1000;
  private static readonly PASSWORD_PUNCTUATION_REGEX = /[!-/:-@[-`{-~]/;
  private static readonly DEFAULT_ROLE_PERMISSIONS: Record<
    'USER' | 'ADMIN' | 'ROOT',
    RolePermissionMatrix
  > = {
    USER: {
      canAccessManagement: false,
      canManageUsers: false,
      canManageTeams: false,
      canManagePlans: false,
      canManageUserPackages: false,
      canModerateFeedback: false,
      canViewAuditLogs: false,
      canViewRootAlerts: false,
    },
    ADMIN: {
      canAccessManagement: true,
      canManageUsers: true,
      canManageTeams: true,
      canManagePlans: true,
      canManageUserPackages: true,
      canModerateFeedback: true,
      canViewAuditLogs: false,
      canViewRootAlerts: false,
    },
    ROOT: {
      canAccessManagement: true,
      canManageUsers: true,
      canManageTeams: true,
      canManagePlans: true,
      canManageUserPackages: true,
      canModerateFeedback: true,
      canViewAuditLogs: true,
      canViewRootAlerts: true,
    },
  };

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly keycloak: KeycloakAdminService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly billing: BillingService,
  ) {
    const accessKey = this.config.get<string>('minio.accessKey') || 'kolaybase';
    const secretKey = this.config.get<string>('minio.secretKey') || 'kolaybase_secret';
    this.minioClient = new Minio.Client({
      endPoint: this.config.get<string>('minio.endpoint') || 'localhost',
      port: this.config.get<number>('minio.port') || 9000,
      useSSL: this.config.get<boolean>('minio.useSsl') || false,
      accessKey,
      secretKey,
    });
    this.minioPublicEndpoint = this.config.get<string>('minio.publicEndpoint') || 'localhost';
    this.minioPublicPort = this.config.get<number>('minio.publicPort') || 9000;
    this.minioPublicSsl = this.config.get<string>('minio.publicSsl') === 'true';
  }

  private async ensureAvatarBucket(): Promise<void> {
    const exists = await this.minioClient.bucketExists(AuthService.AVATAR_BUCKET);
    if (!exists) {
      await this.minioClient.makeBucket(AuthService.AVATAR_BUCKET);
      const policy = JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: ['*'] },
            Action: ['s3:GetObject'],
            Resource: [`arn:aws:s3:::${AuthService.AVATAR_BUCKET}/*`],
          },
        ],
      });
      await this.minioClient.setBucketPolicy(AuthService.AVATAR_BUCKET, policy);
      this.logger.log(`Created public avatar bucket: ${AuthService.AVATAR_BUCKET}`);
    }
  }

  private generateUsername(firstName?: string, lastName?: string, email?: string): string {
    let base: string;
    if (firstName || lastName) {
      base = `${firstName || ''}${lastName || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    } else {
      base = (email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    }
    if (!base) base = 'user';
    const suffix = Math.random().toString(36).substring(2, 7);
    return `${base}${suffix}`;
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private decodeJwtSubject(token: string): string | null {
    try {
      const [, payload] = token.split('.');
      if (!payload) return null;
      const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return typeof json?.sub === 'string' ? json.sub : null;
    } catch {
      return null;
    }
  }

  private ensureStrongPassword(password: string): void {
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }
    if (!/[A-Z]/.test(password)) {
      throw new BadRequestException('Password must include at least one uppercase letter');
    }
    if (!/[a-z]/.test(password)) {
      throw new BadRequestException('Password must include at least one lowercase letter');
    }
    if (!/[0-9]/.test(password)) {
      throw new BadRequestException('Password must include at least one number');
    }
    if (!AuthService.PASSWORD_PUNCTUATION_REGEX.test(password)) {
      throw new BadRequestException('Password must include at least one punctuation character');
    }
  }

  private generateCaptcha(): { question: string; answer: string } {
    const a = Math.floor(Math.random() * 9) + 1;
    const b = Math.floor(Math.random() * 9) + 1;
    return {
      question: `${a} + ${b} = ?`,
      answer: String(a + b),
    };
  }

  private async registerFailedLogin(email: string): Promise<{
    failedAttempts: number;
    consecutiveFailed: number;
    locked: boolean;
  }> {
    const state = await this.prisma.loginSecurityState.findUnique({
      where: { email },
      select: { failedAttempts: true, consecutiveFailed: true },
    });
    const failedAttempts = (state?.failedAttempts ?? 0) + 1;
    const consecutiveFailed = (state?.consecutiveFailed ?? 0) + 1;
    const locked = failedAttempts >= AuthService.MAX_FAILED_ATTEMPTS;
    await this.prisma.loginSecurityState.update({
      where: { email },
      data: {
        failedAttempts,
        consecutiveFailed,
        lockedUntil: locked ? new Date(Date.now() + AuthService.ACCOUNT_LOCK_MS) : null,
      },
    });
    return { failedAttempts, consecutiveFailed, locked };
  }

  async getLoginCaptcha(email: string): Promise<{ required: boolean; question?: string; expiresInSeconds?: number }> {
    const normalizedEmail = this.normalizeEmail(email);
    if (!normalizedEmail) {
      throw new BadRequestException('Email is required');
    }

    const state = await this.prisma.loginSecurityState.upsert({
      where: { email: normalizedEmail },
      create: { email: normalizedEmail },
      update: {},
    });

    if (state.consecutiveFailed < AuthService.CAPTCHA_AFTER_CONSECUTIVE_FAILED) {
      return { required: false };
    }

    const captcha = this.generateCaptcha();
    const expiresAt = new Date(Date.now() + AuthService.CAPTCHA_TTL_MS);
    await this.prisma.loginSecurityState.update({
      where: { email: normalizedEmail },
      data: {
        captchaQuestion: captcha.question,
        captchaAnswer: captcha.answer,
        captchaExpiresAt: expiresAt,
      },
    });

    return {
      required: true,
      question: captcha.question,
      expiresInSeconds: Math.floor(AuthService.CAPTCHA_TTL_MS / 1000),
    };
  }

  async signup(data: {
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
    planName?: string;
  }) {
    this.ensureStrongPassword(data.password);
    const existingEmail = await this.keycloak.findPlatformUserByEmail(data.email);
    if (existingEmail) {
      throw new ConflictException('Email already registered');
    }

    const username = this.generateUsername(data.firstName, data.lastName, data.email);

    let keycloakId: string;
    try {
      keycloakId = await this.keycloak.createPlatformUser({ ...data, username });
    } catch (err: any) {
      throw new InternalServerErrorException(`Failed to create account: ${err.message}`);
    }

    const user = await this.prisma.user.create({
      data: {
        id: keycloakId,
        username,
        email: data.email,
        role: 'USER',
      },
    });

    const displayName = data.firstName || data.email.split('@')[0];
    const teamSlug = `personal-${username}-${keycloakId.slice(0, 8)}`;

    const team = await this.prisma.team.create({
      data: {
        name: `${displayName}'s Team`,
        slug: teamSlug,
        personalForUserId: user.id,
        members: { create: { userId: user.id, role: 'OWNER' } },
      },
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { activeTeamId: team.id },
    });

    const teamName = `${displayName}'s Team`;
    try {
      if (data.planName && data.planName !== 'free') {
        await this.billing.createSubscriptionWithPlan(team.id, data.planName, data.email, teamName);
      } else {
        await this.billing.createFreeSubscription(team.id, data.email, teamName);
      }
    } catch (err) {
      this.logger.error(`Failed to create subscription for team ${team.id}: ${err}`);
    }

    this.email.sendWelcome(data.email, displayName).catch(() => {});

    const linkedCount = await this.linkEmailInvitesToUser(data.email, user.id);

    const tokens = await this.login(data.email, data.password);
    const selectedPlan = data.planName || 'free';
    return { ...tokens, hasPendingInvites: linkedCount > 0, selectedPlan };
  }

  private async linkEmailInvitesToUser(email: string, userId: string): Promise<number> {
    const pending = await this.prisma.teamInvite.findMany({
      where: { invitedEmail: email.toLowerCase(), status: 'PENDING', invitedUserId: null },
    });
    if (pending.length === 0) return 0;

    await this.prisma.teamInvite.updateMany({
      where: { id: { in: pending.map((i) => i.id) } },
      data: { invitedUserId: userId },
    });
    return pending.length;
  }

  private parseOAuthName(
    givenName?: string,
    familyName?: string,
    fullName?: string,
  ): { firstName: string | null; lastName: string | null } {
    if (givenName || familyName) {
      return { firstName: givenName || null, lastName: familyName || null };
    }
    if (fullName) {
      const parts = fullName.trim().split(/\s+/);
      return {
        firstName: parts[0] || null,
        lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
      };
    }
    return { firstName: null, lastName: null };
  }

  async ensureUserProfile(
    sub: string,
    email: string,
    username: string,
    oauthName?: { givenName?: string; familyName?: string; name?: string },
  ) {
    const existing = await this.prisma.user.findUnique({ where: { id: sub } });

    if (existing) {
      // If the user exists but has no name yet, backfill from OAuth on each login
      if (oauthName && (!existing.firstName || !existing.lastName)) {
        const parsed = this.parseOAuthName(oauthName.givenName, oauthName.familyName, oauthName.name);
        if (parsed.firstName || parsed.lastName) {
          await this.prisma.user.update({
            where: { id: sub },
            data: {
              ...(parsed.firstName && !existing.firstName ? { firstName: parsed.firstName } : {}),
              ...(parsed.lastName && !existing.lastName ? { lastName: parsed.lastName } : {}),
            },
          });
        }
      }
      return existing;
    }

    try {
      const safeUsername = username || `user-${sub.slice(0, 8)}`;
      const safeEmail = email || `${sub.slice(0, 8)}@kolaybase.local`;
      const parsed = oauthName
        ? this.parseOAuthName(oauthName.givenName, oauthName.familyName, oauthName.name)
        : { firstName: null, lastName: null };

      const user = await this.prisma.user.create({
        data: {
          id: sub,
          username: safeUsername,
          email: safeEmail,
          role: 'USER',
          ...(parsed.firstName ? { firstName: parsed.firstName } : {}),
          ...(parsed.lastName ? { lastName: parsed.lastName } : {}),
        },
      });

      const slug = `personal-${safeUsername.toLowerCase().replace(/[^a-z0-9]/g, '')}-${sub.slice(0, 8)}`;

      const team = await this.prisma.team.create({
        data: {
          name: `${safeUsername}'s Team`,
          slug,
          personalForUserId: user.id,
          members: { create: { userId: user.id, role: 'OWNER' } },
        },
      });

      await this.prisma.user.update({
        where: { id: user.id },
        data: { activeTeamId: team.id },
      });

      try {
        await this.billing.createFreeSubscription(team.id, safeEmail, `${safeUsername}'s Team`);
      } catch (err) {
        this.logger.error(`Failed to create free subscription for team ${team.id}: ${err}`);
      }

      return user;
    } catch (err: any) {
      const fallback = await this.prisma.user.findUnique({ where: { id: sub } });
      if (fallback) return fallback;
      throw err;
    }
  }

  async login(
    email: string,
    password: string,
    meta?: { ipAddress?: string; userAgent?: string },
    captchaAnswer?: string,
  ) {
    const normalizedEmail = this.normalizeEmail(email);
    const existingUser = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });
    if (existingUser) {
      try {
        const isEnabled = await this.keycloak.getPlatformUserEnabledById(existingUser.id);
        if (!isEnabled) {
          throw new UnauthorizedException('ACCOUNT_INACTIVE');
        }
        const methods = await this.keycloak.getPlatformUserSignInMethodsById(existingUser.id);
        if (methods.signOnMethod !== 'local') {
          throw new UnauthorizedException(
            `SOCIAL_LOGIN_ONLY:${methods.signOnMethod.toUpperCase()}`,
          );
        }
      } catch (err) {
        if (err instanceof UnauthorizedException) {
          throw err;
        }
      }
    }
    const security = await this.prisma.loginSecurityState.upsert({
      where: { email: normalizedEmail },
      create: { email: normalizedEmail },
      update: {},
    });

    if (security.lockedUntil && security.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account is locked after too many failed attempts');
    }

    const needsCaptcha =
      security.consecutiveFailed >= AuthService.CAPTCHA_AFTER_CONSECUTIVE_FAILED;
    if (needsCaptcha) {
      const isExpired =
        !security.captchaExpiresAt || security.captchaExpiresAt.getTime() < Date.now();
      if (isExpired || !security.captchaQuestion || !security.captchaAnswer) {
        const captcha = this.generateCaptcha();
        await this.prisma.loginSecurityState.update({
          where: { email: normalizedEmail },
          data: {
            captchaQuestion: captcha.question,
            captchaAnswer: captcha.answer,
            captchaExpiresAt: new Date(Date.now() + AuthService.CAPTCHA_TTL_MS),
          },
        });
        throw new UnauthorizedException('CAPTCHA_REQUIRED');
      }

      if (!captchaAnswer || captchaAnswer.trim() !== security.captchaAnswer) {
        const failure = await this.registerFailedLogin(normalizedEmail);
        if (failure.locked) {
          throw new UnauthorizedException('Account is locked after 10 failed attempts');
        }
        throw new UnauthorizedException('Invalid captcha answer');
      }
    }

    const keycloakUrl = this.config.get<string>('keycloak.url');
    const clientId = this.config.get<string>('keycloak.adminClientId');

    const tokenUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/token`;
    const requestToken = async (username: string) => {
      const params = new URLSearchParams({
        grant_type: 'password',
        client_id: clientId!,
        username,
        password,
      });

      const { data } = await firstValueFrom(
        this.http.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      return data as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        token_type: string;
      };
    };

    try {
      let data: {
        access_token: string;
        refresh_token: string;
        expires_in: number;
        token_type: string;
      };
      try {
        data = await requestToken(email);
      } catch {
        // Fallback to username login when Keycloak email-login is disabled.
        const localUser = await this.prisma.user.findUnique({
          where: { email },
          select: { username: true },
        });
        if (!localUser?.username) {
          throw new UnauthorizedException('Invalid credentials');
        }
        data = await requestToken(localUser.username);
      }

      const user = await this.prisma.user.findFirst({
        where: { OR: [{ username: email }, { email }] },
        select: { email: true, username: true, notifySignIn: true },
      });
      if (user?.email && user.notifySignIn) {
        this.email
          .sendSignInNotification(user.email, user.username, meta)
          .catch(() => {});
      }

      await this.prisma.loginSecurityState.update({
        where: { email: normalizedEmail },
        data: {
          failedAttempts: 0,
          consecutiveFailed: 0,
          lockedUntil: null,
          captchaQuestion: null,
          captchaAnswer: null,
          captchaExpiresAt: null,
        },
      });

      let forcePasswordChange = false;
      try {
        const userId = this.decodeJwtSubject(data.access_token);
        if (userId) {
          forcePasswordChange =
            await this.keycloak.getPlatformUserForcePasswordChangeById(userId);
        } else {
          forcePasswordChange =
            await this.keycloak.getPlatformUserForcePasswordChangeByEmail(normalizedEmail);
        }
      } catch {
        forcePasswordChange = false;
      }

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        tokenType: data.token_type,
        forcePasswordChange,
      };
    } catch {
      const failure = await this.registerFailedLogin(normalizedEmail);
      if (failure.locked) {
        throw new UnauthorizedException('Account is locked after 10 failed attempts');
      }
      if (failure.consecutiveFailed >= AuthService.CAPTCHA_AFTER_CONSECUTIVE_FAILED) {
        throw new UnauthorizedException('CAPTCHA_REQUIRED');
      }
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  async changePassword(
    userId: string,
    email: string,
    currentPassword: string,
    newPassword: string,
    allowIdentityEdit = false,
  ) {
    this.ensureStrongPassword(newPassword);
    let methods: {
      authProvider: 'local' | 'google' | 'github';
      signOnMethod: 'local' | 'google' | 'github';
      linkedProviders: Array<'google' | 'github'>;
      hasPasswordAuth: boolean;
    } = {
      authProvider: 'local',
      signOnMethod: 'local',
      linkedProviders: [],
      hasPasswordAuth: true,
    };
    try {
      methods = await this.keycloak.getPlatformUserSignInMethodsById(userId);
    } catch {
      methods = {
        authProvider: 'local',
        signOnMethod: 'local',
        linkedProviders: [],
        hasPasswordAuth: true,
      };
    }
    if (methods.signOnMethod !== 'local') {
      throw new BadRequestException(
        `SOCIAL_PASSWORD_DISABLED:${methods.signOnMethod.toUpperCase()}`,
      );
    }
    if (methods.signOnMethod === 'local') {
      try {
        await this.login(email, currentPassword);
      } catch {
        throw new UnauthorizedException('Current password is incorrect');
      }
    }

    try {
      await this.keycloak.resetPlatformUserPassword(userId, newPassword);
      await this.keycloak.clearPlatformUserForcePasswordChange(userId);
    } catch (err: any) {
      throw new InternalServerErrorException(`Failed to change password: ${err.message}`);
    }

    return { message: 'Password changed successfully' };
  }

  getOAuthRedirectUrl(provider: string, redirectTo?: string) {
    const keycloakUrl = this.config.get<string>('keycloak.publicUrl');
    const publicApiUrl = this.config.get<string>('publicApiUrl');
    const platformClientId = this.keycloak.getPlatformOAuthClientId();
    const callbackUrl = `${publicApiUrl}/api/auth/oauth/callback`;

    const state = Buffer.from(
      JSON.stringify({ redirectTo: redirectTo || '/' }),
    ).toString('base64url');

    const authUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/auth`;
    const params = new URLSearchParams({
      client_id: platformClientId,
      response_type: 'code',
      scope: 'openid email profile',
      redirect_uri: callbackUrl,
      state,
      kc_idp_hint: provider,
      // For Google: always re-authenticate and show account chooser
      // so sign-out does not auto-login with the previous account.
      ...(provider === 'google' ? { prompt: 'login', max_age: '0' } : {}),
    });

    return { url: `${authUrl}?${params.toString()}`, provider };
  }

  async handleOAuthCallback(code: string, state: string) {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const publicApiUrl = this.config.get<string>('publicApiUrl');
    const platformClientId = this.keycloak.getPlatformOAuthClientId();
    const callbackUrl = `${publicApiUrl}/api/auth/oauth/callback`;

    const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    const { redirectTo } = stateData;

    const tokenUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/token`;
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: platformClientId,
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
      throw new InternalServerErrorException('OAuth authentication failed');
    }
  }

  async refresh(refreshToken: string) {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const clientId = this.config.get<string>('keycloak.adminClientId');

    const tokenUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/token`;

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId!,
      refresh_token: refreshToken,
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
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }

  async logout(refreshToken: string, postLogoutRedirectUri?: string) {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const keycloakPublicUrl = this.config.get<string>('keycloak.publicUrl') || keycloakUrl;
    const adminClientId = this.config.get<string>('keycloak.adminClientId');
    const browserClientId = this.keycloak.getPlatformOAuthClientId();
    const appUrl = this.config.get<string>('appUrl') || 'http://localhost:3000';
    const safeRedirect = (() => {
      const fallback = `${appUrl}/login`;
      const allowedOrigins = new Set<string>();
      try {
        allowedOrigins.add(new URL(appUrl).origin);
      } catch {
        allowedOrigins.add('http://localhost:3000');
      }
      allowedOrigins.add('http://localhost:3000');
      if (!postLogoutRedirectUri) return fallback;
      try {
        const requested = new URL(postLogoutRedirectUri);
        if (!['http:', 'https:'].includes(requested.protocol)) return fallback;
        if (!allowedOrigins.has(requested.origin)) return fallback;
        return requested.toString();
      } catch {
        return fallback;
      }
    })();

    try {
      const logoutUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/logout`;
      const params = new URLSearchParams({
        client_id: adminClientId!,
        refresh_token: refreshToken,
      });

      await firstValueFrom(
        this.http.post(logoutUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
    } catch {
      // Best-effort: don't fail sign-out if Keycloak revocation errors
    }

    const browserLogoutParams = new URLSearchParams({
      client_id: browserClientId,
      post_logout_redirect_uri: safeRedirect,
    });
    const browserLogoutUrl =
      `${keycloakPublicUrl}/realms/master/protocol/openid-connect/logout?` +
      browserLogoutParams.toString();

    return { message: 'Logged out', logoutUrl: browserLogoutUrl };
  }

  async forgotPassword(email: string) {
    const kcUser = await this.keycloak.findPlatformUserByEmail(email);
    if (!kcUser) {
      // Return success even if user doesn't exist to prevent email enumeration
      return { message: 'If that email exists, a reset link has been sent.' };
    }
    try {
      const methods = await this.keycloak.getPlatformUserSignInMethodsById(
        kcUser.id!,
        email,
      );
      if (methods.signOnMethod !== 'local') {
        // Keep generic success response to avoid account-enumeration leaks.
        return { message: 'If that email exists, a reset link has been sent.' };
      }
    } catch {
      // If provider check fails, continue with generic flow.
    }

    // Invalidate any previous unused tokens for this email
    await this.prisma.passwordResetToken.updateMany({
      where: { email, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.passwordResetToken.create({
      data: { email, token, expiresAt },
    });

    const username = kcUser.username || email;
    await this.email.sendPasswordResetLink(email, username, token);

    this.logger.log(`Password reset link sent to ${email}`);
    return { message: 'If that email exists, a reset link has been sent.' };
  }

  async resetPassword(token: string, newPassword: string) {
    this.ensureStrongPassword(newPassword);
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { token },
    });

    if (!resetToken) {
      throw new BadRequestException('Invalid or expired reset link.');
    }

    if (resetToken.usedAt) {
      throw new BadRequestException('This reset link has already been used.');
    }

    if (resetToken.expiresAt < new Date()) {
      throw new BadRequestException('This reset link has expired. Please request a new one.');
    }

    let kcUser: any;

    if (resetToken.realm) {
      kcUser = await this.keycloak.findUserByEmailInRealm(resetToken.realm, resetToken.email);
      if (!kcUser || !kcUser.id) {
        throw new BadRequestException('User account not found.');
      }
      try {
        const methods = await this.keycloak.getPlatformUserSignInMethodsById(
          kcUser.id,
          resetToken.email,
        );
        if (methods.signOnMethod !== 'local') {
          throw new BadRequestException(
            `SOCIAL_PASSWORD_DISABLED:${methods.signOnMethod.toUpperCase()}`,
          );
        }
      } catch (err) {
        if (err instanceof BadRequestException) {
          throw err;
        }
      }
      await this.keycloak.resetUserPasswordInRealm(resetToken.realm, kcUser.id, newPassword);
    } else {
      kcUser = await this.keycloak.findPlatformUserByEmail(resetToken.email);
      if (!kcUser || !kcUser.id) {
        throw new BadRequestException('User account not found.');
      }
      const methods = await this.keycloak.getPlatformUserSignInMethodsById(
        kcUser.id,
        resetToken.email,
      );
      if (methods.signOnMethod !== 'local') {
        throw new BadRequestException(
          `SOCIAL_PASSWORD_DISABLED:${methods.signOnMethod.toUpperCase()}`,
        );
      }
      await this.keycloak.resetPlatformUserPassword(kcUser.id, newPassword);
    }

    await this.prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    });

    this.logger.log(`Password successfully reset for ${resetToken.email}`);
    await this.prisma.loginSecurityState.upsert({
      where: { email: this.normalizeEmail(resetToken.email) },
      create: {
        email: this.normalizeEmail(resetToken.email),
        failedAttempts: 0,
        consecutiveFailed: 0,
        lockedUntil: null,
        captchaAnswer: null,
        captchaQuestion: null,
        captchaExpiresAt: null,
      },
      update: {
        failedAttempts: 0,
        consecutiveFailed: 0,
        lockedUntil: null,
        captchaAnswer: null,
        captchaQuestion: null,
        captchaExpiresAt: null,
      },
    });
    return { message: 'Your password has been reset. You can now sign in.' };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');
    let authProvider: 'local' | 'google' | 'github' = 'local';
    let signOnMethod: 'local' | 'google' | 'github' = 'local';
    let forcePasswordChange = false;
    try {
      const methods = await this.keycloak.getPlatformUserSignInMethodsById(userId, user.email);
      authProvider = methods.authProvider;
      signOnMethod = methods.signOnMethod;
      forcePasswordChange = await this.keycloak.getPlatformUserForcePasswordChangeById(userId);
    } catch {
      authProvider = 'local';
      signOnMethod = 'local';
      forcePasswordChange = false;
    }

    return {
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      githubUsername: user.githubUsername,
      notifySignIn: user.notifySignIn,
      notifyTeamInvite: user.notifyTeamInvite,
      role: user.role,
      createdAt: user.createdAt,
      authProvider,
      signOnMethod,
      canEditIdentityFields: authProvider === 'local',
      canChangePassword: signOnMethod === 'local',
      forcePasswordChange,
    };
  }

  async updateProfile(
    userId: string,
    data: {
      username?: string;
      firstName?: string;
      lastName?: string;
      email?: string;
      githubUsername?: string;
      avatarUrl?: string;
      notifySignIn?: boolean;
      notifyTeamInvite?: boolean;
      allowIdentityEdit?: boolean;
    },
  ) {
    const updateData: Record<string, any> = {};
    let authProvider: 'local' | 'google' | 'github' = 'local';
    let signOnMethod: 'local' | 'google' | 'github' = 'local';
    let forcePasswordChange = false;
    try {
      const methods = await this.keycloak.getPlatformUserSignInMethodsById(userId);
      authProvider = methods.authProvider;
      signOnMethod = methods.signOnMethod;
      forcePasswordChange = await this.keycloak.getPlatformUserForcePasswordChangeById(userId);
    } catch {
      authProvider = 'local';
      signOnMethod = 'local';
      forcePasswordChange = false;
    }
    const changingIdentityFields =
      data.username !== undefined || data.email !== undefined;
    if (authProvider !== 'local' && changingIdentityFields && !data.allowIdentityEdit) {
      throw new BadRequestException(
        `This account uses ${authProvider} sign-in. Use "Enable identity edits" first.`,
      );
    }

    if (data.username !== undefined) {
      const existing = await this.prisma.user.findFirst({
        where: { username: data.username, NOT: { id: userId } },
      });
      if (existing) throw new ConflictException('Username already taken');
      updateData.username = data.username;
    }

    if (data.firstName !== undefined) {
      updateData.firstName = data.firstName || null;
    }

    if (data.lastName !== undefined) {
      updateData.lastName = data.lastName || null;
    }

    if (data.email !== undefined) {
      const existing = await this.prisma.user.findFirst({
        where: { email: data.email, NOT: { id: userId } },
      });
      if (existing) throw new ConflictException('Email already registered');
      updateData.email = data.email;
    }

    if (data.githubUsername !== undefined) {
      if (data.githubUsername) {
        const existing = await this.prisma.user.findFirst({
          where: { githubUsername: data.githubUsername, NOT: { id: userId } },
        });
        if (existing) {
          throw new ConflictException(
            `GitHub account "${data.githubUsername}" is already linked to another user`,
          );
        }
      }
      updateData.githubUsername = data.githubUsername || null;
    }

    if (data.avatarUrl !== undefined) {
      updateData.avatarUrl = data.avatarUrl || null;
    }

    if (data.notifySignIn !== undefined) {
      updateData.notifySignIn = data.notifySignIn;
    }

    if (data.notifyTeamInvite !== undefined) {
      updateData.notifyTeamInvite = data.notifyTeamInvite;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    return {
      id: user.id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      githubUsername: user.githubUsername,
      notifySignIn: user.notifySignIn,
      notifyTeamInvite: user.notifyTeamInvite,
      role: user.role,
      createdAt: user.createdAt,
      authProvider,
      signOnMethod,
      canEditIdentityFields: authProvider === 'local',
      canChangePassword: signOnMethod === 'local',
      forcePasswordChange,
    };
  }

  async uploadAvatar(userId: string, file: Express.Multer.File): Promise<{ avatarUrl: string }> {
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.mimetype)) {
      throw new BadRequestException('Only JPEG, PNG, WebP, or GIF images are allowed');
    }

    const maxSize = 5 * 1024 * 1024; // 5 MB
    if (file.size > maxSize) {
      throw new BadRequestException('Image must be smaller than 5 MB');
    }

    await this.ensureAvatarBucket();

    const ext = file.originalname.split('.').pop()?.toLowerCase() || 'jpg';
    const objectName = `${userId}/avatar-${Date.now()}.${ext}`;

    const readable = new PassThrough();
    readable.end(file.buffer);

    await this.minioClient.putObject(
      AuthService.AVATAR_BUCKET,
      objectName,
      readable,
      file.size,
      { 'Content-Type': file.mimetype },
    );

    const protocol = this.minioPublicSsl ? 'https' : 'http';
    const port = this.minioPublicPort !== 80 && this.minioPublicPort !== 443
      ? `:${this.minioPublicPort}`
      : '';
    const avatarUrl = `${protocol}://${this.minioPublicEndpoint}${port}/${AuthService.AVATAR_BUCKET}/${objectName}`;

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });

    this.logger.log(`Avatar uploaded for user ${userId}: ${objectName}`);
    return { avatarUrl };
  }

  async listManagementUsers() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        username: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        createdAt: true,
        _count: {
          select: { teamMembers: true },
        },
      },
    });
    const enabledMap = new Map<string, boolean>();
    const signInMap = new Map<
      string,
      {
        authProvider: 'local' | 'google' | 'github';
        signOnMethod: 'local' | 'google' | 'github';
        linkedProviders: Array<'google' | 'github'>;
        hasPasswordAuth: boolean;
      }
    >();
    await Promise.all(
      users.map(async (u) => {
        try {
          const enabled = await this.keycloak.getPlatformUserEnabledById(u.id);
          enabledMap.set(u.id, enabled);
        } catch {
          enabledMap.set(u.id, true);
        }
        try {
          const methods = await this.keycloak.getPlatformUserSignInMethodsById(u.id, u.email);
          signInMap.set(u.id, methods);
        } catch {
          signInMap.set(u.id, {
            authProvider: 'local',
            signOnMethod: 'local',
            linkedProviders: [],
            hasPasswordAuth: true,
          });
        }
      }),
    );
    return users.map((u) => ({
      ...u,
      isActive: enabledMap.get(u.id) ?? true,
      authProvider: signInMap.get(u.id)?.authProvider ?? 'local',
      signOnMethod: signInMap.get(u.id)?.signOnMethod ?? 'local',
      linkedProviders: signInMap.get(u.id)?.linkedProviders ?? [],
      hasPasswordAuth: signInMap.get(u.id)?.hasPasswordAuth ?? true,
    }));
  }

  async updateUserRoleByRoot(currentUserId: string, targetUserId: string, role: string) {
    const allowedRoles = new Set(['USER', 'ADMIN', 'ROOT']);
    if (!allowedRoles.has(role)) {
      throw new BadRequestException('Invalid role');
    }
    if (currentUserId === targetUserId && role !== 'ROOT') {
      throw new BadRequestException('Root user cannot remove own ROOT role');
    }
    return this.prisma.user.update({
      where: { id: targetUserId },
      data: { role: role as 'USER' | 'ADMIN' | 'ROOT' },
      select: {
        id: true,
        username: true,
        email: true,
        role: true,
      },
    });
  }

  async setManagementUserSignInMethodByRoot(
    targetUserId: string,
    method: 'local' | 'google' | 'github',
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, username: true, email: true },
    });
    if (!target) {
      throw new BadRequestException('User not found');
    }
    await this.keycloak.setPlatformUserAuthProviderOverrideById(
      targetUserId,
      target.email,
      method,
    );
    return {
      id: target.id,
      username: target.username,
      email: target.email,
      authProvider: method,
    };
  }

  async resetManagementUserPasswordByRoot(
    currentUserId: string,
    targetUserId: string,
    newPassword: string,
    forceChangeOnFirstLogin: boolean,
  ) {
    if (!newPassword || newPassword.trim().length === 0) {
      throw new BadRequestException('Password is required');
    }
    this.ensureStrongPassword(newPassword);
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true },
    });
    if (!target) {
      throw new BadRequestException('User not found');
    }
    const methods = await this.keycloak.getPlatformUserSignInMethodsById(targetUserId);
    if (methods.signOnMethod !== 'local') {
      throw new BadRequestException(
        `Password reset is disabled for ${methods.signOnMethod} sign-up users.`,
      );
    }

    await this.keycloak.resetPlatformUserPasswordWithPolicy(
      targetUserId,
      newPassword,
      forceChangeOnFirstLogin,
    );

    this.logger.log(
      `Root user ${currentUserId} reset password for ${targetUserId} (forceChangeOnFirstLogin=${forceChangeOnFirstLogin})`,
    );

    return {
      id: target.id,
      email: target.email,
      forceChangeOnFirstLogin,
    };
  }

  async listManagementTeams() {
    const teams = await this.prisma.team.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        members: {
          where: { role: 'OWNER' },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                email: true,
              },
            },
          },
          take: 1,
        },
        _count: {
          select: {
            members: true,
            projects: true,
          },
        },
      },
    });

    return teams.map((team) => ({
      id: team.id,
      name: team.name,
      slug: team.slug,
      createdAt: team.createdAt,
      memberCount: team._count.members,
      projectCount: team._count.projects,
      owner: team.members[0]?.user ?? null,
    }));
  }

  async deleteManagementTeamByRoot(teamId: string) {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: {
        id: true,
        name: true,
        personalForUserId: true,
        _count: {
          select: {
            projects: true,
          },
        },
      },
    });
    if (!team) {
      throw new BadRequestException('Team not found');
    }
    if (team.personalForUserId) {
      throw new BadRequestException('Personal teams cannot be deleted');
    }
    if (team._count.projects > 0) {
      throw new BadRequestException(
        'Team cannot be deleted while it still has projects',
      );
    }

    await this.prisma.$transaction([
      this.prisma.user.updateMany({
        where: { activeTeamId: teamId },
        data: { activeTeamId: null },
      }),
      this.prisma.team.delete({
        where: { id: teamId },
      }),
    ]);

    return { id: team.id, name: team.name, deleted: true as const };
  }

  async setManagementUserActiveByRoot(currentUserId: string, targetUserId: string, isActive: boolean) {
    if (currentUserId === targetUserId && !isActive) {
      throw new BadRequestException('Root user cannot deactivate own account');
    }
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { id: true, email: true, username: true },
    });
    if (!target) {
      throw new BadRequestException('User not found');
    }
    await this.keycloak.setPlatformUserEnabledById(targetUserId, isActive);
    return { id: target.id, email: target.email, username: target.username, isActive };
  }

  async getRolePermissionsByRoot() {
    const existing = await this.prisma.rolePermission.findMany();
    const existingByRole = new Map(existing.map((row) => [row.role, row]));

    for (const role of ['USER', 'ADMIN', 'ROOT'] as const) {
      if (!existingByRole.has(role)) {
        const created = await this.prisma.rolePermission.create({
          data: {
            role,
            ...AuthService.DEFAULT_ROLE_PERMISSIONS[role],
          },
        });
        existingByRole.set(role, created);
      }
    }

    return (['USER', 'ADMIN', 'ROOT'] as const).map((role) => {
      const row = existingByRole.get(role)!;
      return {
        role,
        canAccessManagement: row.canAccessManagement,
        canManageUsers: row.canManageUsers,
        canManageTeams: row.canManageTeams,
        canManagePlans: row.canManagePlans,
        canManageUserPackages: row.canManageUserPackages,
        canModerateFeedback: row.canModerateFeedback,
        canViewAuditLogs: row.canViewAuditLogs,
        canViewRootAlerts: row.canViewRootAlerts,
      };
    });
  }

  async updateRolePermissionsByRoot(role: 'USER' | 'ADMIN' | 'ROOT', patch: Partial<RolePermissionMatrix>) {
    if (role === 'ROOT') {
      throw new BadRequestException('ROOT permissions are fixed and cannot be edited');
    }

    const allowedKeys: RolePermissionKey[] = [
      'canAccessManagement',
      'canManageUsers',
      'canManageTeams',
      'canManagePlans',
      'canManageUserPackages',
      'canModerateFeedback',
      'canViewAuditLogs',
      'canViewRootAlerts',
    ];
    const data: Partial<RolePermissionMatrix> = {};
    for (const key of allowedKeys) {
      if (typeof patch[key] === 'boolean') {
        data[key] = patch[key];
      }
    }

    const updated = await this.prisma.rolePermission.upsert({
      where: { role },
      create: {
        role,
        ...AuthService.DEFAULT_ROLE_PERMISSIONS[role],
        ...data,
      },
      update: data,
    });

    return {
      role: updated.role,
      canAccessManagement: updated.canAccessManagement,
      canManageUsers: updated.canManageUsers,
      canManageTeams: updated.canManageTeams,
      canManagePlans: updated.canManagePlans,
      canManageUserPackages: updated.canManageUserPackages,
      canModerateFeedback: updated.canModerateFeedback,
      canViewAuditLogs: updated.canViewAuditLogs,
      canViewRootAlerts: updated.canViewRootAlerts,
    };
  }

  async getManagementPermissionsForUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    if (user.role === 'ROOT') {
      return {
        role: 'ROOT' as const,
        canAccessManagement: true,
        canManageUsers: true,
        canManageTeams: true,
        canManagePlans: true,
        canManageUserPackages: true,
        canModerateFeedback: true,
        canViewAuditLogs: true,
        canViewRootAlerts: true,
      };
    }

    const fallback = AuthService.DEFAULT_ROLE_PERMISSIONS[user.role as 'USER' | 'ADMIN'];
    const row = await this.prisma.rolePermission.upsert({
      where: { role: user.role },
      create: { role: user.role, ...fallback },
      update: {},
    });

    return {
      role: row.role,
      canAccessManagement: row.canAccessManagement,
      canManageUsers: row.canManageUsers,
      canManageTeams: row.canManageTeams,
      canManagePlans: row.canManagePlans,
      canManageUserPackages: row.canManageUserPackages,
      canModerateFeedback: row.canModerateFeedback,
      canViewAuditLogs: row.canViewAuditLogs,
      canViewRootAlerts: row.canViewRootAlerts,
    };
  }

}
