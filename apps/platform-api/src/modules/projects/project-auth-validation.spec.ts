import { BadRequestException } from '@nestjs/common';
import {
  assertPasswordMeetsPolicy,
  effectiveMinLength,
  isValidEmail,
  mergePasswordPolicy,
  normalizePersonName,
  normalizePhoneNumber,
  parsePasswordPolicy,
  passwordViolations,
  prepareAuthConfigUpdate,
  validatePolicyUpdate,
} from './project-auth-validation';
import { describeSmtpFailure, projectFromAddress, resolveProjectSmtp } from './project-email-transport';

describe('project auth validation', () => {
  describe('isValidEmail', () => {
    it('needs a domain with a top-level part', () => {
      expect(isValidEmail('qa@example.com')).toBe(true);
      expect(isValidEmail('first.last+tag@sub.example.co')).toBe(true);
      expect(isValidEmail('qa_e2e_bad@example')).toBe(false);
      expect(isValidEmail('no-at-sign')).toBe(false);
      expect(isValidEmail('a b@example.com')).toBe(false);
      expect(isValidEmail('a@example.c')).toBe(false);
      expect(isValidEmail(undefined)).toBe(false);
    });
  });

  describe('normalizePhoneNumber', () => {
    it('accepts E.164 after dropping separators', () => {
      expect(normalizePhoneNumber('+1 (555) 010-0100')).toBe('+15550100100');
      expect(normalizePhoneNumber('+905551112233')).toBe('+905551112233');
    });
    it('clears on empty', () => {
      expect(normalizePhoneNumber('')).toBeNull();
      expect(normalizePhoneNumber('  ')).toBeNull();
      expect(normalizePhoneNumber(null)).toBeNull();
    });
    it('refuses text and numbers without a country code', () => {
      expect(() => normalizePhoneNumber('abc-not-phone')).toThrow(BadRequestException);
      expect(() => normalizePhoneNumber('5551112233')).toThrow(/E\.164/);
      expect(() => normalizePhoneNumber('+0123456789')).toThrow(BadRequestException);
    });
  });

  it('normalizePersonName trims and turns blanks into null', () => {
    expect(normalizePersonName('  Ada ', 'First name')).toBe('Ada');
    expect(normalizePersonName('', 'First name')).toBeNull();
    expect(() => normalizePersonName('x'.repeat(256), 'First name')).toThrow(/255/);
  });

  describe('password policy strings', () => {
    it('round-trips the managed parts', () => {
      const rules = parsePasswordPolicy('length(10) and upperCase(1) and digits(1) and passwordHistory(3)');
      expect(rules).toEqual({
        minLength: 10,
        requireUppercase: true,
        requireLowercase: false,
        requireDigits: true,
        requireSpecial: false,
        historyCount: 3,
        expiryDays: 0,
      });
    });

    it('does not read maxLength as the minimum', () => {
      expect(parsePasswordPolicy('maxLength(64) and length(8)').minLength).toBe(8);
      expect(parsePasswordPolicy('maxLength(64)').minLength).toBe(0);
    });

    it('keeps policy parts the dashboard does not manage', () => {
      const merged = mergePasswordPolicy('length(8) and notUsername(undefined) and maxLength(64)', {
        minLength: 12,
        requireDigits: true,
      });
      expect(merged).toBe('length(12) and digits(1) and notUsername(undefined) and maxLength(64)');
    });

    it('changes only the given rule', () => {
      expect(mergePasswordPolicy('length(8) and upperCase(1)', { minLength: 10 })).toBe('length(10) and upperCase(1)');
      expect(mergePasswordPolicy('', { minLength: 6 })).toBe('length(6)');
    });

    it('effective minimum is the stricter of config and realm', () => {
      expect(effectiveMinLength(6, '')).toBe(6);
      expect(effectiveMinLength(6, 'length(12)')).toBe(12);
      expect(effectiveMinLength(10, 'length(8)')).toBe(10);
    });
  });

  describe('passwords against a policy', () => {
    const rules = { minLength: 8, requireUppercase: true, requireLowercase: true, requireDigits: true, requireSpecial: false };
    it('lists every missing rule', () => {
      expect(passwordViolations('123456', rules)).toEqual(['at least 8 characters', 'an uppercase letter', 'a lowercase letter']);
      expect(passwordViolations('Abcdefg1', rules)).toEqual([]);
    });
    it('throws a 400 naming the rules', () => {
      expect(() => assertPasswordMeetsPolicy('123456', rules)).toThrow(/at least 8 characters, an uppercase letter/);
      expect(() => assertPasswordMeetsPolicy('', rules)).toThrow(/required/);
      expect(assertPasswordMeetsPolicy('Abcdefg1', rules)).toBe('Abcdefg1');
    });
  });

  describe('validatePolicyUpdate', () => {
    it('refuses an absurd minimum length instead of saving it', () => {
      expect(() => validatePolicyUpdate({ password: { minLength: 99999 } })).toThrow(/between 6 and 128/);
      expect(() => validatePolicyUpdate({ password: { minLength: 0 } })).toThrow(/between 6 and 128/);
      expect(() => validatePolicyUpdate({ password: { minLength: 7.5 } })).toThrow(/whole number/);
    });
    it('accepts a sane policy', () => {
      expect(
        validatePolicyUpdate({
          bruteForceProtected: true,
          failureFactor: 10,
          waitIncrementSeconds: 60,
          maxFailureWaitSeconds: 900,
          accessTokenLifespanSeconds: 3600,
          password: { minLength: 10, requireDigits: true, historyCount: 0, expiryDays: 0 },
        }),
      ).toEqual({
        bruteForceProtected: true,
        failureFactor: 10,
        waitIncrementSeconds: 60,
        maxFailureWaitSeconds: 900,
        accessTokenLifespanSeconds: 3600,
        password: { minLength: 10, requireDigits: true, historyCount: 0, expiryDays: 0 },
      });
    });
    it('checks the lockout and token values', () => {
      expect(() => validatePolicyUpdate({ failureFactor: 0 })).toThrow(/between 1 and 100/);
      expect(() => validatePolicyUpdate({ waitIncrementSeconds: 600, maxFailureWaitSeconds: 60 })).toThrow(/at least the wait increment/);
      expect(() => validatePolicyUpdate({ accessTokenLifespanSeconds: 0 })).toThrow(/between 300 and 86400/);
      expect(() => validatePolicyUpdate({ bruteForceProtected: 'yes' })).toThrow(/true or false/);
    });
  });

  describe('prepareAuthConfigUpdate', () => {
    const stored = {
      emailProvider: null,
      smtpHost: null,
      smtpPort: null,
      smtpUser: null,
      smtpPass: null,
      senderEmail: null,
      minPasswordLength: 6,
      tokenExpirySeconds: 1800,
    };

    it('refuses unknown and structural keys', () => {
      expect(() => prepareAuthConfigUpdate({ projectId: 'other' }, stored)).toThrow(/Unknown auth setting\(s\): projectId/);
      expect(() => prepareAuthConfigUpdate({ project: { update: {} } }, stored)).toThrow(/project/);
      expect(() => prepareAuthConfigUpdate({ id: 'x', bogus: 1 }, stored)).toThrow(/id, bogus/);
    });

    it('refuses out-of-range numbers instead of replacing them', () => {
      expect(() => prepareAuthConfigUpdate({ minPasswordLength: 1 }, stored)).toThrow(/between 6 and 128/);
      expect(() => prepareAuthConfigUpdate({ tokenExpirySeconds: 0 }, stored)).toThrow(/between 300 and 86400/);
      expect(prepareAuthConfigUpdate({ minPasswordLength: '8' }, stored)).toEqual({ minPasswordLength: 8 });
    });

    it('refuses a custom SMTP provider with empty fields', () => {
      expect(() =>
        prepareAuthConfigUpdate({ emailProvider: 'smtp', smtpHost: '', smtpPort: 587, smtpUser: null, senderEmail: null }, stored),
      ).toThrow(/SMTP host is required; SMTP username is required; SMTP password is required/);
    });

    it('accepts a complete SMTP provider and keeps the saved password when the field is empty', () => {
      const withPass = { ...stored, smtpPass: 'saved' };
      expect(
        prepareAuthConfigUpdate(
          { emailProvider: 'SMTP', smtpHost: ' smtp.example.com ', smtpPort: '587', smtpUser: 'mailer', smtpPass: '', senderEmail: 'no-reply@example.com' },
          withPass,
        ),
      ).toEqual({
        emailProvider: 'smtp',
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'mailer',
        senderEmail: 'no-reply@example.com',
      });
    });

    it('switching back to the platform default clears the SMTP fields', () => {
      const smtpStored = { ...stored, emailProvider: 'smtp', smtpHost: 'smtp.example.com', smtpPort: 587, smtpUser: 'u', smtpPass: 'p' };
      const data = prepareAuthConfigUpdate({ emailProvider: null, senderEmail: null }, smtpStored);
      expect(data).toEqual({
        emailProvider: null,
        senderEmail: null,
        smtpHost: null,
        smtpPort: null,
        smtpUser: null,
        smtpPass: null,
      });
      expect(resolveProjectSmtp({ ...smtpStored, ...data })).toBeNull();
    });

    it('needs the key of an API-key provider and a sender address', () => {
      expect(() => prepareAuthConfigUpdate({ emailProvider: 'resend', senderEmail: 'a@example.com' }, stored)).toThrow(/Resend API key/);
      expect(() => prepareAuthConfigUpdate({ emailProvider: 'resend', resendApiKey: 're_x' }, stored)).toThrow(/sender email is required/);
      expect(() => prepareAuthConfigUpdate({ emailProvider: 'postmark' }, stored)).toThrow(/Unknown email provider/);
      expect(() => prepareAuthConfigUpdate({ senderEmail: 'bad@host' }, stored)).toThrow(/not a valid address/);
    });

    it('leaves template-only updates alone', () => {
      expect(prepareAuthConfigUpdate({ verifyEmailSubject: 'Hi' }, { ...stored, emailProvider: 'smtp' })).toEqual({ verifyEmailSubject: 'Hi' });
    });
  });

  describe('email transport', () => {
    it('maps providers to SMTP endpoints', () => {
      expect(resolveProjectSmtp({ emailProvider: 'resend', resendApiKey: 'k' })).toEqual({ host: 'smtp.resend.com', port: 465, user: 'resend', pass: 'k' });
      expect(resolveProjectSmtp({ emailProvider: 'ses', sesAccessKey: 'a', sesSecretKey: 's', sesRegion: 'eu-west-1' })?.host).toBe('email-smtp.eu-west-1.amazonaws.com');
      expect(resolveProjectSmtp({ emailProvider: null, smtpHost: 'legacy.example.com' })?.host).toBe('legacy.example.com');
      expect(resolveProjectSmtp({ emailProvider: 'smtp', smtpHost: null })).toBeNull();
    });
    it('builds the From header', () => {
      expect(projectFromAddress({ senderEmail: 'a@example.com', senderName: 'App' }, 'Proj')).toBe('App <a@example.com>');
      expect(projectFromAddress({}, 'Proj')).toBe('Proj <noreply@basefyio.com>');
    });
    it('explains SMTP failures', () => {
      expect(describeSmtpFailure({ code: 'EAUTH', response: '535 bad' }, { host: 'h', port: 587 })).toMatch(/rejected the username or password/);
      expect(describeSmtpFailure({ code: 'ENOTFOUND' }, { host: 'nohost', port: 587 })).toMatch(/could not be resolved/);
    });
  });
});
