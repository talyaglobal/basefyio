import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';
import { prepareAuthConfigUpdate } from './project-auth-validation';

const TEMPLATE_FIELDS = [
  'verifyEmailSubject', 'verifyEmailBody',
  'resetPasswordSubject', 'resetPasswordBody',
  'welcomeSubject', 'welcomeBody',
  'inviteUserSubject', 'inviteUserBody',
  'magicLinkSubject', 'magicLinkBody',
  'changeEmailSubject', 'changeEmailBody',
  'reauthSubject', 'reauthBody',
] as const;

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

  /**
   * Check a PUT body against the stored row without writing anything, so a
   * caller can act on the result (e.g. mirror a setting into Keycloak) before
   * the row changes. Throws a 400 describing every problem.
   */
  async validateUpdate(projectId: string, data: Record<string, any>) {
    const stored = await this.getRaw(projectId);
    return { prepared: prepareAuthConfigUpdate(data, stored), stored };
  }

  async update(
    projectId: string,
    data: Record<string, any>,
    userId?: string,
  ) {
    const { prepared } = await this.validateUpdate(projectId, data);
    data = prepared;

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

  /**
   * Keep the copies of realm settings this row holds (minimum password length,
   * token lifetime) equal to what was just written to Keycloak. No activity
   * entry: the caller logs the change it made.
   */
  async mirrorRealmSettings(
    projectId: string,
    data: { minPasswordLength?: number; tokenExpirySeconds?: number },
  ) {
    await this.getRaw(projectId);
    await this.prisma.projectAuthConfig.update({ where: { projectId }, data });
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
