import { BadRequestException, NotFoundException } from '@nestjs/common';

jest.mock('./projects.service', () => ({ ProjectsService: class {} }));
jest.mock('../auth/keycloak-admin.service', () => ({ KeycloakAdminService: class {} }));
jest.mock('../email/email.service', () => ({ EmailService: class {} }));
jest.mock('./project-auth-config.service', () => ({ ProjectAuthConfigService: class {} }));
jest.mock('./project-mfa.service', () => ({ ProjectMfaService: class {} }));
jest.mock('./project-activity.service', () => ({
  ProjectActivityService: class {},
  ProjectActivityKind: new Proxy({}, { get: (_t, k) => String(k) }),
}));

const sendMail = jest.fn();
const verify = jest.fn();
const close = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail, verify, close })),
}));

import { ProjectAuthController } from './project-auth.controller';

function build(overrides: { policy?: string; cfg?: Record<string, any> } = {}) {
  const project = { id: 'p1', name: 'Shop', keycloakRealm: 'bf-shop' };
  const cfg = {
    minPasswordLength: 6,
    tokenExpirySeconds: 1800,
    emailProvider: null,
    smtpHost: null,
    smtpPort: null,
    smtpUser: null,
    smtpPass: null,
    senderEmail: null,
    ...overrides.cfg,
  };
  const keycloak = {
    getRealmPolicies: jest.fn().mockResolvedValue({
      bruteForceProtected: false,
      permanentLockout: false,
      failureFactor: 30,
      waitIncrementSeconds: 60,
      maxFailureWaitSeconds: 900,
      passwordPolicy: overrides.policy ?? '',
      accessTokenLifespan: 1800,
    }),
    updateRealmPolicies: jest.fn().mockResolvedValue({}),
    getRealmUserById: jest.fn(),
    listUserFederatedIdentities: jest.fn().mockResolvedValue([]),
    listUserSessions: jest.fn().mockResolvedValue([]),
    userHasOtpCredential: jest.fn().mockResolvedValue(false),
    findUserInRealm: jest.fn().mockResolvedValue(null),
    createUser: jest.fn().mockResolvedValue({ message: 'User created in realm' }),
    updateRealmUser: jest.fn().mockResolvedValue(undefined),
    ensureNamesOptional: jest.fn().mockResolvedValue(true),
    resetRealmUserPassword: jest.fn().mockResolvedValue(undefined),
    listUsers: jest.fn().mockResolvedValue([]),
    countUsers: jest.fn().mockResolvedValue(0),
  };
  const authConfigService = {
    getRaw: jest.fn().mockResolvedValue(cfg),
    validateUpdate: jest.fn(async (_id: string, body: Record<string, any>) => {
      const { prepareAuthConfigUpdate } = jest.requireActual('./project-auth-validation');
      return { prepared: prepareAuthConfigUpdate(body, cfg), stored: cfg };
    }),
    update: jest.fn(async (_id: string, data: Record<string, any>) => ({ ...cfg, ...data })),
    mirrorRealmSettings: jest.fn().mockResolvedValue(undefined),
  };
  const projectsService = { findOne: jest.fn().mockResolvedValue(project) };
  const activity = { append: jest.fn().mockResolvedValue(undefined) };
  const mfa = {
    status: jest.fn().mockResolvedValue({ enrolled: false, enrollmentRequired: false }),
    listEnrollmentRequired: jest.fn().mockResolvedValue([]),
    setEnrollmentRequired: jest.fn(),
    forgetUser: jest.fn(),
  };
  const email = { sendRawHtml: jest.fn().mockResolvedValue({ data: { id: 'm1' } }) };
  const controller = new ProjectAuthController(
    projectsService as any,
    keycloak as any,
    authConfigService as any,
    { get: jest.fn() } as any,
    activity as any,
    mfa as any,
    email as any,
  );
  return { controller, keycloak, authConfigService, mfa, email, activity };
}

const operator = { sub: 'u1', email: 'owner@example.com' } as any;

describe('ProjectAuthController', () => {
  beforeEach(() => {
    sendMail.mockReset();
    verify.mockReset();
    close.mockReset();
  });

  it('answers 404 (not 400) for a user that no longer exists', async () => {
    const { controller, keycloak } = build();
    keycloak.getRealmUserById.mockResolvedValue(null);
    await expect(controller.getUser('p1', 'gone', operator)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reports MFA enrollment state on the user detail', async () => {
    const { controller, keycloak, mfa } = build();
    keycloak.getRealmUserById.mockResolvedValue({ id: 'k1', email: 'a@example.com', requiredActions: [] });
    mfa.status.mockResolvedValue({ enrolled: false, enrollmentRequired: true });
    const detail = await controller.getUser('p1', 'k1', operator);
    expect(detail.mfa).toEqual({ enrollmentRequired: true, enrolled: false });
  });

  describe('createUser', () => {
    it('refuses an address without a top-level domain', async () => {
      const { controller, keycloak } = build();
      await expect(
        controller.createUser('p1', { email: 'qa_e2e_bad@example', password: 'Secret123!' }, operator),
      ).rejects.toThrow(/not a valid email/);
      expect(keycloak.createUser).not.toHaveBeenCalled();
    });

    it('enforces the realm password policy', async () => {
      const { controller, keycloak } = build({ policy: 'length(8) and upperCase(1)' });
      await expect(
        controller.createUser('p1', { email: 'a@example.com', password: '123456' }, operator),
      ).rejects.toThrow(/at least 8 characters, an uppercase letter/);
      expect(keycloak.createUser).not.toHaveBeenCalled();
    });

    it('leaves blank names blank instead of copying the email', async () => {
      const { controller, keycloak } = build();
      await controller.createUser('p1', { email: 'a@example.com', password: 'abcdef', firstName: ' ', lastName: '' }, operator);
      expect(keycloak.createUser).toHaveBeenCalledWith(
        'bf-shop',
        { email: 'a@example.com', password: 'abcdef', firstName: undefined, lastName: undefined },
        { allowEmptyNames: true },
      );
    });
  });

  describe('updateUser', () => {
    it('refuses a phone number that is not E.164', async () => {
      const { controller, keycloak } = build();
      await expect(controller.updateUser('p1', 'k1', { phoneNumber: 'abc-not-phone' }, operator)).rejects.toThrow(/E\.164/);
      expect(keycloak.updateRealmUser).not.toHaveBeenCalled();
    });

    it('stores a normalised phone number and only the fields sent', async () => {
      const { controller, keycloak } = build();
      await controller.updateUser('p1', 'k1', { phoneNumber: '+1 555 010 0100' }, operator);
      expect(keycloak.updateRealmUser).toHaveBeenCalledWith('bf-shop', 'k1', { phoneNumber: '+15550100100' });
    });
  });

  it('reset password follows the policy too', async () => {
    const { controller, keycloak } = build({ cfg: { minPasswordLength: 10 } });
    await expect(controller.resetUserPassword('p1', 'k1', { newPassword: 'short' }, operator)).rejects.toThrow(/at least 10/);
    expect(keycloak.resetRealmUserPassword).not.toHaveBeenCalled();
  });

  describe('policies', () => {
    it('shows one minimum length: the stricter of realm and config', async () => {
      const { controller } = build({ policy: '', cfg: { minPasswordLength: 6 } });
      const res = await controller.getPolicies('p1', operator);
      expect(res.password.minLength).toBe(6);
      expect(res.accessTokenLifespanSeconds).toBe(1800);
    });

    it('refuses 99999 and writes nothing', async () => {
      const { controller, keycloak } = build();
      await expect(controller.updatePolicies('p1', { password: { minLength: 99999 } }, operator)).rejects.toBeInstanceOf(BadRequestException);
      expect(keycloak.updateRealmPolicies).not.toHaveBeenCalled();
    });

    it('writes the realm and mirrors the length into the project config', async () => {
      const { controller, keycloak, authConfigService } = build({ policy: 'length(8) and notUsername(undefined)' });
      await controller.updatePolicies(
        'p1',
        { bruteForceProtected: true, accessTokenLifespanSeconds: 3600, password: { minLength: 12, requireDigits: true } },
        operator,
      );
      expect(keycloak.updateRealmPolicies).toHaveBeenCalledWith('bf-shop', {
        bruteForceProtected: true,
        accessTokenLifespan: 3600,
        passwordPolicy: 'length(12) and digits(1) and notUsername(undefined)',
      });
      expect(authConfigService.mirrorRealmSettings).toHaveBeenCalledWith('p1', { minPasswordLength: 12, tokenExpirySeconds: 3600 });
    });
  });

  describe('updateConfig', () => {
    it('applies a changed token lifetime and minimum length to the realm', async () => {
      const { controller, keycloak, authConfigService } = build({ policy: 'length(6)' });
      await controller.updateConfig('p1', { tokenExpirySeconds: 3600, minPasswordLength: 8 }, operator);
      expect(keycloak.updateRealmPolicies).toHaveBeenCalledWith('bf-shop', {
        passwordPolicy: 'length(8)',
        accessTokenLifespan: 3600,
      });
      expect(authConfigService.update).toHaveBeenCalled();
    });

    it('does not touch the realm when those values did not change', async () => {
      const { controller, keycloak } = build();
      await controller.updateConfig('p1', { allowSignup: false, tokenExpirySeconds: 1800 }, operator);
      expect(keycloak.updateRealmPolicies).not.toHaveBeenCalled();
    });

    it('refuses an empty custom SMTP provider', async () => {
      const { controller, authConfigService } = build();
      await expect(
        controller.updateConfig('p1', { emailProvider: 'smtp', smtpHost: null, smtpUser: null }, operator),
      ).rejects.toThrow(/SMTP host is required/);
      expect(authConfigService.update).not.toHaveBeenCalled();
    });
  });

  describe('test email', () => {
    it('sends through the platform only to the operator', async () => {
      const { controller, email } = build();
      await expect(
        controller.testEmailSettings('p1', { to: 'stranger@example.com' }, operator),
      ).rejects.toThrow(/your own address/);
      const res = await controller.testEmailSettings('p1', {}, operator);
      expect(res).toEqual({ ok: true, provider: 'platform', to: 'owner@example.com' });
      expect(email.sendRawHtml).toHaveBeenCalledWith('owner@example.com', expect.stringContaining('Test email'), expect.any(String));
    });

    it('tries unsaved SMTP settings and reports a login failure in the body', async () => {
      const { controller } = build({ cfg: { smtpPass: 'saved-pass' } });
      verify.mockRejectedValue(Object.assign(new Error('Invalid login'), { code: 'EAUTH', response: '535 auth failed' }));
      const res = await controller.testEmailSettings(
        'p1',
        {
          to: 'qa@example.com',
          settings: { emailProvider: 'smtp', smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'mailer', smtpPass: '', senderEmail: 'no-reply@example.com' },
        },
        operator,
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/rejected the username or password/);
      expect(sendMail).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalled();
    });

    it('sends with working SMTP settings', async () => {
      const { controller } = build();
      verify.mockResolvedValue(true);
      sendMail.mockResolvedValue({ messageId: 'x' });
      const res = await controller.testEmailSettings(
        'p1',
        {
          to: 'qa@example.com',
          settings: { emailProvider: 'smtp', smtpHost: 'smtp.example.com', smtpPort: 465, smtpUser: 'mailer', smtpPass: 'pw', senderEmail: 'no-reply@example.com', senderName: 'Shop' },
        },
        operator,
      );
      expect(res).toEqual({ ok: true, provider: 'smtp', to: 'qa@example.com' });
      expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'Shop <no-reply@example.com>', to: 'qa@example.com' }));
    });
  });
});
