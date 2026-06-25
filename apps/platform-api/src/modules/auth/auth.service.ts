import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { createHash, randomBytes, randomInt } from 'crypto';
import * as Minio from 'minio';
import { PassThrough } from 'stream';
import { KeycloakAdminService } from './keycloak-admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { BillingService } from '../billing/billing.service';
import { RedisService } from '../redis/redis.service';
import { getDisplayName } from '../../common/utils/display-name';

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
  private static readonly AVATAR_BUCKET = 'bf-platform-avatars';
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

  // Redis key prefixes for pending signup state
  private readonly SIGNUP_OTP_PREFIX = 'platform_signup_otp';
  private readonly SIGNUP_DATA_PREFIX = 'platform_signup_data';
  private readonly SIGNUP_RATE_PREFIX = 'platform_signup_rate';
  private readonly SIGNUP_OTP_TTL = 600;   // 10 minutes
  private readonly SIGNUP_RATE_TTL = 60;   // 1 resend per 60 seconds

  // Redis key prefixes for CLI browser-based login flow
  private readonly CLI_LOGIN_STATE_PREFIX = 'platform_cli_login_state';
  private readonly CLI_LOGIN_EXCHANGE_PREFIX = 'platform_cli_login_exchange';
  private readonly CLI_LOGIN_STATE_TTL = 300;    // 5 minutes for user to authenticate
  private readonly CLI_LOGIN_EXCHANGE_TTL = 60;  // 60 seconds one-time code window

  /** Password-reset magic link TTL (must match email copy). */
  private static readonly PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
  private static readonly RESET_LINK_INVALID =
    'Invalid or expired reset link. Please request a new one.';

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly keycloak: KeycloakAdminService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly billing: BillingService,
    private readonly redis: RedisService,
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

  private generateOtp(): string {
    return String(randomInt(100000, 999999));
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

  private buildLoginFingerprint(meta?: { ipAddress?: string; userAgent?: string }): string {
    const ip = (meta?.ipAddress || '').trim();
    const ua = (meta?.userAgent || '').trim().toLowerCase();
    return createHash('sha256').update(`${ip}|${ua}`).digest('hex');
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

  // Step 1: Validate email, store pending signup data in Redis, send OTP
  async initiateSignup(data: {
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

    // Rate limit: one OTP request per 60 seconds per email
    const rateKey = `${this.SIGNUP_RATE_PREFIX}:${data.email}`;
    const rateLimited = await this.redis.get(rateKey);
    if (rateLimited) {
      throw new BadRequestException('Please wait before requesting a new code');
    }

    const otp = this.generateOtp();

    // Store pending signup data (no Keycloak/Prisma records created yet)
    await this.redis.set(
      `${this.SIGNUP_DATA_PREFIX}:${data.email}`,
      JSON.stringify(data),
      this.SIGNUP_OTP_TTL,
    );
    await this.redis.set(`${this.SIGNUP_OTP_PREFIX}:${data.email}`, otp, this.SIGNUP_OTP_TTL);
    await this.redis.set(rateKey, '1', this.SIGNUP_RATE_TTL);

    this.email.sendSignupVerifyEmail(data.email, otp, data.firstName).catch(() => {});

    return { message: 'Verification code sent to your email' };
  }

  // Step 2: Verify OTP and complete registration
  async verifySignupOtp(email: string, otp: string) {
    const storedOtp = await this.redis.get(`${this.SIGNUP_OTP_PREFIX}:${email}`);
    if (!storedOtp) {
      throw new BadRequestException('Verification code expired or not found. Please sign up again.');
    }
    if (storedOtp !== otp) {
      throw new BadRequestException('Invalid verification code');
    }

    const signupDataStr = await this.redis.get(`${this.SIGNUP_DATA_PREFIX}:${email}`);
    if (!signupDataStr) {
      throw new BadRequestException('Signup session expired. Please sign up again.');
    }
    const data = JSON.parse(signupDataStr) as {
      email: string;
      password: string;
      firstName?: string;
      lastName?: string;
      planName?: string;
    };

    // Guard against an existing account. Check BOTH our DB (the source of truth
    // for completed signups) and Keycloak (catches orphans from a previously
    // failed signup). Either match means this email is taken — tell them to sign in.
    const existingDbUser = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    const existingEmail = existingDbUser || (await this.keycloak.findPlatformUserByEmail(email));
    if (existingEmail) {
      await this.redis.del(`${this.SIGNUP_OTP_PREFIX}:${email}`);
      await this.redis.del(`${this.SIGNUP_DATA_PREFIX}:${email}`);
      throw new ConflictException('Email already registered. Please sign in instead.');
    }

    let keycloakId: string;
    try {
      // Keycloak requires a username — use email since it's already unique
      keycloakId = await this.keycloak.createPlatformUser({ ...data, username: data.email });
    } catch (err: any) {
      // A 409 means a Keycloak user with this email/username already exists
      // (e.g. an orphan from a prior failed signup) — surface it as a conflict.
      const status = err?.response?.status ?? err?.responseData?.status;
      if (status === 409) {
        throw new ConflictException('Email already registered. Please sign in instead.');
      }
      throw new InternalServerErrorException(`Failed to create account: ${err.message}`);
    }

    let user: { id: string };
    try {
      user = await this.prisma.user.create({
        data: { id: keycloakId, email: data.email, role: 'USER' },
      });
    } catch (err: any) {
      // DB insert failed (e.g. the email already exists under another id). Don't
      // leave the just-created Keycloak user orphaned — roll it back.
      await this.keycloak.deletePlatformUser(keycloakId).catch(() => {});
      if (err?.code === 'P2002') {
        throw new ConflictException('Email already registered. Please sign in instead.');
      }
      throw new InternalServerErrorException(`Failed to create account: ${err.message}`);
    }

    const displayName = data.firstName || data.email.split('@')[0];
    const emailSlug = data.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    const teamSlug = `personal-${emailSlug}-${keycloakId.slice(0, 8)}`;

    const team = await this.prisma.team.create({
      data: {
        name: `${displayName}'s Team`,
        slug: teamSlug,
        personalForUserId: user.id,
        members: { create: { userId: user.id, role: 'OWNER' } },
      },
    });

    await this.prisma.user.update({ where: { id: user.id }, data: { activeTeamId: team.id } });

    // Clean up Redis keys
    await this.redis.del(`${this.SIGNUP_OTP_PREFIX}:${email}`);
    await this.redis.del(`${this.SIGNUP_DATA_PREFIX}:${email}`);
    await this.redis.del(`${this.SIGNUP_RATE_PREFIX}:${email}`);

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

  // Resend OTP for a pending signup (rate-limited to once per 60 seconds)
  async resendSignupOtp(email: string) {
    const signupDataStr = await this.redis.get(`${this.SIGNUP_DATA_PREFIX}:${email}`);
    if (!signupDataStr) {
      throw new BadRequestException('No pending signup found. Please sign up again.');
    }

    const rateKey = `${this.SIGNUP_RATE_PREFIX}:${email}`;
    const rateLimited = await this.redis.get(rateKey);
    if (rateLimited) {
      throw new BadRequestException('Please wait before requesting a new code');
    }

    const data = JSON.parse(signupDataStr) as { firstName?: string };
    const otp = this.generateOtp();

    // Overwrite OTP and refresh data TTL
    await this.redis.set(`${this.SIGNUP_OTP_PREFIX}:${email}`, otp, this.SIGNUP_OTP_TTL);
    await this.redis.set(`${this.SIGNUP_DATA_PREFIX}:${email}`, signupDataStr, this.SIGNUP_OTP_TTL);
    await this.redis.set(rateKey, '1', this.SIGNUP_RATE_TTL);

    this.email.sendSignupVerifyEmail(email, otp, data.firstName).catch(() => {});

    return { message: 'New verification code sent' };
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
      const safeEmail = email || `${sub.slice(0, 8)}@basefyio.local`;
      const parsed = oauthName
        ? this.parseOAuthName(oauthName.givenName, oauthName.familyName, oauthName.name)
        : { firstName: null, lastName: null };

      const user = await this.prisma.user.create({
        data: {
          id: sub,
          email: safeEmail,
          role: 'USER',
          ...(parsed.firstName ? { firstName: parsed.firstName } : {}),
          ...(parsed.lastName ? { lastName: parsed.lastName } : {}),
        },
      });

      const emailSlug = safeEmail.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
      const slug = `personal-${emailSlug}-${sub.slice(0, 8)}`;

      const teamDisplayName = (user.firstName || safeEmail.split('@')[0]);
      const team = await this.prisma.team.create({
        data: {
          name: `${teamDisplayName}'s Team`,
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
        await this.billing.createFreeSubscription(team.id, safeEmail, `${teamDisplayName}'s Team`);
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
        id_token?: string;
        expires_in: number;
        token_type: string;
      };
    };

    try {
      let data: {
        access_token: string;
        refresh_token: string;
        id_token?: string;
        expires_in: number;
        token_type: string;
      };
      try {
        data = await requestToken(email);
      } catch {
        throw new UnauthorizedException('Invalid credentials');
      }

      const user = await this.prisma.user.findUnique({
        where: { email },
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          notifySignIn: true,
          notifySignInNewDevice: true,
          lastLoginFingerprint: true,
        },
      });
      const loginFingerprint = this.buildLoginFingerprint(meta);
      const isNewDevice =
        !!user?.lastLoginFingerprint && user.lastLoginFingerprint !== loginFingerprint;
      const shouldSendSignInEmail =
        !!user?.email &&
        (user.notifySignIn || (user.notifySignInNewDevice && isNewDevice));
      if (shouldSendSignInEmail) {
        this.email
          .sendSignInNotification(user.email, getDisplayName(user), {
            ...meta,
            isNewDevice,
          } as { ipAddress?: string; userAgent?: string })
          .catch(() => {});
      }
      if (user?.id) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            lastLoginFingerprint: loginFingerprint,
            lastLoginAt: new Date(),
          },
        });
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
            await this.keycloak.getPlatformUserForcePasswordChangeById(
              userId,
              normalizedEmail,
            );
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
        idToken: data.id_token,
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

  /**
   * Validate user password by attempting Keycloak authentication
   * Returns true if password is correct, false otherwise
   */
  private async validatePassword(email: string, password: string): Promise<boolean> {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const clientId = this.config.get<string>('keycloak.adminClientId');
    const tokenUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/token`;

    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: clientId!,
      username: email,
      password,
    });

    try {
      await firstValueFrom(
        this.http.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async changePassword(
    userId: string,
    email: string,
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

    try {
      await this.keycloak.resetPlatformUserPassword(userId, newPassword, email);
      await this.keycloak.clearPlatformUserForcePasswordChange(userId, email);
    } catch (err: any) {
      throw new InternalServerErrorException(`Failed to change password: ${err.message}`);
    }

    return { message: 'Password changed successfully' };
  }

  async completeForcedPasswordChange(userId: string, newPassword: string) {
    this.ensureStrongPassword(newPassword);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    const mustChangePassword = await this.keycloak.getPlatformUserForcePasswordChangeById(
      userId,
      user?.email,
    );
    if (!mustChangePassword) {
      throw new BadRequestException('Forced password change is not required for this account');
    }

    try {
      await this.keycloak.resetPlatformUserPassword(userId, newPassword, user?.email);
      await this.keycloak.clearPlatformUserForcePasswordChange(userId, user?.email);
    } catch (err: any) {
      throw new InternalServerErrorException(
        `Failed to complete forced password change: ${err.message}`,
      );
    }

    return { message: 'Password changed successfully' };
  }

  /**
   * Step 1 of CLI login: store state in Redis, redirect browser to the
   * admin-ui's /cli-authorize page. The user logs in there (if needed) and
   * grants or denies access — no Keycloak page is shown.
   */
  async startCliLogin(port: number, nonce: string): Promise<string> {
    if (port < 1024 || port > 65535) {
      throw new BadRequestException('Invalid port');
    }

    const stateId = randomBytes(16).toString('hex');
    await this.redis.set(
      `${this.CLI_LOGIN_STATE_PREFIX}:${stateId}`,
      JSON.stringify({ port, nonce }),
      this.CLI_LOGIN_STATE_TTL,
    );

    const appUrl = this.config.get<string>('appUrl');
    return `${appUrl}/cli-authorize?cli_state=${stateId}`;
  }

  /** Returns the loopback port stored in a CLI state entry (non-consuming). */
  async getCliStatePort(stateId: string): Promise<number> {
    const raw = await this.redis.get(`${this.CLI_LOGIN_STATE_PREFIX}:${stateId}`);
    if (!raw) throw new NotFoundException('CLI session not found or expired');
    const parsed = JSON.parse(raw) as { port: number };
    return parsed.port;
  }

  /**
   * Step 2 of CLI login: the user clicked Allow on /cli-authorize.
   * Consumes the state, stores the user's existing tokens under a one-time
   * exchange code, and returns { exchangeCode, port } to the frontend.
   */
  async authorizeCliAccess(
    stateId: string,
    accessToken: string,
    refreshToken: string,
  ): Promise<{ exchangeCode: string; port: number }> {
    const raw = await this.redis.getdel(`${this.CLI_LOGIN_STATE_PREFIX}:${stateId}`);
    if (!raw) throw new NotFoundException('CLI session not found or expired');
    const state = JSON.parse(raw) as { port: number; nonce: string };

    const exchangeCode = randomBytes(32).toString('hex');
    await this.redis.set(
      `${this.CLI_LOGIN_EXCHANGE_PREFIX}:${exchangeCode}`,
      JSON.stringify({
        accessToken,
        refreshToken,
        nonce: state.nonce,
        expiresIn: 300,
        tokenType: 'Bearer',
      }),
      this.CLI_LOGIN_EXCHANGE_TTL,
    );

    return { exchangeCode, port: state.port };
  }

  /**
   * Used by the error path in oauthCallback to detect a CLI flow and get the loopback port.
   * Atomically consumes the state so it cannot be replayed.
   */
  async resolveCliState(stateId: string): Promise<{ port: number } | null> {
    const raw = await this.redis.getdel(`${this.CLI_LOGIN_STATE_PREFIX}:${stateId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { port: number; nonce: string; pkceVerifier: string };
    return { port: parsed.port };
  }

  /** Step 3 of CLI login: consume the one-time exchange code and return real tokens. */
  async exchangeCliCode(code: string, nonce: string) {
    const raw = await this.redis.getdel(`${this.CLI_LOGIN_EXCHANGE_PREFIX}:${code}`);
    if (!raw) {
      // Generic 404 — don't leak whether the code was expired, consumed, or never existed
      throw new NotFoundException();
    }

    const stored = JSON.parse(raw) as {
      accessToken: string;
      refreshToken: string;
      idToken: string;
      expiresIn: number;
      tokenType: string;
      nonce: string;
    };

    // Nonce check defends against a different CLI process on the same machine replaying the code
    if (stored.nonce !== nonce) {
      throw new NotFoundException();
    }

    return {
      accessToken: stored.accessToken,
      refreshToken: stored.refreshToken,
      idToken: stored.idToken,
      expiresIn: stored.expiresIn,
      tokenType: stored.tokenType,
    };
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
    /** Brokered IdPs: force account picker + fresh auth to avoid Keycloak "different user" SSO conflicts */
    const socialIdps = new Set([
      'google',
      'github',
      'microsoft',
      'apple',
      'gitlab',
      'linkedin',
      'facebook',
      'twitter',
    ]);
    const params = new URLSearchParams({
      client_id: platformClientId,
      response_type: 'code',
      scope: 'openid email profile',
      redirect_uri: callbackUrl,
      state,
      kc_idp_hint: provider,
      ...(socialIdps.has(provider)
        ? { prompt: 'select_account login', max_age: '0' }
        : {}),
    });

    return { url: `${authUrl}?${params.toString()}`, provider };
  }

  async handleOAuthCallback(code: string, state: string) {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const publicApiUrl = this.config.get<string>('publicApiUrl');
    const platformClientId = this.keycloak.getPlatformOAuthClientId();
    const callbackUrl = `${publicApiUrl}/api/auth/oauth/callback`;

    const tokenUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/token`;

    // Detect CLI flow: stateId is an opaque hex string stored in Redis
    const cliStateRaw = await this.redis.getdel(`${this.CLI_LOGIN_STATE_PREFIX}:${state}`);
    if (cliStateRaw) {
      const cliState = JSON.parse(cliStateRaw) as { port: number; nonce: string; pkceVerifier: string };

      const cliParams = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: platformClientId,
        code,
        redirect_uri: callbackUrl,
        code_verifier: cliState.pkceVerifier, // PKCE S256 verification against Keycloak
      });

      try {
        const { data } = await firstValueFrom(
          this.http.post(tokenUrl, cliParams.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          }),
        );

        // Store tokens under a one-time exchange code (60s TTL)
        const exchangeCode = randomBytes(32).toString('hex');
        await this.redis.set(
          `${this.CLI_LOGIN_EXCHANGE_PREFIX}:${exchangeCode}`,
          JSON.stringify({
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            idToken: data.id_token,
            expiresIn: data.expires_in,
            tokenType: data.token_type,
            nonce: cliState.nonce,
          }),
          this.CLI_LOGIN_EXCHANGE_TTL,
        );

        // Redirect to the website confirmation page; user grants or denies from there
        const websiteUrl = this.config.get<string>('websiteUrl');
        return {
          cliRedirectUrl: `${websiteUrl}/cli-connect?token=${exchangeCode}&port=${cliState.port}`,
        };
      } catch (err: any) {
        // On failure, redirect CLI loopback with error so the CLI doesn't hang until timeout
        return {
          cliRedirectUrl: `http://127.0.0.1:${cliState.port}/callback?error=${encodeURIComponent('Authentication failed')}`,
        };
      }
    }

    // Standard web OAuth flow: state is base64url-encoded JSON
    const stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    const { redirectTo } = stateData;

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
        idToken: data.id_token,
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
    const tokenUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/token`;
    const platformClientId = this.keycloak.getPlatformOAuthClientId();
    const adminClientId = this.config.get<string>('keycloak.adminClientId')!;

    const tryRefresh = async (clientId: string) => {
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      });
      const { data } = await firstValueFrom(
        this.http.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      return data as {
        access_token: string;
        refresh_token: string;
        id_token?: string;
        expires_in: number;
      };
    };

    try {
      const data = await tryRefresh(platformClientId);
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        idToken: data.id_token,
        expiresIn: data.expires_in,
      };
    } catch {
      try {
        const data = await tryRefresh(adminClientId);
        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          idToken: data.id_token,
          expiresIn: data.expires_in,
        };
      } catch {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }
    }
  }

  async logout(
    refreshToken: string,
    postLogoutRedirectUri?: string,
    idToken?: string,
  ) {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const keycloakPublicUrl = this.config.get<string>('keycloak.publicUrl') || keycloakUrl;
    const adminClientId = this.config.get<string>('keycloak.adminClientId');
    const browserClientId = this.keycloak.getPlatformOAuthClientId();
    const appUrl = this.config.get<string>('appUrl') || 'http://localhost:3000';
    const normalizePostLogoutRedirect = (raw: string): string => {
      try {
        const u = new URL(raw);
        u.hash = '';
        u.pathname = u.pathname.replace(/\/+$/, '') || '/';
        return u.toString();
      } catch {
        return raw;
      }
    };
    const safeRedirect = (() => {
      const fallback = normalizePostLogoutRedirect(`${appUrl.replace(/\/+$/, '')}/login`);
      const allowedOrigins = new Set<string>();
      try {
        allowedOrigins.add(new URL(appUrl).origin);
      } catch {
        allowedOrigins.add('http://localhost:3000');
      }
      allowedOrigins.add('http://localhost:3000');
      allowedOrigins.add('http://127.0.0.1:3000');
      if (!postLogoutRedirectUri) return fallback;
      try {
        const requested = new URL(postLogoutRedirectUri);
        if (!['http:', 'https:'].includes(requested.protocol)) return fallback;
        if (!allowedOrigins.has(requested.origin)) return fallback;
        return normalizePostLogoutRedirect(requested.toString());
      } catch {
        return fallback;
      }
    })();

    try {
      const logoutEndpoint = `${keycloakUrl}/realms/master/protocol/openid-connect/logout`;
      const revoke = async (clientId: string) => {
        const params = new URLSearchParams({
          client_id: clientId,
          refresh_token: refreshToken,
        });
        await firstValueFrom(
          this.http.post(logoutEndpoint, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          }),
        );
      };
      try {
        await revoke(browserClientId);
      } catch {
        await revoke(adminClientId!);
      }
    } catch {
      // Best-effort: don't fail sign-out if Keycloak revocation errors
    }

    const browserLogoutParams = new URLSearchParams({
      client_id: browserClientId,
      post_logout_redirect_uri: safeRedirect,
    });
    if (idToken) {
      browserLogoutParams.set('id_token_hint', idToken);
    }
    const browserLogoutUrl =
      `${keycloakPublicUrl}/realms/master/protocol/openid-connect/logout?` +
      browserLogoutParams.toString();

    return { message: 'Logged out', logoutUrl: browserLogoutUrl };
  }

  async forgotPassword(email: string) {
    const emailNorm = this.normalizeEmail(email);
    let kcUser = await this.keycloak.findPlatformUserByEmail(emailNorm);

    if (!kcUser) {
      // No user found by email in Keycloak
      return { message: 'If that email exists, a reset link has been sent.' };
    }

    if (!kcUser) {
      return { message: 'If that email exists, a reset link has been sent.' };
    }
    try {
      const methods = await this.keycloak.getPlatformUserSignInMethodsById(
        kcUser.id!,
        emailNorm,
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
      where: { email: emailNorm, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + AuthService.PASSWORD_RESET_TTL_MS);

    await this.prisma.passwordResetToken.create({
      data: { email: emailNorm, token, expiresAt },
    });

    const expiresInMinutes = Math.round(AuthService.PASSWORD_RESET_TTL_MS / 60_000);

    // Use the user's display name for the password reset email
    const dbUser = await this.prisma.user.findUnique({
      where: { email: emailNorm },
      select: { firstName: true, lastName: true, email: true },
    });
    const displayName = dbUser ? getDisplayName(dbUser) : emailNorm.split('@')[0];

    try {
      const emailResult = await this.email.sendPasswordResetLink(
        emailNorm,
        displayName,
        token,
        expiresInMinutes,
      );
      
      if (!emailResult) {
        this.logger.error(`[FORGOT_PASSWORD] Email sending failed for ${emailNorm} - Resend returned null`);
      } else {
        this.logger.log(`[FORGOT_PASSWORD] Password reset link sent successfully to ${emailNorm}`);
      }
    } catch (err) {
      this.logger.error(`[FORGOT_PASSWORD] Exception while sending email to ${emailNorm}: ${err.message}`, err.stack);
    }

    // Always return generic success message to prevent email enumeration
    return { message: 'If that email exists, a reset link has been sent.' };
  }

  /**
   * Public check so the reset-password page can hide the form for dead links
   * without revealing whether the token was invalid, used, or expired.
   */
  async verifyResetToken(token: string): Promise<{ valid: boolean }> {
    const trimmed = (token || '').trim();
    if (!trimmed || trimmed.length > 200) {
      return { valid: false };
    }
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { token: trimmed },
    });
    const valid = !!(
      row &&
      !row.usedAt &&
      row.expiresAt.getTime() >= Date.now()
    );
    return { valid };
  }

  async resetPassword(token: string, newPassword: string) {
    const trimmed = (token || '').trim();
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { token: trimmed },
    });

    const usable =
      !!resetToken &&
      !resetToken.usedAt &&
      resetToken.expiresAt.getTime() >= Date.now();

    if (!usable || !resetToken) {
      throw new BadRequestException(AuthService.RESET_LINK_INVALID);
    }

    this.ensureStrongPassword(newPassword);

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
      forcePasswordChange = await this.keycloak.getPlatformUserForcePasswordChangeById(
        userId,
        user.email,
      );
    } catch {
      authProvider = 'local';
      signOnMethod = 'local';
      forcePasswordChange = false;
    }

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      githubUsername: user.githubUsername,
      notifySignIn: user.notifySignIn,
      notifySignInNewDevice: user.notifySignInNewDevice,
      notifyTeamInvite: user.notifyTeamInvite,
      notifyBrowserPush: user.notifyBrowserPush,
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
      firstName?: string;
      lastName?: string;
      email?: string;
      githubUsername?: string;
      avatarUrl?: string;
      notifySignIn?: boolean;
      notifySignInNewDevice?: boolean;
      notifyTeamInvite?: boolean;
      notifyBrowserPush?: boolean;
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
      forcePasswordChange = await this.keycloak.getPlatformUserForcePasswordChangeById(
        userId,
        data.email,
      );
    } catch {
      authProvider = 'local';
      signOnMethod = 'local';
      forcePasswordChange = false;
    }
    const changingIdentityFields = data.email !== undefined;
    if (authProvider !== 'local' && changingIdentityFields && !data.allowIdentityEdit) {
      throw new BadRequestException(
        `This account uses ${authProvider} sign-in. Use "Enable identity edits" first.`,
      );
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

    if (data.notifySignInNewDevice !== undefined) {
      updateData.notifySignInNewDevice = data.notifySignInNewDevice;
    }

    if (data.notifyTeamInvite !== undefined) {
      updateData.notifyTeamInvite = data.notifyTeamInvite;
    }

    if (data.notifyBrowserPush !== undefined) {
      updateData.notifyBrowserPush = data.notifyBrowserPush;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    return {
      id: user.id,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      avatarUrl: user.avatarUrl,
      githubUsername: user.githubUsername,
      notifySignIn: user.notifySignIn,
      notifySignInNewDevice: user.notifySignInNewDevice,
      notifyTeamInvite: user.notifyTeamInvite,
      notifyBrowserPush: user.notifyBrowserPush,
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

  async listManagementUsersPage(opts: { page: number; pageSize: number; q?: string }) {
    const page = Math.max(1, Math.floor(opts.page));
    const pageSize = Math.min(100, Math.max(1, Math.floor(opts.pageSize)));
    const skip = (page - 1) * pageSize;
    const rawQ = opts.q?.trim();
    const where =
      rawQ && rawQ.length > 0
        ? {
            OR: [
              { email: { contains: rawQ, mode: 'insensitive' as const } },
              { firstName: { contains: rawQ, mode: 'insensitive' as const } },
              { lastName: { contains: rawQ, mode: 'insensitive' as const } },
            ],
          }
        : {};

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: pageSize,
        select: {
          id: true,
          email: true,
          firstName: true,
          lastName: true,
          role: true,
          createdAt: true,
          _count: {
            select: { teamMembers: true },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    // Lock state lives in loginSecurityState (keyed by email), separate from the
    // user row — fetch it for this page so ROOT can see/clear locked accounts.
    const emails = users.map((u) => u.email);
    const securityStates = emails.length
      ? await this.prisma.loginSecurityState.findMany({
          where: { email: { in: emails } },
          select: { email: true, lockedUntil: true },
        })
      : [];
    const lockUntilByEmail = new Map(
      securityStates.map((s) => [s.email, s.lockedUntil]),
    );

    const enriched = await Promise.all(
      users.map(async (u) => {
        const lockedUntil = lockUntilByEmail.get(u.email) ?? null;
        try {
          const snap = await this.keycloak.getPlatformUserManagementSnapshotById(u.id, u.email);
          return {
            ...u,
            lockedUntil,
            isActive: snap.isActive,
            authProvider: snap.authProvider,
            signOnMethod: snap.signOnMethod,
            linkedProviders: snap.linkedProviders,
            hasPasswordAuth: snap.hasPasswordAuth,
          };
        } catch {
          return {
            ...u,
            lockedUntil,
            isActive: true,
            authProvider: 'local' as const,
            signOnMethod: 'local' as const,
            linkedProviders: [] as Array<'google' | 'github'>,
            hasPasswordAuth: true,
          };
        }
      }),
    );

    return { users: enriched, total };
  }

  /**
   * Clear a failed-login lockout so the user can sign in immediately, instead
   * of waiting out the 30-minute window. ROOT/management action.
   */
  async unlockManagementUserAccount(targetUserId: string) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetUserId },
      select: { email: true },
    });
    if (!target) throw new NotFoundException('User not found');

    // updateMany is a no-op (not an error) when the user never had a security
    // row, so this is safe whether or not they were actually locked.
    await this.prisma.loginSecurityState.updateMany({
      where: { email: target.email },
      data: { failedAttempts: 0, consecutiveFailed: 0, lockedUntil: null },
    });

    // Also clear Keycloak's own brute-force lock — otherwise the account stays
    // locked at the auth layer and logins fail with "incorrect" credentials.
    await this.keycloak.clearBruteForceLock(targetUserId);

    this.logger.log(`Login lock cleared for ${target.email} (${targetUserId})`);
    return { unlocked: true };
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
      select: { id: true, email: true },
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

    // A password reset must fully restore the ability to log in: clear our own
    // failed-attempt counters (which also drive the login captcha) and any
    // lock window, so the user isn't blocked by a leftover captcha/lock right
    // after the reset. (Keycloak's brute-force lock is cleared inside
    // resetPlatformUserPasswordWithPolicy.)
    await this.prisma.loginSecurityState.updateMany({
      where: { email: target.email },
      data: { failedAttempts: 0, consecutiveFailed: 0, lockedUntil: null },
    });

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
                email: true,
                firstName: true,
                lastName: true,
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
      select: { id: true, email: true },
    });
    if (!target) {
      throw new BadRequestException('User not found');
    }
    await this.keycloak.setPlatformUserEnabledById(targetUserId, isActive);
    return { id: target.id, email: target.email, isActive };
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
