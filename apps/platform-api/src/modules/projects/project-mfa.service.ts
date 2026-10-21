import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  decryptField,
  encryptField,
  isEncryptionEnabled,
} from '../../common/crypto/field-crypto';
import {
  TOTP_ALGORITHM,
  TOTP_DIGITS,
  TOTP_PERIOD,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotp,
} from '../../common/crypto/totp';

/**
 * A second factor for project end users that the SDK can enroll and complete
 * on its own, without a browser flow.
 *
 * Keycloak holds the password and mints the tokens; it cannot be made to hold
 * this factor, because its admin API has no way to create an OTP credential
 * for a user — enrollment there is a browser-only required action. So the TOTP
 * secret lives in ProjectUserMfa, encrypted at rest with the same key that
 * protects project database passwords (field-crypto), one row per
 * (project, Keycloak user).
 *
 * Sign-in with an enrolled factor runs in two steps. The password grant still
 * happens first — it is the only way to check a password — but the tokens it
 * returns are parked in Redis under a short-lived challenge id instead of being
 * handed out. The challenge is released by a valid code (or a one-time recovery
 * code), and destroyed after too many wrong ones.
 */

export interface MfaTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}

/**
 * 'verify'  — the user has a factor; a code releases the parked tokens.
 * 'enroll'  — the project enforces enrollment and this user has none yet; the
 *             challenge proves the password so the enrollment routes may be
 *             called without a session, and the tokens are released once the
 *             new factor is confirmed.
 */
export type MfaChallengeKind = 'verify' | 'enroll';

export interface StoredMfaChallenge {
  kind: MfaChallengeKind;
  userId: string;
  realm: string;
  tokens: MfaTokens;
  emailVerified: boolean;
  /** What the authenticator app should label the account with (the email). */
  account?: string;
  createdAt: number;
}

export interface MfaChallengeResponse {
  mfaRequired: true;
  challengeId: string;
  methods: Array<'totp' | 'recovery'>;
  expiresIn: number;
  enrollmentRequired: boolean;
}

export interface MfaStatus {
  enrolled: boolean;
  enrollmentRequired: boolean;
  recoveryCodesLeft: number;
  verifiedAt: Date | null;
}

export interface MfaEnrollment {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  account: string;
  algorithm: string;
  digits: number;
  period: number;
}

export interface MfaFactorInput {
  code?: string;
  recoveryCode?: string;
}

interface MfaRow {
  id: string;
  projectId: string;
  keycloakUserId: string;
  totpSecretEnc: string | null;
  pendingSecretEnc: string | null;
  pendingCreatedAt: Date | null;
  verifiedAt: Date | null;
  lastUsedStep: number | null;
  lastUsedAt: Date | null;
  recoveryCodeHashes: string[];
  enrollmentRequiredAt: Date | null;
}

const DEFAULT_CHALLENGE_TTL_SECONDS = 300;
const DEFAULT_MAX_ATTEMPTS = 5;
/** Wrong codes a signed-in user may submit to the enrollment/disable routes per window. */
const USER_ATTEMPT_LIMIT = 10;
const USER_ATTEMPT_WINDOW_SECONDS = 900;

@Injectable()
export class ProjectMfaService {
  private readonly logger = new Logger(ProjectMfaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  // ── Configuration ───────────────────────────────────────────────────────

  private intSetting(name: string, fallback: number): number {
    const raw = this.config.get<string | number>(name);
    const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  get challengeTtlSeconds(): number {
    return this.intSetting('MFA_CHALLENGE_TTL_SECONDS', DEFAULT_CHALLENGE_TTL_SECONDS);
  }

  get maxAttempts(): number {
    return this.intSetting('MFA_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
  }

  /** The clock every code is checked against; a seam for tests, nothing else. */
  protected now(): number {
    return Date.now();
  }

  // ── Encryption helpers ──────────────────────────────────────────────────

  /**
   * Refuses rather than storing a secret in clear. Reading stays tolerant
   * (field-crypto returns plaintext untouched), writing does not.
   */
  private protect(value: string): string {
    if (!isEncryptionEnabled()) {
      throw new ServiceUnavailableException(
        'Multi-factor authentication needs DB_CRED_ENC_KEY on this installation so authenticator secrets can be stored encrypted. Set it to 32 random bytes (base64 or 64 hex characters) and restart the API.',
      );
    }
    return encryptField(value) as string;
  }

  private reveal(value: string | null | undefined): string | null {
    if (value == null) return null;
    return (decryptField(value) as string) ?? null;
  }

  // ── State ───────────────────────────────────────────────────────────────

  private whereUser(projectId: string, userId: string) {
    return { projectId_keycloakUserId: { projectId, keycloakUserId: userId } };
  }

  async getState(projectId: string, userId: string): Promise<MfaRow | null> {
    return (await this.prisma.projectUserMfa.findUnique({
      where: this.whereUser(projectId, userId),
    })) as MfaRow | null;
  }

  async status(projectId: string, userId: string): Promise<MfaStatus> {
    const row = await this.getState(projectId, userId);
    return {
      enrolled: !!row?.verifiedAt,
      enrollmentRequired: !!row?.enrollmentRequiredAt,
      recoveryCodesLeft: row?.recoveryCodeHashes?.length ?? 0,
      verifiedAt: row?.verifiedAt ?? null,
    };
  }

  /** Users of a project with a confirmed factor — for the dashboard's MFA list. */
  async listEnrolled(projectId: string) {
    const rows = (await this.prisma.projectUserMfa.findMany({
      where: { projectId, verifiedAt: { not: null } },
    })) as MfaRow[];
    return rows.map((r) => ({
      keycloakUserId: r.keycloakUserId,
      verifiedAt: r.verifiedAt,
      lastUsedAt: r.lastUsedAt,
      recoveryCodesLeft: r.recoveryCodeHashes?.length ?? 0,
    }));
  }

  /**
   * Remember that an administrator asked this user to enroll. Keycloak's own
   * CONFIGURE_TOTP required action cannot carry that intent for SDK users: the
   * sign-in self-heal clears required actions so the password grant can
   * succeed, which silently undid the request. This flag survives it.
   */
  async setEnrollmentRequired(projectId: string, userId: string, enabled: boolean): Promise<void> {
    const enrollmentRequiredAt = enabled ? new Date() : null;
    await this.prisma.projectUserMfa.upsert({
      where: this.whereUser(projectId, userId),
      create: { projectId, keycloakUserId: userId, enrollmentRequiredAt },
      update: { enrollmentRequiredAt },
    });
  }

  /** Best-effort cleanup when a user is deleted from the realm. */
  async forgetUser(projectId: string, userId: string): Promise<void> {
    await this.prisma.projectUserMfa.deleteMany({
      where: { projectId, keycloakUserId: userId },
    });
  }

  // ── Enrollment ──────────────────────────────────────────────────────────

  async beginEnrollment(
    projectId: string,
    userId: string,
    opts: { issuer: string; account: string },
  ): Promise<MfaEnrollment> {
    const existing = await this.getState(projectId, userId);
    if (existing?.verifiedAt) {
      throw new ConflictException(
        'An authenticator is already enrolled for this account. Disable it before enrolling a new one.',
      );
    }

    const secret = generateTotpSecret();
    const pendingSecretEnc = this.protect(secret);
    await this.prisma.projectUserMfa.upsert({
      where: this.whereUser(projectId, userId),
      create: { projectId, keycloakUserId: userId, pendingSecretEnc, pendingCreatedAt: new Date() },
      update: { pendingSecretEnc, pendingCreatedAt: new Date() },
    });

    return {
      secret,
      otpauthUrl: otpauthUri({ issuer: opts.issuer, account: opts.account, secret }),
      issuer: opts.issuer,
      account: opts.account,
      algorithm: TOTP_ALGORITHM,
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD,
    };
  }

  /**
   * The first code from the newly scanned secret proves the app has it. Only
   * then does the secret become the live factor, and the recovery codes are
   * shown — once.
   */
  async confirmEnrollment(
    projectId: string,
    userId: string,
    code: string,
  ): Promise<{ enabled: true; recoveryCodes: string[] }> {
    const row = await this.getState(projectId, userId);
    const pending = this.reveal(row?.pendingSecretEnc);
    if (!row || !pending) {
      throw new BadRequestException('No enrollment is in progress. Call /mfa/enroll first.');
    }
    if (row.verifiedAt) {
      throw new ConflictException('An authenticator is already enrolled for this account.');
    }

    await this.countUserAttempt(projectId, userId);
    const result = verifyTotp(pending, code, { nowMs: this.now() });
    if (!result.ok) {
      throw new BadRequestException('That code does not match the authenticator. Check the time on the device and try again.');
    }

    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.projectUserMfa.update({
      where: this.whereUser(projectId, userId),
      data: {
        totpSecretEnc: row.pendingSecretEnc,
        pendingSecretEnc: null,
        pendingCreatedAt: null,
        verifiedAt: new Date(),
        lastUsedStep: result.step,
        lastUsedAt: new Date(),
        recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
        enrollmentRequiredAt: null,
      },
    });
    await this.clearUserAttempts(projectId, userId);
    this.logger.log(`MFA enrolled for user ${userId} on project ${projectId}`);
    return { enabled: true, recoveryCodes };
  }

  // ── Challenges ──────────────────────────────────────────────────────────

  private challengeKey(projectId: string, challengeId: string) {
    return `mfa_challenge:${projectId}:${challengeId}`;
  }

  private attemptsKey(projectId: string, challengeId: string) {
    return `mfa_attempts:${projectId}:${challengeId}`;
  }

  async createChallenge(
    projectId: string,
    realm: string,
    userId: string,
    tokens: MfaTokens,
    kind: MfaChallengeKind,
    extra: { emailVerified?: boolean; account?: string } = {},
  ): Promise<MfaChallengeResponse> {
    const challengeId = randomBytes(32).toString('base64url');
    const stored: StoredMfaChallenge = {
      kind,
      userId,
      realm,
      tokens,
      emailVerified: extra.emailVerified ?? false,
      account: extra.account,
      createdAt: Date.now(),
    };
    const json = JSON.stringify(stored);
    // The parked tokens are live credentials; keep them unreadable at rest in
    // Redis whenever the key is configured (it always is where MFA is in use).
    const payload = isEncryptionEnabled() ? (encryptField(json) as string) : json;
    const ttl = this.challengeTtlSeconds;
    await this.redis.set(this.challengeKey(projectId, challengeId), payload, ttl);
    return {
      mfaRequired: true,
      challengeId,
      methods: kind === 'verify' ? ['totp', 'recovery'] : ['totp'],
      expiresIn: ttl,
      enrollmentRequired: kind === 'enroll',
    };
  }

  /** Read a challenge without consuming it (the enrollment routes need the user it names). */
  async peekChallenge(projectId: string, challengeId: string): Promise<StoredMfaChallenge> {
    if (!challengeId || typeof challengeId !== 'string') {
      throw new BadRequestException('challengeId is required');
    }
    const raw = await this.redis.get(this.challengeKey(projectId, challengeId));
    if (!raw) {
      throw new UnauthorizedException({
        message: 'This sign-in challenge has expired. Sign in again.',
        code: 'challenge_expired',
      });
    }
    return JSON.parse(this.reveal(raw) as string) as StoredMfaChallenge;
  }

  /** Release the parked tokens exactly once. */
  async consumeChallenge(projectId: string, challengeId: string): Promise<StoredMfaChallenge> {
    const raw = await this.redis.getdel(this.challengeKey(projectId, challengeId));
    if (!raw) {
      throw new UnauthorizedException({
        message: 'This sign-in challenge has expired. Sign in again.',
        code: 'challenge_expired',
      });
    }
    await this.redis.del(this.attemptsKey(projectId, challengeId));
    return JSON.parse(this.reveal(raw) as string) as StoredMfaChallenge;
  }

  /**
   * Second step of sign-in. Attempts are counted before the code is checked, so
   * a failure to update the counter never buys a free try; when the limit is
   * reached the challenge is destroyed and `onExhausted` gets the parked tokens
   * so the caller can revoke the Keycloak session behind them.
   */
  async verifyChallenge(
    projectId: string,
    challengeId: string,
    input: MfaFactorInput,
    onExhausted?: (challenge: StoredMfaChallenge) => Promise<void>,
  ): Promise<MfaTokens & { userId: string; emailVerified: boolean }> {
    const stored = await this.peekChallenge(projectId, challengeId);
    if (stored.kind !== 'verify') {
      throw new BadRequestException(
        'This challenge asks for enrollment, not a code. Call /mfa/enroll with the challengeId.',
      );
    }

    const attemptsKey = this.attemptsKey(projectId, challengeId);
    const attempts = await this.redis.incr(attemptsKey);
    if (attempts === 1) await this.redis.expire(attemptsKey, this.challengeTtlSeconds);

    const exhaust = async () => {
      await this.redis.del(this.challengeKey(projectId, challengeId));
      await this.redis.del(attemptsKey);
      if (onExhausted) await onExhausted(stored).catch(() => undefined);
      throw new UnauthorizedException({
        message: 'Too many incorrect codes. Sign in again to get a new challenge.',
        code: 'too_many_attempts',
      });
    };
    if (attempts > this.maxAttempts) await exhaust();

    const row = await this.getState(projectId, stored.userId);
    const match = row ? this.matchFactor(row, input) : null;
    if (!match) {
      if (attempts >= this.maxAttempts) await exhaust();
      throw new UnauthorizedException({ message: 'Invalid code', code: 'invalid_code' });
    }

    await this.prisma.projectUserMfa.update({
      where: this.whereUser(projectId, stored.userId),
      data: match.data,
    });
    const released = await this.consumeChallenge(projectId, challengeId);
    return { ...released.tokens, userId: released.userId, emailVerified: released.emailVerified };
  }

  // ── Self-service management ─────────────────────────────────────────────

  /**
   * Turning the factor off needs the factor (a code or a recovery code), so a
   * stolen session alone cannot remove it. `force` is for the dashboard and
   * the service key, which already hold project-level authority.
   */
  async disable(
    projectId: string,
    userId: string,
    input: MfaFactorInput & { force?: boolean },
  ): Promise<{ enabled: false }> {
    const row = await this.getState(projectId, userId);
    if (!row?.verifiedAt) {
      if (input.force) {
        // Nothing enrolled; clear a dangling pending enrollment or flag as well.
        await this.forgetUser(projectId, userId);
        return { enabled: false };
      }
      throw new BadRequestException('No authenticator is enrolled for this account.');
    }
    if (!input.force) {
      await this.countUserAttempt(projectId, userId);
      if (!this.matchFactor(row, input)) {
        throw new UnauthorizedException({ message: 'Invalid code', code: 'invalid_code' });
      }
      await this.clearUserAttempts(projectId, userId);
    }
    await this.forgetUser(projectId, userId);
    this.logger.log(`MFA disabled for user ${userId} on project ${projectId}${input.force ? ' (forced)' : ''}`);
    return { enabled: false };
  }

  async regenerateRecoveryCodes(
    projectId: string,
    userId: string,
    code: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const row = await this.getState(projectId, userId);
    if (!row?.verifiedAt) throw new BadRequestException('No authenticator is enrolled for this account.');
    await this.countUserAttempt(projectId, userId);
    const match = this.matchFactor(row, { code });
    if (!match) throw new UnauthorizedException({ message: 'Invalid code', code: 'invalid_code' });
    await this.clearUserAttempts(projectId, userId);
    const recoveryCodes = generateRecoveryCodes();
    await this.prisma.projectUserMfa.update({
      where: this.whereUser(projectId, userId),
      data: { ...match.data, recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode) },
    });
    return { recoveryCodes };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /**
   * Check a code or recovery code against the live factor. Returns the row
   * update to apply on success (replay marker, or the consumed recovery code),
   * null on failure. Pure: nothing is written here.
   */
  private matchFactor(row: MfaRow, input: MfaFactorInput): { data: Record<string, unknown> } | null {
    if (input.recoveryCode) {
      const hash = hashRecoveryCode(input.recoveryCode);
      if (!normalizeRecoveryCode(input.recoveryCode)) return null;
      if (!row.recoveryCodeHashes.includes(hash)) return null;
      return {
        data: {
          recoveryCodeHashes: row.recoveryCodeHashes.filter((h) => h !== hash),
          lastUsedAt: new Date(),
        },
      };
    }
    if (input.code) {
      const secret = this.reveal(row.totpSecretEnc);
      if (!secret) return null;
      const result = verifyTotp(secret, input.code, { minStep: row.lastUsedStep, nowMs: this.now() });
      if (!result.ok) return null;
      return { data: { lastUsedStep: result.step, lastUsedAt: new Date() } };
    }
    throw new BadRequestException('Send the authenticator code as `code`, or a recovery code as `recoveryCode`.');
  }

  private userAttemptsKey(projectId: string, userId: string) {
    return `mfa_user_attempts:${projectId}:${userId}`;
  }

  private async countUserAttempt(projectId: string, userId: string): Promise<void> {
    const key = this.userAttemptsKey(projectId, userId);
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, USER_ATTEMPT_WINDOW_SECONDS);
    if (n > USER_ATTEMPT_LIMIT) {
      throw new ForbiddenException({
        message: 'Too many attempts. Wait a few minutes before trying again.',
        code: 'too_many_attempts',
      });
    }
  }

  private async clearUserAttempts(projectId: string, userId: string): Promise<void> {
    await this.redis.del(this.userAttemptsKey(projectId, userId));
  }
}
