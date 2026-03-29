import { Injectable } from '@nestjs/common';
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
      sendgridApiKey: config.sendgridApiKey ? '••••••••' : null,
      sesAccessKey: config.sesAccessKey ? '••••••••' : null,
      sesSecretKey: config.sesSecretKey ? '••••••••' : null,
      sesRegion: config.sesRegion ?? null,
    };

    for (const field of TEMPLATE_FIELDS) {
      result[field] = config[field] ?? null;
    }

    result.googleEnabled = config.googleEnabled ?? false;
    result.googleClientId = config.googleClientId ?? null;
    result.googleClientSecret = config.googleClientSecret ? '••••••••' : null;
    result.githubEnabled = config.githubEnabled ?? false;
    result.githubClientId = config.githubClientId ?? null;
    result.githubClientSecret = config.githubClientSecret ? '••••••••' : null;

    return result;
  }
}
