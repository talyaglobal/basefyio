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

describe('ProjectAuthConfigService.update token lifetime', () => {
  const row = { tokenExpirySeconds: 1800 };
  const prisma: any = {
    projectAuthConfig: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...row, ...data })),
    },
  };
  const svc = new ProjectAuthConfigService(prisma, { append: jest.fn() } as any);

  it.each([-5, 0, 10, 299, 99999999, 1.5, 'abc', null])('rejects %p', async (v) => {
    await expect(svc.update('p', { tokenExpirySeconds: v })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the bounds and stores a number', async () => {
    await svc.update('p', { tokenExpirySeconds: '300' });
    expect(prisma.projectAuthConfig.update.mock.calls.pop()[0].data.tokenExpirySeconds).toBe(300);
    await svc.update('p', { tokenExpirySeconds: 2592000 });
  });
});

describe('ProjectAuthConfigService.update password length', () => {
  const row = { minPasswordLength: 6 };
  const prisma: any = {
    projectAuthConfig: {
      findUnique: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...row, ...data })),
    },
  };
  const svc = new ProjectAuthConfigService(prisma, { append: jest.fn() } as any);

  it.each([0, 1, 5, 129, 'abc', null])('rejects %p', async (v) => {
    await expect(svc.update('p', { minPasswordLength: v })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts 128', async () => {
    await svc.update('p', { minPasswordLength: 128 });
    expect(prisma.projectAuthConfig.update.mock.calls.pop()[0].data.minPasswordLength).toBe(128);
  });
});
