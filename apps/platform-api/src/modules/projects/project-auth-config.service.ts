import { encryptField } from '../../common/crypto/field-crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { assertPasswordMinLength } from './project-auth-limits';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';

const TEMPLATE_FIELDS = [
  'verifyEmailSubject', 'verifyEmailBody',
  'resetPasswordSubject', 'resetPasswordBody',
  'welcomeSubject', 'welcomeBody',
  'inviteUserSubject', 'inviteUserBody',
  'magicLinkSubject', 'magicLinkBody',
  'changeEmailSubject', 'changeEmailBody',
  'reauthSubject', 'reauthBody',
] as const;

/** Access token lifetime bounds in seconds (5 minutes to 30 days). */
const TOKEN_EXPIRY_MIN = 300;
/** Keycloak keeps lifetimes in 32-bit seconds. */
const TOKEN_EXPIRY_MAX = 2_000_000_000;

const DEFAULT_CONFIG = {
  allowSignup: true,
  requireEmailVerify: true,
  minPasswordLength: 6,
  tokenExpirySeconds: 1800,
  smtpHost: null,
  smtpPort: null,
  smtpUser: null,
  smtpPass: null,
  senderEmail: null,
  senderName: null,
};

@Injectable()
export class ProjectAuthConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ProjectActivityService,
  ) {}

  async getOrCreate(projectId: string) {
    const existing = await this.prisma.projectAuthConfig.findUnique({
      where: { projectId },
    });
    if (existing) return this.sanitize(existing);

    const created = await this.prisma.projectAuthConfig.create({
      data: { projectId, ...DEFAULT_CONFIG },
    });
    return this.sanitize(created);
  }

  async update(
    projectId: string,
    data: Record<string, any>,
    userId?: string,
  ) {
    await this.getOrCreate(projectId);

    if (data.minPasswordLength !== undefined) {
      data = { ...data, minPasswordLength: assertPasswordMinLength(data.minPasswordLength) };
    }

    if (data.tokenExpirySeconds !== undefined) {
      // null, '' or 0: users stay signed in until they sign out (stored as 0).
      const raw = data.tokenExpirySeconds;
      const n = raw === null || raw === '' ? 0 : Number(raw);
      if (!Number.isInteger(n) || (n !== 0 && (n < TOKEN_EXPIRY_MIN || n > TOKEN_EXPIRY_MAX))) {
        throw new BadRequestException(
          `tokenExpirySeconds must be empty or 0 (signed in until sign-out), or a whole number from ${TOKEN_EXPIRY_MIN}`,
        );
      }
      data = { ...data, tokenExpirySeconds: n };
    }

    if (data.emailProvider === 'smtp') {
      const cur: Record<string, any> = await this.getRaw(projectId);
      const has = (k: string) => (k in data ? data[k] : cur[k]);
      if (!String(has('smtpHost') ?? '').trim() || !String(has('smtpUser') ?? '').trim() || !has('smtpPass')) {
        throw new BadRequestException('Custom SMTP needs a host, username and password');
      }
    } else if (data.emailProvider === 'tsmartsend') {
      const cur: Record<string, any> = await this.getRaw(projectId);
      const sender = 'senderEmail' in data ? data.senderEmail : cur.senderEmail;
      if (!String(sender ?? '').trim()) {
        // tsmartsend refuses mail from a domain that is not verified in the project, so the platform's
        // fallback sender (noreply@basefyio.com) can never work: the project must name its own address.
        throw new BadRequestException('tsmartsend needs a sender address on a domain verified in your tsmartsend project');
      }
      const incoming = typeof data.tsmartsendApiKey === 'string' ? data.tsmartsendApiKey.trim() : '';
      if (incoming) {
        if (!/^ts_[A-Za-z0-9_-]{8,}$/.test(incoming)) {
          throw new BadRequestException('A tsmartsend API key starts with "ts_"');
        }
        data = { ...data, tsmartsendApiKey: encryptField(incoming) };
      } else if (!cur.tsmartsendApiKey) {
        throw new BadRequestException('tsmartsend needs an API key (it starts with "ts_")');
      } else {
        const { tsmartsendApiKey: _unchanged, ...rest } = data;
        data = rest;
      }
    } else if (data.emailProvider === 'none') {
      // The project's app sends every auth mail; stored credentials are dropped so nothing falls back to them.
      data = { ...data, smtpHost: null, smtpUser: null, smtpPass: null, tsmartsendApiKey: null };
    } else if (data.emailProvider === null || data.emailProvider === '') {
      // Back to the platform default: drop the SMTP settings so they are not used as a fallback.
      data = { ...data, emailProvider: null, smtpHost: null, smtpUser: null, smtpPass: null, tsmartsendApiKey: null };
    }

    const updated = await this.prisma.projectAuthConfig.update({
      where: { projectId },
      data,
    });

    const keys = Object.keys(data).filter((k) => !k.endsWith('Pass') && !k.endsWith('Secret') && !k.endsWith('ApiKey'));
    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.AUTH_CONFIG_UPDATED,
      title: 'Auth / email configuration updated',
      detail: keys.length ? `Fields: ${keys.slice(0, 20).join(', ')}` : undefined,
      metadata: { keys },
    });

    return this.sanitize(updated);
  }

  async getRaw(projectId: string) {
    const existing = await this.prisma.projectAuthConfig.findUnique({
      where: { projectId },
    });
    if (existing) return existing;

    return this.prisma.projectAuthConfig.create({
      data: { projectId, ...DEFAULT_CONFIG },
    });
  }

  private sanitize(config: any) {
    const result: Record<string, any> = {
      allowSignup: config.allowSignup,
      requireEmailVerify: config.requireEmailVerify,
      minPasswordLength: config.minPasswordLength,
      tokenExpirySeconds: config.tokenExpirySeconds,
      emailProvider: config.emailProvider ?? null,
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpUser: config.smtpUser,
      smtpPass: config.smtpPass ? '••••••••' : null,
      senderEmail: config.senderEmail,
      senderName: config.senderName,
      resendApiKey: config.resendApiKey ? '••••••••' : null,
      tsmartsendApiKey: config.tsmartsendApiKey ? '••••••••' : null,
      sendgridApiKey: config.sendgridApiKey ? '••••••••' : null,
      sesAccessKey: config.sesAccessKey ? '••••••••' : null,
      sesSecretKey: config.sesSecretKey ? '••••••••' : null,
      sesRegion: config.sesRegion ?? null,
    };

    for (const field of TEMPLATE_FIELDS) {
      result[field] = config[field] ?? null;
    }

    result.redirectUrls = Array.isArray(config.redirectUrls) ? config.redirectUrls : [];
    result.googleEnabled = config.googleEnabled ?? false;
    result.googleClientId = config.googleClientId ?? null;
    result.googleClientSecret = config.googleClientSecret ? '••••••••' : null;
    result.githubEnabled = config.githubEnabled ?? false;
    result.githubClientId = config.githubClientId ?? null;
    result.githubClientSecret = config.githubClientSecret ? '••••••••' : null;
    result.microsoftEnabled = config.microsoftEnabled ?? false;
    result.microsoftClientId = config.microsoftClientId ?? null;
    result.microsoftClientSecret = config.microsoftClientSecret ? '••••••••' : null;
    result.appleEnabled = config.appleEnabled ?? false;
    result.appleClientId = config.appleClientId ?? null;
    result.appleClientSecret = config.appleClientSecret ? '••••••••' : null;
    result.gitlabEnabled = config.gitlabEnabled ?? false;
    result.gitlabClientId = config.gitlabClientId ?? null;
    result.gitlabClientSecret = config.gitlabClientSecret ? '••••••••' : null;
    result.linkedinEnabled = config.linkedinEnabled ?? false;
    result.linkedinClientId = config.linkedinClientId ?? null;
    result.linkedinClientSecret = config.linkedinClientSecret ? '••••••••' : null;
    result.facebookEnabled = config.facebookEnabled ?? false;
    result.facebookClientId = config.facebookClientId ?? null;
    result.facebookClientSecret = config.facebookClientSecret ? '••••••••' : null;
    result.twitterEnabled = config.twitterEnabled ?? false;
    result.twitterClientId = config.twitterClientId ?? null;
    result.twitterClientSecret = config.twitterClientSecret ? '••••••••' : null;
    result.allowAnonymous = config.allowAnonymous ?? false;
    result.mfaEnforceEnrollment = config.mfaEnforceEnrollment ?? false;

    return result;
  }
}
