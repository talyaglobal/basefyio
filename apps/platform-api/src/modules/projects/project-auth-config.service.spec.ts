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

describe('ProjectAuthConfigService.update tsmartsend', () => {
  const makeSvc = (row: Record<string, any>) => {
    const prisma: any = {
      projectAuthConfig: {
        findUnique: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...row, ...data })),
      },
    };
    return { prisma, svc: new ProjectAuthConfigService(prisma, { append: jest.fn() } as any) };
  };

  it('needs a key the first time', async () => {
    const { svc } = makeSvc({ tsmartsendApiKey: null, senderEmail: 'a@b.test' });
    await expect(svc.update('p', { emailProvider: 'tsmartsend' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('needs a sender address of the project', async () => {
    const { svc } = makeSvc({ tsmartsendApiKey: 'saved', senderEmail: null });
    await expect(svc.update('p', { emailProvider: 'tsmartsend' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a key that does not start with ts_', async () => {
    const { svc } = makeSvc({ tsmartsendApiKey: null, senderEmail: 'a@b.test' });
    await expect(svc.update('p', { emailProvider: 'tsmartsend', tsmartsendApiKey: 're_12345678' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stores a valid key encrypted and returns it masked', async () => {
    const { svc, prisma } = makeSvc({ tsmartsendApiKey: null, senderEmail: 'a@b.test' });
    const before = process.env.DB_CRED_ENC_KEY;
    process.env.DB_CRED_ENC_KEY = '0'.repeat(64);
    jest.resetModules();
    let out: any;
    try {
      out = await svc.update('p', { emailProvider: 'tsmartsend', tsmartsendApiKey: 'ts_abcdefgh1234' });
    } finally {
      if (before === undefined) delete process.env.DB_CRED_ENC_KEY; else process.env.DB_CRED_ENC_KEY = before;
    }
    expect(prisma.projectAuthConfig.update.mock.calls[0][0].data.tsmartsendApiKey).toMatch(/^enc:v1:/);
    expect(out.tsmartsendApiKey).toBe('••••••••');
  });

  it('keeps the saved key when only the sender changes', async () => {
    const { svc, prisma } = makeSvc({ tsmartsendApiKey: 'saved' });
    await svc.update('p', { emailProvider: 'tsmartsend', senderEmail: 'a@b.test' });
    expect(prisma.projectAuthConfig.update.mock.calls[0][0].data).not.toHaveProperty('tsmartsendApiKey');
  });

  it('drops the key when the project goes back to the platform default or sends its own mail', async () => {
    const { svc, prisma } = makeSvc({ tsmartsendApiKey: 'saved' });
    await svc.update('p', { emailProvider: null });
    expect(prisma.projectAuthConfig.update.mock.calls.pop()[0].data.tsmartsendApiKey).toBeNull();
    await svc.update('p', { emailProvider: 'none' });
    expect(prisma.projectAuthConfig.update.mock.calls.pop()[0].data.tsmartsendApiKey).toBeNull();
  });
});
