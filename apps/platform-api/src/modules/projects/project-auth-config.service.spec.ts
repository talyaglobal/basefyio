import { BadRequestException } from '@nestjs/common';
import { ProjectAuthConfigService } from './project-auth-config.service';

describe('ProjectAuthConfigService.update email provider', () => {
  const row = { smtpHost: null, smtpUser: null, smtpPass: null };
  const prisma: any = {
    projectAuthConfig: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...row, ...data })),
    },
  };
  const svc = new ProjectAuthConfigService(prisma, { append: jest.fn() } as any);

  it('rejects Custom SMTP without host, user and password', async () => {
    await expect(svc.update('p', { emailProvider: 'smtp', smtpHost: null })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clears the SMTP settings when going back to the platform default', async () => {
    await svc.update('p', { emailProvider: null });
    expect(prisma.projectAuthConfig.update.mock.calls[0][0].data).toMatchObject({ emailProvider: null, smtpHost: null, smtpPass: null });
  });
});
