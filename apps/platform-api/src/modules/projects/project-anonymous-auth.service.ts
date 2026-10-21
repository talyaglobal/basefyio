import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { RedisService } from '../redis/redis.service';
import { ProjectAuthConfigService } from './project-auth-config.service';
import { ProjectSdkAuthService } from './project-sdk-auth.service';

/**
 * Anonymous end users: a session for someone who has not signed up yet, that
 * can later be turned into a real account without losing its identity.
 *
 * Each anonymous sign-in creates a throw-away Keycloak user in the project's
 * realm with a random password that is used once, to mint tokens, and never
 * stored. The user carries the attribute `is_anonymous=true`, which a protocol
 * mapper on the anon client copies into the access token, so row-level
 * policies can tell these sessions apart with
 * `coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)`.
 *
 * Minting tokens *for* a user (token exchange) would avoid the password, but
 * it is a Keycloak preview feature that needs a start-up flag — and so a
 * restart — which this platform does not do for an app deploy.
 *
 * Off by default: a project opts in through ProjectAuthConfig.allowAnonymous.
 */

const DEFAULT_PER_IP_HOURLY = 30;
const DEFAULT_PER_PROJECT_DAILY = 5000;

export interface AnonymousUpgradeInput {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

@Injectable()
export class ProjectAnonymousAuthService {
  private readonly logger = new Logger(ProjectAnonymousAuthService.name);

  constructor(
    private readonly keycloak: KeycloakAdminService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly authConfig: ProjectAuthConfigService,
    private readonly sdkAuth: ProjectSdkAuthService,
  ) {}

  /** True when verified claims describe an anonymous session. */
  static isAnonymousClaims(claims: Record<string, unknown> | undefined | null): boolean {
    const v = claims?.is_anonymous;
    return v === true || v === 'true';
  }

  async signInAnonymously(projectId: string, clientIp?: string) {
    const project = await this.sdkAuth.getProject(projectId);
    const cfg = await this.authConfig.getOrCreate(projectId);
    if (!cfg.allowAnonymous) {
      throw new ForbiddenException(
        'Anonymous sign-in is disabled for this project. Enable it under Authentication → Settings.',
      );
    }
    await this.enforceLimits(projectId, clientIp);

    const realm = project.keycloakRealm;
    const clientId = `${realm}-anon`;
    // Lower-case hex keeps the username exactly as given: Keycloak lower-cases
    // usernames, and the grant below resolves the literal username.
    const username = `anon_${randomBytes(12).toString('hex')}`;
    const password = randomBytes(32).toString('base64url');

    const userId = await this.keycloak.createAnonymousUser(realm, username, password);
    await this.keycloak.ensureRealmClientAnonymousClaimMapper(realm, clientId);
    const tokens = await this.sdkAuth.authenticateInRealm(
      realm, clientId, username, password, false, clientIp,
    );
    return { ...tokens, userId, emailVerified: false, isAnonymous: true };
  }

  /**
   * Convert the anonymous user behind a verified token into a normal
   * email/password account. The Keycloak user id — and so every row that
   * references `auth.uid()` — stays the same.
   */
  async upgradeAnonymous(
    projectId: string,
    claims: Record<string, unknown> | undefined,
    body: AnonymousUpgradeInput,
    clientIp?: string,
  ) {
    if (!ProjectAnonymousAuthService.isAnonymousClaims(claims)) {
      throw new BadRequestException('This session is not anonymous, so there is nothing to upgrade.');
    }
    const userId = typeof claims?.sub === 'string' ? claims.sub : '';
    if (!userId) throw new UnauthorizedException('Invalid or expired access token');

    const project = await this.sdkAuth.getProject(projectId);
    const cfg = await this.authConfig.getOrCreate(projectId);

    const email = (body?.email ?? '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new BadRequestException('A valid email is required');
    }
    if (email.endsWith('@anonymous.invalid')) {
      throw new BadRequestException('A valid email is required');
    }
    const password = body?.password ?? '';
    if (password.length < cfg.minPasswordLength) {
      throw new BadRequestException(`Password must be at least ${cfg.minPasswordLength} characters`);
    }

    const realm = project.keycloakRealm;
    const existing = await this.keycloak.findUserInRealm(realm, email);
    if (existing && existing.id !== userId) {
      throw new ConflictException('Email already registered');
    }

    const emailVerified = !cfg.requireEmailVerify;
    await this.keycloak.convertAnonymousUser(realm, userId, {
      email,
      password,
      firstName: body.firstName,
      lastName: body.lastName,
      emailVerified,
    });

    if (cfg.requireEmailVerify) {
      await this.sdkAuth.issueEmailVerification(project, userId, email);
    }

    // Fresh tokens: the ones the caller holds still say is_anonymous.
    const clientId = `${realm}-anon`;
    const tokens = await this.sdkAuth.authenticateInRealm(
      realm, clientId, email, password, false, clientIp, { projectId },
    );
    this.logger.log(`Anonymous user ${userId} upgraded to ${email} on project ${projectId}`);
    return { ...tokens, userId, emailVerified, isAnonymous: false };
  }

  // ── Limits ──────────────────────────────────────────────────────────────

  private limit(name: string, fallback: number): number {
    const raw = this.config.get<string | number>(name);
    const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }

  /**
   * Every anonymous sign-in creates a realm user, so an unbounded loop in a
   * client would fill the realm. Both limits are per project; 0 disables one.
   */
  private async enforceLimits(projectId: string, clientIp?: string): Promise<void> {
    const perIp = this.limit('ANON_SIGNIN_PER_IP_HOURLY', DEFAULT_PER_IP_HOURLY);
    if (clientIp && perIp > 0) {
      const key = `anon_signin_ip:${projectId}:${clientIp}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, 3600);
      if (n > perIp) {
        throw new HttpException(
          { message: 'Too many anonymous sign-ins from this address. Try again later.', code: 'rate_limited' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
    const perDay = this.limit('ANON_SIGNIN_PER_PROJECT_DAILY', DEFAULT_PER_PROJECT_DAILY);
    if (perDay > 0) {
      const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const key = `anon_signin_day:${projectId}:${day}`;
      const n = await this.redis.incr(key);
      if (n === 1) await this.redis.expire(key, 86400);
      if (n > perDay) {
        throw new HttpException(
          { message: 'This project has reached its daily limit of anonymous sign-ins.', code: 'rate_limited' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }
}
