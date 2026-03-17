import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

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
  constructor(private readonly prisma: PrismaService) {}

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

  async update(projectId: string, data: Record<string, any>) {
    await this.getOrCreate(projectId);

    const updated = await this.prisma.projectAuthConfig.update({
      where: { projectId },
      data,
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
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpUser: config.smtpUser,
      smtpPass: config.smtpPass ? '••••••••' : null,
      senderEmail: config.senderEmail,
      senderName: config.senderName,
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
