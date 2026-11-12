import {
  BadRequestException,
  BadGatewayException,
  CallHandler,
  ConflictException,
  Controller,
  ExecutionContext,
  Get,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
  NotFoundException,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { ProjectsService } from './projects.service';
import { ProjectAuthConfigService } from './project-auth-config.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { ProjectMfaService } from './project-mfa.service';
import { EmailService } from '../email/email.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import { ServiceKeyOnly } from '../../common/decorators/api-key-scope.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';
import {
  assertPasswordMeetsPolicy,
  effectiveMinLength,
  EMAIL_PROVIDER_FIELDS,
  isValidEmail,
  mergePasswordPolicy,
  normalizePersonName,
  normalizePhoneNumber,
  parsePasswordPolicy,
  PasswordRules,
  prepareAuthConfigUpdate,
  validatePolicyUpdate,
} from './project-auth-validation';
import {
  describeSmtpFailure,
  projectFromAddress,
  resolveProjectSmtp,
  smtpTransportOptions,
} from './project-email-transport';

const logger = new Logger('ProjectAuth');

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Largest page of users one request may ask for. */
const MAX_USER_PAGE = 200;

/**
 * Every route here talks to Keycloak, and a raw client failure surfaces in the
 * dashboard as "Internal server error" — which tells the operator nothing and
 * looks the same as a bug in our own code. Translate those failures in one
 * place, so a newly added route cannot forget to. Deliberate HttpExceptions
 * (400/404/409…) pass through untouched.
 */
@Injectable()
export class KeycloakFailureInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((err: any) => {
        if (err instanceof HttpException) return throwError(() => err);

        const status = err?.response?.status ?? err?.responseData?.status ?? err?.status;
        // The Keycloak client reports "Network response was not OK" for every
        // non-2xx reply, a plain 400 included, so that text alone cannot mean the
        // server is unreachable. When it gave us a status, trust the status; only
        // fall back to the message when there is none (a genuine transport fault).
        const unreachable =
          status >= 500 ||
          (!status &&
            /Network response was not OK|ECONNREFUSED|ETIMEDOUT|socket hang up/i.test(
              err?.message || '',
            ));
        if (unreachable) {
          // Keep the original around; the translated message loses the cause.
          logger.error(
            `Keycloak unreachable: status=${status ?? 'n/a'} ${err?.message ?? ''}`,
          );
          return throwError(
            () =>
              new BadGatewayException(
                "This project's authentication service is currently unavailable (realm error). The realm may need to be repaired or recreated.",
              ),
          );
        }

        // Keycloak refused the request for a reason it can state — repeating
        // that beats a blank 500. Its own text ("Network response was not OK")
        // is useless to an operator, so prefer the errorMessage it returns.
        if (status >= 400) {
          const reason =
            err?.responseData?.errorMessage ||
            err?.responseData?.error_description ||
            err?.responseData?.error;
          logger.warn(`Keycloak rejected the request (${status}): ${reason ?? err?.message}`);
          return throwError(
            () =>
              new HttpException(
                reason || 'The authentication service rejected the request.',
                status,
              ),
          );
        }
        logger.error(`Unexpected auth failure: ${err?.message ?? err}`);
        return throwError(() => err);
      }),
    );
  }
}

const OAUTH_PROVIDERS = [
  'google',
  'microsoft',
  'apple',
  'github',
  'gitlab',
  'linkedin',
  'facebook',
  'twitter',
] as const;
type OAuthProvider = (typeof OAUTH_PROVIDERS)[number];

function optionalInt(raw: string | undefined, label: string, min: number, max: number): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new BadRequestException(`${label} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

/**
 * The project's user directory and realm configuration.
 *
 * Every route here is administration: listing and deleting users, resetting
 * passwords, revoking sessions, rewriting the auth config and the identity
 * providers. None of it has a legitimate caller in a browser, and the anon key
 * that browsers carry is public — so the whole controller is service-key only.
 *
 * Reached with a dashboard JWT this is unchanged; the owner still manages their
 * users from the panel. End-user flows (sign-up, sign-in, password-reset
 * requests) live on ProjectSdkAuthController and stay public.
 */
@Controller('projects/:projectId/auth')
@UseGuards(JwtOrApiKeyGuard)
@ServiceKeyOnly()
@UseInterceptors(KeycloakFailureInterceptor)
export class ProjectAuthController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly keycloak: KeycloakAdminService,
    private readonly authConfigService: ProjectAuthConfigService,
    private readonly configService: ConfigService,
    private readonly activity: ProjectActivityService,
    private readonly mfa: ProjectMfaService,
    private readonly email: EmailService,
  ) {}

  /**
   * The password rules actually enforced for this project: Keycloak's policy,
   * with the minimum length raised to the project setting the SDK checks.
   */
  private async passwordRules(projectId: string, realm: string): Promise<PasswordRules> {
    const [policies, cfg] = await Promise.all([
      this.keycloak.getRealmPolicies(realm),
      this.authConfigService.getRaw(projectId),
    ]);
    return {
      ...parsePasswordPolicy(policies.passwordPolicy),
      minLength: effectiveMinLength(cfg.minPasswordLength, policies.passwordPolicy),
    };
  }

  @Get()
  async getRealmInfo(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.keycloak.getRealmInfo(project.keycloakRealm);
  }

  /**
   * Users of the project, newest Keycloak page first. `search` matches email,
   * name and username; `first`/`max` page through the realm. Without `max`
   * Keycloak's default page (100) is returned, as before.
   */
  @Get('users')
  async listUsers(
    @Param('projectId') projectId: string,
    @Query('search') search?: string,
    @Query('first') firstRaw?: string,
    @Query('max') maxRaw?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const first = optionalInt(firstRaw, 'first', 0, 1_000_000);
    const max = optionalInt(maxRaw, 'max', 1, MAX_USER_PAGE);
    const [users, mfaRequired] = await Promise.all([
      this.keycloak.listUsers(project.keycloakRealm, {
        search: search?.trim() || undefined,
        first,
        max,
      }),
      this.mfa.listEnrollmentRequired(projectId).catch((): string[] => []),
    ]);
    const required = new Set(mfaRequired);
    return users.map((u) => ({
      ...u,
      mfaEnrollmentRequired:
        required.has(u.id as string) || (u.requiredActions ?? []).includes('CONFIGURE_TOTP'),
    }));
  }

  /** How many users match `search`, for paging the list. */
  @Get('users/count')
  async countUsers(
    @Param('projectId') projectId: string,
    @Query('search') search?: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return { count: await this.keycloak.countUsers(project.keycloakRealm, search?.trim() || undefined) };
  }

  @Get('users/:userId')
  async getUser(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const realm = project.keycloakRealm;
    const [detail, providers, sessions, mfaState, hasOtp] = await Promise.all([
      this.keycloak.getRealmUserById(realm, userId),
      this.keycloak.listUserFederatedIdentities(realm, userId).catch((): string[] => []),
      this.keycloak.listUserSessions(realm, userId).catch((): any[] => []),
      this.mfa.status(projectId, userId).catch(() => null),
      this.keycloak.userHasOtpCredential(realm, userId).catch(() => false),
    ]);
    if (!detail) throw new NotFoundException('User not found');
    // "Email" is always an available login method; linked OAuth providers add to it.
    const sessTimes = (sessions as any[]).map((s) => s.lastAccess || s.start || 0);
    const lastSignIn = sessTimes.length ? Math.max(...sessTimes) || null : null;
    return {
      ...detail,
      providers: ['email', ...providers],
      sessions,
      lastSignIn,
      sessionCount: sessions.length,
      mfa: {
        // Asked to enroll, by either path: the hosted login's required action
        // or the flag the SDK sign-in honours.
        enrollmentRequired:
          !!mfaState?.enrollmentRequired || (detail.requiredActions ?? []).includes('CONFIGURE_TOTP'),
        enrolled: !!mfaState?.enrolled || !!hasOtp,
      },
    };
  }

  @Get('users/:userId/sessions')
  async listUserSessions(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.keycloak.listUserSessions(project.keycloakRealm, userId);
  }

  @Delete('users/:userId/sessions/:sessionId')
  async revokeUserSession(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Param('sessionId') sessionId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const result = await this.keycloak.revokeUserSession(project.keycloakRealm, sessionId);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `Auth session revoked: ${userId}`,
      detail: `session ${sessionId.slice(0, 8)}`,
    });
    return result;
  }

  @Post('users/:userId/logout')
  async logoutUser(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const result = await this.keycloak.logoutAllUserSessions(project.keycloakRealm, userId);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `Auth user signed out of all sessions: ${userId}`,
    });
    return result;
  }

  @Post('users/:userId/send-recovery')
  async sendRecovery(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const result = await this.keycloak.sendUserActionsEmail(project.keycloakRealm, userId, ['UPDATE_PASSWORD']);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_PASSWORD_RESET,
      title: `Password recovery email sent: ${userId}`,
    });
    return result;
  }

  @Post('users/:userId/send-verification')
  async sendVerification(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const result = await this.keycloak.sendUserActionsEmail(project.keycloakRealm, userId, ['VERIFY_EMAIL']);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `Verification email sent: ${userId}`,
    });
    return result;
  }

  // ── Realm-wide sessions ──
  @Get('sessions')
  async listRealmSessions(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.keycloak.listRealmSessions(project.keycloakRealm);
  }

  @Delete('sessions/:sessionId')
  async revokeRealmSession(
    @Param('projectId') projectId: string,
    @Param('sessionId') sessionId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const result = await this.keycloak.revokeUserSession(project.keycloakRealm, sessionId);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `Auth session revoked`,
      detail: `session ${sessionId.slice(0, 8)}`,
    });
    return result;
  }

  @Post('users/:userId/require-mfa')
  async requireMfa(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: { enabled?: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const enabled = body?.enabled !== false;
    const result = await this.keycloak.setUserRequiredAction(
      project.keycloakRealm,
      userId,
      'CONFIGURE_TOTP',
      enabled,
    );
    // The Keycloak required action covers the hosted login; the SDK sign-in
    // clears it to complete the password grant, so the request is kept on
    // our side too, where the SDK flow reads and (when enforced) honours it.
    await this.mfa.setEnrollmentRequired(projectId, userId, enabled);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `MFA enrollment ${enabled ? 'required' : 'cleared'}: ${userId}`,
    });
    return result;
  }

  // ── MFA ──
  /**
   * Every enrolled factor, wherever it lives: Keycloak credentials (hosted
   * login, `source: 'keycloak'`) and authenticator apps enrolled through the
   * SDK (`source: 'basefyio'`).
   */
  @Get('mfa')
  async listMfaUsers(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const [fromKeycloak, fromApp] = await Promise.all([
      this.keycloak.listMfaUsers(project.keycloakRealm),
      this.mfa.listEnrolled(projectId),
    ]);
    type Factor = { id: string; type: string; userLabel: string | null; createdDate: number | null; source: 'keycloak' | 'basefyio' };
    type Entry = { id: string; email: string; firstName: string; lastName: string; factors: Factor[] };
    const byUser = new Map<string, Entry>(
      fromKeycloak.map((u: any) => [
        u.id as string,
        { ...u, factors: (u.factors as Factor[]).map((f) => ({ ...f, source: 'keycloak' as const })) },
      ]),
    );
    for (const row of fromApp) {
      const factor: Factor = {
        id: `app-totp-${row.keycloakUserId}`,
        type: 'totp',
        userLabel: 'Authenticator app',
        createdDate: row.verifiedAt ? row.verifiedAt.getTime() : null,
        source: 'basefyio',
      };
      const existing = byUser.get(row.keycloakUserId);
      if (existing) {
        existing.factors.push(factor);
        continue;
      }
      const kcUser = await this.keycloak
        .getRealmUserById(project.keycloakRealm, row.keycloakUserId)
        .catch(() => null);
      byUser.set(row.keycloakUserId, {
        id: row.keycloakUserId,
        email: kcUser?.email ?? '',
        firstName: kcUser?.firstName ?? '',
        lastName: kcUser?.lastName ?? '',
        factors: [factor],
      });
    }
    return Array.from(byUser.values());
  }

  /** Reset an authenticator app enrolled through the SDK (the person re-enrolls at next sign-in). */
  @Delete('users/:userId/mfa')
  async removeAppMfa(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    await this.projectsService.findOne(projectId, user?.sub);
    const result = await this.mfa.disable(projectId, userId, { force: true });
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `MFA authenticator reset: ${userId}`,
    });
    return result;
  }

  // ── Anonymous users ──
  /**
   * Delete anonymous users whose sessions have long expired. Dry-run reports
   * the count without deleting. One page (500) per call.
   */
  @Post('anonymous/purge')
  async purgeAnonymousUsers(
    @Param('projectId') projectId: string,
    @Body() body: { olderThanDays?: number; dryRun?: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const olderThanDays = Math.max(1, Math.floor(Number(body?.olderThanDays) || 30));
    const dryRun = body?.dryRun === true;
    const result = await this.keycloak.purgeAnonymousUsers(
      project.keycloakRealm,
      olderThanDays,
      500,
      dryRun,
    );
    if (!dryRun && result.deleted > 0) {
      await this.activity.append(projectId, {
        userId: user?.sub,
        kind: ProjectActivityKind.AUTH_USER_DELETED,
        title: `Anonymous users purged: ${result.deleted}`,
        detail: `older than ${olderThanDays} days`,
      });
    }
    return { ...result, olderThanDays, dryRun };
  }

  @Delete('users/:userId/credentials/:credentialId')
  async removeCredential(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Param('credentialId') credentialId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const result = await this.keycloak.removeUserCredential(project.keycloakRealm, userId, credentialId);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `MFA factor removed: ${userId}`,
    });
    return result;
  }

  // ── Policies (brute-force + password + token lifetime) ──
  /**
   * The one place the password rules live. `password.minLength` is the length
   * actually enforced — the stricter of Keycloak's policy and the project
   * setting the SDK sign-up checks — so this page and Auth → Settings can no
   * longer show two different numbers.
   */
  @Get('policies')
  async getPolicies(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.readPolicies(projectId, project.keycloakRealm);
  }

  private async readPolicies(projectId: string, realm: string) {
    const [p, cfg] = await Promise.all([
      this.keycloak.getRealmPolicies(realm),
      this.authConfigService.getRaw(projectId),
    ]);
    const { accessTokenLifespan, ...rest } = p;
    return {
      ...rest,
      accessTokenLifespanSeconds: accessTokenLifespan,
      password: {
        ...parsePasswordPolicy(p.passwordPolicy),
        minLength: effectiveMinLength(cfg.minPasswordLength, p.passwordPolicy),
      },
    };
  }

  @Put('policies')
  async updatePolicies(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, any>,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const realm = project.keycloakRealm;
    const input = validatePolicyUpdate(body);

    const update: Record<string, any> = {};
    for (const k of [
      'bruteForceProtected',
      'permanentLockout',
      'failureFactor',
      'waitIncrementSeconds',
      'maxFailureWaitSeconds',
    ] as const) {
      if (input[k] !== undefined) update[k] = input[k];
    }
    if (input.accessTokenLifespanSeconds !== undefined) {
      update.accessTokenLifespan = input.accessTokenLifespanSeconds;
    }
    if (input.password) {
      const current = await this.keycloak.getRealmPolicies(realm);
      update.passwordPolicy = mergePasswordPolicy(current.passwordPolicy, input.password);
    }
    await this.keycloak.updateRealmPolicies(realm, update);

    // Mirror into the project config the SDK flows read, so both enforce the same values.
    const mirror: { minPasswordLength?: number; tokenExpirySeconds?: number } = {};
    if (input.password?.minLength !== undefined) mirror.minPasswordLength = input.password.minLength;
    if (input.accessTokenLifespanSeconds !== undefined) mirror.tokenExpirySeconds = input.accessTokenLifespanSeconds;
    if (Object.keys(mirror).length) {
      await this.authConfigService.mirrorRealmSettings(projectId, mirror);
    }

    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_CONFIG_UPDATED,
      title: 'Authentication policies updated',
      detail: Object.keys({ ...update, ...(input.password ? { password: 1 } : {}) })
        .filter((k) => k !== 'passwordPolicy')
        .join(', ') || null,
    });
    return this.readPolicies(projectId, realm);
  }

  @Post('users')
  async createUser(
    @Param('projectId') projectId: string,
    @Body() body: { email: string; password: string; firstName?: string; lastName?: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const email = typeof body?.email === 'string' ? body.email.trim() : '';
    if (!email) {
      throw new BadRequestException('Email is required');
    }
    if (!isValidEmail(email)) {
      throw new BadRequestException(`"${email}" is not a valid email address (it needs a domain such as example.com)`);
    }
    const firstName = normalizePersonName(body.firstName, 'First name');
    const lastName = normalizePersonName(body.lastName, 'Last name');
    assertPasswordMeetsPolicy(body.password, await this.passwordRules(projectId, project.keycloakRealm));
    // Enforce one account per email in the project's auth realm (the SDK signup
    // path already does this; the dashboard "Add User" path did not, which let
    // duplicate emails accumulate).
    const existing = await this.keycloak.findUserInRealm(project.keycloakRealm, email);
    if (existing) {
      throw new ConflictException('A user with this email already exists in this project');
    }
    const created = await this.keycloak.createUser(
      project.keycloakRealm,
      { email, password: body.password, firstName: firstName ?? undefined, lastName: lastName ?? undefined },
      // A name left blank stays blank instead of becoming a copy of the email.
      { allowEmptyNames: true },
    );
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_CREATED,
      title: `Auth user created: ${email}`,
    });
    return created;
  }

  @Patch('users/:userId')
  async updateUser(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: { firstName?: string; lastName?: string; email?: string; enabled?: boolean; phoneNumber?: string; phoneVerified?: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const update: {
      firstName?: string; lastName?: string; email?: string; enabled?: boolean; phoneNumber?: string; phoneVerified?: boolean;
    } = {};
    if (body?.email !== undefined) {
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      if (!isValidEmail(email)) {
        throw new BadRequestException(`"${email}" is not a valid email address (it needs a domain such as example.com)`);
      }
      update.email = email;
    }
    if (body?.firstName !== undefined) update.firstName = normalizePersonName(body.firstName, 'First name') ?? '';
    if (body?.lastName !== undefined) update.lastName = normalizePersonName(body.lastName, 'Last name') ?? '';
    if (body?.phoneNumber !== undefined) update.phoneNumber = normalizePhoneNumber(body.phoneNumber) ?? '';
    for (const k of ['enabled', 'phoneVerified'] as const) {
      if (body?.[k] !== undefined) {
        if (typeof body[k] !== 'boolean') throw new BadRequestException(`${k} must be true or false`);
        update[k] = body[k];
      }
    }
    if (update.phoneNumber === '' && update.phoneVerified) {
      throw new BadRequestException('A phone number cannot be marked verified without a number');
    }
    if (update.firstName === '' || update.lastName === '') {
      // Clearing a name is refused by realms that still require one.
      await this.keycloak.ensureNamesOptional(project.keycloakRealm);
    }
    await this.keycloak.updateRealmUser(project.keycloakRealm, userId, update);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `Auth user updated: ${userId}`,
      detail: Object.keys(update).join(', '),
    });
    return { message: 'User updated' };
  }

  @Post('users/:userId/reset-password')
  async resetUserPassword(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @Body() body: { newPassword: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    assertPasswordMeetsPolicy(body?.newPassword, await this.passwordRules(projectId, project.keycloakRealm));
    await this.keycloak.resetRealmUserPassword(project.keycloakRealm, userId, body.newPassword);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_PASSWORD_RESET,
      title: `Auth user password reset: ${userId}`,
    });
    return { message: 'Password reset successfully' };
  }

  @Delete('users/:userId')
  async deleteUser(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const result = await this.keycloak.deleteUser(project.keycloakRealm, userId);
    await this.mfa.forgetUser(projectId, userId).catch(() => undefined);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_DELETED,
      title: `Auth user deleted: ${userId}`,
    });
    return result;
  }

  @Get('config')
  async getConfig(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    await this.projectsService.findOne(projectId, user?.sub);
    return this.authConfigService.getOrCreate(projectId);
  }

  /**
   * Update the project's auth settings. Values are validated (a 400 names each
   * problem) instead of being replaced by defaults. `minPasswordLength` and
   * `tokenExpirySeconds` are mirrored into the realm when they change, so the
   * number shown is the number enforced.
   */
  @Put('config')
  async updateConfig(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, any>,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const { prepared, stored } = await this.authConfigService.validateUpdate(projectId, body);

    const realmUpdate: Record<string, any> = {};
    if (prepared.minPasswordLength !== undefined && prepared.minPasswordLength !== stored.minPasswordLength) {
      const current = await this.keycloak.getRealmPolicies(project.keycloakRealm);
      realmUpdate.passwordPolicy = mergePasswordPolicy(current.passwordPolicy, { minLength: prepared.minPasswordLength });
    }
    if (prepared.tokenExpirySeconds !== undefined && prepared.tokenExpirySeconds !== stored.tokenExpirySeconds) {
      realmUpdate.accessTokenLifespan = prepared.tokenExpirySeconds;
    }
    if (Object.keys(realmUpdate).length) {
      await this.keycloak.updateRealmPolicies(project.keycloakRealm, realmUpdate);
    }
    return this.authConfigService.update(projectId, prepared, user?.sub);
  }

  /**
   * Try the email settings before relying on them: connect to the provider,
   * log in, and send a short message. `settings` may carry values not saved
   * yet (secrets left out fall back to the saved ones); omitted, the saved
   * configuration is tested. Nothing is written.
   *
   * With the platform's own email service the message can only go to the
   * signed-in operator's address, so this cannot be used to mail third parties.
   */
  @Post('config/email/test')
  async testEmailSettings(
    @Param('projectId') projectId: string,
    @Body() body: { to?: string; settings?: Record<string, any> },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const stored = await this.authConfigService.getRaw(projectId);
    const overrides: Record<string, any> = {};
    for (const k of EMAIL_PROVIDER_FIELDS) {
      if (body?.settings && k in body.settings) overrides[k] = body.settings[k];
    }
    const prepared = Object.keys(overrides).length ? prepareAuthConfigUpdate(overrides, stored) : {};
    const cfg = { ...stored, ...prepared };

    const operatorEmail = typeof user?.email === 'string' ? user.email : '';
    const to = typeof body?.to === 'string' && body.to.trim() ? body.to.trim() : operatorEmail;
    if (!isValidEmail(to)) {
      throw new BadRequestException('Enter a valid address to send the test email to');
    }

    const subject = `[${project.name}] Test email from basefyio`;
    const html =
      `<p>This is a test email for <strong>${escapeHtml(project.name)}</strong>.</p>` +
      `<p>If you can read it, the project's email settings work.</p>`;

    const smtp = resolveProjectSmtp(cfg);
    if (!smtp) {
      if (!operatorEmail || to.toLowerCase() !== operatorEmail.toLowerCase()) {
        throw new BadRequestException(
          'With the platform email service a test can only be sent to your own address. Leave the recipient empty or use your account email.',
        );
      }
      const sent = await this.email.sendRawHtml(to, subject, html);
      if (!sent) {
        return { ok: false, provider: 'platform', to, error: 'The platform email service could not send the message right now. Try again in a few minutes.' };
      }
      return { ok: true, provider: 'platform', to };
    }

    const transporter = nodemailer.createTransport(smtpTransportOptions(smtp) as nodemailer.TransportOptions);
    try {
      await transporter.verify();
      await transporter.sendMail({ from: projectFromAddress(cfg, project.name), to, subject, html });
      await this.activity.append(projectId, {
        userId: user?.sub,
        kind: ProjectActivityKind.AUTH_CONFIG_UPDATED,
        title: 'Test email sent',
        detail: `${cfg.emailProvider ?? 'smtp'} via ${smtp.host}:${smtp.port}`,
      });
      return { ok: true, provider: cfg.emailProvider ?? 'smtp', to };
    } catch (err: any) {
      // A failed test is an answer, not a server error: report it in the body.
      return { ok: false, provider: cfg.emailProvider ?? 'smtp', to, error: describeSmtpFailure(err, smtp) };
    } finally {
      transporter.close();
    }
  }

  @Put('providers/:provider')
  async saveProvider(
    @Param('projectId') projectId: string,
    @Param('provider') provider: string,
    @Body() body: { clientId: string; clientSecret?: string; enabled: boolean },
    @CurrentUser() user?: JwtPayload,
  ) {
    if (!OAUTH_PROVIDERS.includes(provider as OAuthProvider)) {
      throw new BadRequestException(`Unsupported provider: ${provider}`);
    }
    const p = provider as OAuthProvider;
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const publicApiUrl = this.configService.get<string>('publicApiUrl');
    const redirectUri = `${publicApiUrl}/rest/v1/auth/callback/${projectId}/${p}`;
    const cap = `${p.charAt(0).toUpperCase()}${p.slice(1)}`;
    const enabledField = `${p}Enabled`;
    const clientIdField = `${p}ClientId`;
    const secretField = `${p}ClientSecret`;

    const updateData: Record<string, any> = {
      [enabledField]: body.enabled,
      [clientIdField]: body.clientId,
    };
    if (body.clientSecret) {
      updateData[secretField] = body.clientSecret;
    }

    const updated = await this.authConfigService.update(
      projectId,
      updateData,
      user?.sub,
    );

    if (body.enabled && body.clientId) {
      const rawCfg = await this.authConfigService.getRaw(projectId);
      const secret = (rawCfg as any)[secretField];
      if (secret) {
        await this.keycloak.upsertIdentityProvider(
          project.keycloakRealm, p, body.clientId, secret, redirectUri,
        );
      }
    } else if (!body.enabled) {
      await this.keycloak.deleteIdentityProvider(project.keycloakRealm, p);
    }

    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_CONFIG_UPDATED,
      title: `OAuth provider updated: ${cap}`,
      detail: body.enabled ? 'Enabled' : 'Disabled',
      metadata: { provider: p, enabled: body.enabled },
    });

    return updated;
  }

  @Get('providers')
  async listProviders(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    // The OAuth flow brokers through Keycloak (kc_idp_hint), so the redirect URI
    // the user must whitelist in their Google/GitHub OAuth app is Keycloak's
    // broker endpoint — NOT the app callback. Returning the app callback here
    // is what made every provider fail with redirect_uri_mismatch.
    const publicKcUrl = (
      this.configService.get<string>('keycloak.publicUrl') ||
      this.configService.get<string>('keycloak.url') ||
      ''
    ).replace(/\/+$/, '');
    const callbackUrls = OAUTH_PROVIDERS.reduce<Record<string, string>>((acc, p) => {
      acc[p] = `${publicKcUrl}/realms/${project.keycloakRealm}/broker/${p}/endpoint`;
      return acc;
    }, {});

    return {
      callbackUrls,
      providers: await this.keycloak.listIdentityProviders(project.keycloakRealm),
    };
  }

  @Post('repair')
  async repairRealm(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const realmName = project.keycloakRealm;

    // Is the current realm actually healthy? A realm can EXIST but be corrupt
    // (every Keycloak admin op returns 500) — realmExists() alone isn't enough.
    let healthy = false;
    try {
      await this.keycloak.getRealmInfo(realmName);
      healthy = true;
    } catch {
      healthy = false;
    }
    if (healthy) {
      return { message: 'Realm is healthy, no repair needed', realm: realmName };
    }

    // Provision a FRESH realm under a new name and repoint the project at it. We
    // don't try to delete the old realm — a corrupt one can be undeletable via
    // the API; it's left orphaned and unused. The project's API keys are
    // unchanged, so the REST/apikey surface keeps working; only Keycloak users
    // (SDK signup/signin identities) are reset.
    const base = realmName.replace(/-r[a-z0-9]+$/, '');
    const newRealm = `${base}-r${Date.now().toString(36)}`;
    await this.keycloak.createRealm(newRealm);
    await this.keycloak.createClients(newRealm);
    await this.projectsService.updateKeycloakRealm(projectId, newRealm);

    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_CONFIG_UPDATED,
      title: 'Authentication realm re-provisioned',
      detail: `Realm "${realmName}" was unhealthy; project repointed to fresh realm "${newRealm}"`,
    });

    return { message: 'Realm re-provisioned', realm: newRealm, previousRealm: realmName };
  }
}
