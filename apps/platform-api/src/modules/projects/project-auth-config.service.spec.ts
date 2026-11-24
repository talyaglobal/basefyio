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

  it.each([-5, 10, 299, 2_000_000_001, 1.5, 'abc'])('rejects %p', async (v) => {
    await expect(svc.update('p', { tokenExpirySeconds: v })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts 300 and more, with no 30-day cap', async () => {
    await svc.update('p', { tokenExpirySeconds: '300' });
    expect(prisma.projectAuthConfig.update.mock.calls.pop()[0].data.tokenExpirySeconds).toBe(300);
    await svc.update('p', { tokenExpirySeconds: 99_999_999 });
    expect(prisma.projectAuthConfig.update.mock.calls.pop()[0].data.tokenExpirySeconds).toBe(99_999_999);
  });

  it.each([null, '', 0])('stores %p as 0: signed in until sign-out', async (v) => {
    await svc.update('p', { tokenExpirySeconds: v });
    expect(prisma.projectAuthConfig.update.mock.calls.pop()[0].data.tokenExpirySeconds).toBe(0);
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
