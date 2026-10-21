import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { KeycloakAdminService } from './keycloak-admin.service';

/** The Keycloak required action that walks a user through authenticator setup. */
export const CONFIGURE_TOTP = 'CONFIGURE_TOTP';

/** What the login path needs to know about a user before asking Keycloak for tokens. */
export interface LoginMfaState {
  userId?: string;
  /** The user owns an authenticator in Keycloak (source of truth, mirror as fallback). */
  hasOtp: boolean;
  /** At least one of the user's teams requires two-factor authentication. */
  required: boolean;
  /** Names of those teams, for the enrolment prompt. */
  requiredBy: string[];
}

/** The refusal both enrolment and the team policy give when the server cannot verify codes. */
export function mfaUnavailable(what: string): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'MFA_UNAVAILABLE',
    message: `The sign-in flow on this server does not verify authenticator codes, so ${what}.`,
  });
}

export type LoginMfaOutcome =
  | { kind: 'mfa_required' }
  | { kind: 'enrollment_required'; enrollUrl: string }
  | { kind: 'retry' }
  | null;

/**
 * Two-factor authentication for dashboard sign-in.
 *
 * The factor itself lives in Keycloak: the user enrols on Keycloak's own
 * authenticator page (reached through the platform OAuth client with
 * `kc_action=CONFIGURE_TOTP`) and Keycloak checks the code inside its
 * direct-grant and browser flows. basefyio never sees or stores a secret; it
 * only decides *when* a user must enrol — a team owner's policy — and hands the
 * dashboard the right prompt.
 *
 * Enforcement is lazy: the policy is applied at a member's next sign-in, never
 * against a live session or a refresh token.
 */
@Injectable()
export class PlatformMfaService {
  private readonly logger = new Logger(PlatformMfaService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly keycloak: KeycloakAdminService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  // ── Login-time decisions ──

  /**
   * Resolves the user's two-factor state from the fields `login()` already
   * selected. Accounts that are neither enrolled nor under a team policy return
   * immediately with no Keycloak call — that is every account until someone
   * opts in.
   */
  async resolveLoginMfa(user: {
    id: string;
    mfaEnrolledAt: Date | null;
    teamMembers: Array<{ team: { name: string } }>;
  } | null): Promise<LoginMfaState> {
    if (!user) return { hasOtp: false, required: false, requiredBy: [] };
    const requiredBy = user.teamMembers.map((m) => m.team.name);
    const required = requiredBy.length > 0;
    const mirror = user.mfaEnrolledAt != null;
    if (!required && !mirror) {
      return { userId: user.id, hasOtp: false, required: false, requiredBy };
    }

    let hasOtp = mirror;
    try {
      hasOtp = await this.keycloak.userHasOtpCredential('master', user.id);
      // A factor removed outside basefyio clears the mirror here. A new one is
      // recorded only after a successful sign-in with it (afterLoginSuccess),
      // which is also when the owner is told by email.
      if (mirror && !hasOtp) await this.setMirror(user.id, false).catch(() => undefined);
    } catch (err: any) {
      // Keycloak's admin API is down; the grant itself still enforces the factor.
      this.logger.warn(`Could not read authenticator state for ${user.id}: ${err?.message ?? err}`);
    }
    return { userId: user.id, hasOtp, required, requiredBy };
  }

  /**
   * Interprets a failed password grant. Returns null when it is an ordinary
   * failure (wrong password, wrong code) and the caller keeps today's handling.
   *
   * "Account is not fully set up" means Keycloak accepted the credentials and
   * stopped at a pending required action. When that action is authenticator
   * setup, the user is sent to enrol if a team still requires it, or the
   * action is removed and the grant retried once if no team does any more.
   */
  async handleGrantError(
    err: any,
    email: string,
    state: LoginMfaState,
  ): Promise<LoginMfaOutcome> {
    const description: string = err?.response?.data?.error_description || '';
    if (!/not fully set up/i.test(description)) return null;
    const userId = state.userId ?? (await this.keycloak.findPlatformUserByEmail(email))?.id;
    if (!userId) return null;
    const pending = await this.keycloak.userHasRequiredAction('master', userId, CONFIGURE_TOTP).catch(() => false);
    if (!pending) return null;
    if (state.required) {
      return { kind: 'enrollment_required', enrollUrl: this.buildEnrollUrl(email) };
    }
    await this.keycloak.removeUserRequiredAction('master', userId, CONFIGURE_TOTP);
    return { kind: 'retry' };
  }

  /**
   * After a successful grant: a member whose team requires two-factor
   * authentication and who has none yet is marked for setup and sent to
   * enrol (tokens are withheld); a user signing in with a fresh authenticator
   * gets the mirror set and a notice by email.
   */
  async afterLoginSuccess(
    email: string,
    state: LoginMfaState,
    user: { id: string; email: string; mfaEnrolledAt: Date | null } | null,
  ): Promise<LoginMfaOutcome> {
    // Nothing to do, and nothing asked of Keycloak, for an account with no
    // factor and no team policy.
    if (!state.userId || (!state.required && !state.hasOtp)) return null;

    if (state.required && !state.hasOtp) {
      if (await this.isServiceAccount(state.userId)) return null;
      try {
        // The marker makes Keycloak itself refuse a password-only grant from
        // now on, including one sent to it directly.
        await this.keycloak.setUserRequiredAction('master', state.userId, CONFIGURE_TOTP, true);
      } catch (err: any) {
        // Still withhold the tokens: the enrolment page works without the marker.
        this.logger.warn(`Could not mark ${state.userId} for authenticator setup: ${err?.message ?? err}`);
      }
      return { kind: 'enrollment_required', enrollUrl: this.buildEnrollUrl(email) };
    }

    if (state.hasOtp && user && user.mfaEnrolledAt == null) {
      try {
        await this.setMirror(user.id, true);
        this.notify(user.email, 'enabled');
      } catch (err: any) {
        this.logger.warn(`Could not record authenticator for ${user.id}: ${err?.message ?? err}`);
      }
    }
    return null;
  }

  /**
   * The same policy for a browser sign-in (social providers, and the return
   * from Keycloak's authenticator page). Users who own an authenticator are
   * already challenged by Keycloak's browser flow; this only catches a member
   * whose team requires one and who has none yet, and returns where to send
   * them instead of handing out tokens. `enrolmentReturn` marks the callback
   * that ends an enrolment, where the new factor is recorded.
   */
  async checkBrowserSignIn(userId: string, enrolmentReturn: boolean): Promise<{ enrollUrl: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        mfaEnrolledAt: true,
        teamMembers: { where: { team: { requireMfa: true } }, select: { team: { select: { name: true } } } },
      },
    });
    if (!user) return null;

    if (enrolmentReturn) {
      const hasOtp = await this.keycloak.userHasOtpCredential('master', user.id).catch(() => false);
      if (hasOtp) {
        await this.afterLoginSuccess(user.email, { userId: user.id, hasOtp, required: false, requiredBy: [] }, user);
        return null;
      }
    }

    const state = await this.resolveLoginMfa(user);
    const outcome = await this.afterLoginSuccess(user.email, state, user);
    return outcome?.kind === 'enrollment_required' ? { enrollUrl: outcome.enrollUrl } : null;
  }

  // ── Self-service ──

  async status(userId: string) {
    const [user, available] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          mfaEnrolledAt: true,
          teamMembers: { where: { team: { requireMfa: true } }, select: { team: { select: { id: true, name: true } } } },
        },
      }),
      this.keycloak.directGrantValidatesOtp(),
    ]);
    if (!user) throw new UnauthorizedException();

    let factors: Array<{ id: string; type: string; userLabel: string | null; createdDate: number | null }> = [];
    let factorsKnown = true;
    try {
      factors = await this.keycloak.getUserOtpCredentials('master', userId);
    } catch (err: any) {
      factorsKnown = false;
      this.logger.warn(`Could not list authenticators for ${userId}: ${err?.message ?? err}`);
    }
    const mirror = user.mfaEnrolledAt != null;
    // Keycloak unreachable: report the mirror and leave it alone.
    const enabled = factorsKnown ? factors.length > 0 : mirror;
    if (factorsKnown && enabled && !mirror) {
      await this.setMirror(userId, true).catch(() => undefined);
      this.notify(user.email, 'enabled');
    } else if (factorsKnown && !enabled && mirror) {
      await this.setMirror(userId, false).catch(() => undefined);
    }

    // Turning the factor off re-authenticates with the password; accounts
    // without one need a root reset (the dashboard says so).
    const methods = await this.keycloak.getPlatformUserSignInMethodsById(userId, user.email).catch(() => null);
    const selfServiceDisable = !methods || (methods.signOnMethod === 'local' && methods.hasPasswordAuth);

    return {
      available,
      enabled,
      enrolledAt: enabled ? (user.mfaEnrolledAt ?? new Date()).toISOString() : null,
      factors,
      requiredByTeams: user.teamMembers.map((m) => m.team),
      selfServiceDisable,
      enrollUrl: available && !enabled ? this.buildEnrollUrl(user.email) : null,
    };
  }

  /** The URL that opens Keycloak's authenticator setup for this account. */
  async enrollUrlFor(userId: string, next?: string): Promise<string> {
    if (!(await this.keycloak.directGrantValidatesOtp())) {
      throw mfaUnavailable('two-factor authentication cannot be enabled');
    }
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) throw new UnauthorizedException();
    if (await this.isServiceAccount(userId)) {
      throw new ForbiddenException({ code: 'MFA_SERVICE_ACCOUNT', message: 'This account cannot use two-factor authentication.' });
    }
    return this.buildEnrollUrl(user.email, next);
  }

  /**
   * Turns two-factor authentication off: re-authenticates with password and
   * code, then removes every authenticator. Refused while a team requires it.
   */
  async disable(userId: string, password: string, code: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        teamMembers: { where: { team: { requireMfa: true } }, select: { team: { select: { name: true } } } },
      },
    });
    if (!user) throw new UnauthorizedException();
    if (user.teamMembers.length > 0) {
      throw new ForbiddenException({
        code: 'MFA_REQUIRED_BY_TEAM',
        message: `Two-factor authentication is required by ${user.teamMembers.map((m) => m.team.name).join(', ')}.`,
      });
    }

    const methods = await this.keycloak.getPlatformUserSignInMethodsById(userId, user.email).catch(() => null);
    // Without a password there is nothing but the code itself to re-authenticate
    // with, which would let anyone holding a session remove the factor. Those
    // accounts go through a root reset instead.
    if (methods && (methods.signOnMethod !== 'local' || !methods.hasPasswordAuth)) {
      throw new ForbiddenException({
        code: 'MFA_SOCIAL_ACCOUNT',
        message: 'Accounts that sign in with an identity provider cannot turn two-factor authentication off here; ask a root administrator to reset it.',
      });
    }

    const ok = await this.reauthenticate(user.email, password, code);
    if (!ok) throw new UnauthorizedException('Invalid credentials');

    const factors = await this.keycloak.getUserOtpCredentials('master', userId);
    for (const f of factors) {
      await this.keycloak.removeUserCredential('master', userId, f.id);
    }
    await this.setMirror(userId, false);
    this.notify(user.email, 'disabled');
    return { message: 'Two-factor authentication turned off', removed: factors.length };
  }

  /** Root recovery: removes the authenticators and any pending setup action. */
  async resetForUser(userId: string) {
    const factors = await this.keycloak.getUserOtpCredentials('master', userId);
    for (const f of factors) {
      await this.keycloak.removeUserCredential('master', userId, f.id);
    }
    await this.keycloak.removeUserRequiredAction('master', userId, CONFIGURE_TOTP).catch(() => undefined);
    await this.setMirror(userId, false).catch(() => undefined);
    return { message: 'Two-factor authentication reset', removed: factors.length };
  }

  // ── Team policy support ──

  /** Whether any team other than `exceptTeamId` requires two-factor authentication for the user. */
  async requiredElsewhere(userId: string, exceptTeamId: string): Promise<boolean> {
    const n = await this.prisma.teamMember.count({
      where: { userId, teamId: { not: exceptTeamId }, team: { requireMfa: true } },
    });
    return n > 0;
  }

  /** Removes a pending setup action from a user who is no longer required to enrol. Best effort. */
  async releasePendingSetup(userId: string): Promise<void> {
    try {
      if (await this.keycloak.userHasRequiredAction('master', userId, CONFIGURE_TOTP)) {
        await this.keycloak.removeUserRequiredAction('master', userId, CONFIGURE_TOTP);
      }
    } catch (err: any) {
      this.logger.warn(`Could not release authenticator setup for ${userId}: ${err?.message ?? err}`);
    }
  }

  async hasOtp(userId: string): Promise<boolean> {
    return this.keycloak.userHasOtpCredential('master', userId);
  }

  isAvailable(): Promise<boolean> {
    return this.keycloak.directGrantValidatesOtp();
  }

  // ── Internals ──

  /**
   * Keycloak's authenticator page through the platform OAuth client. On
   * completion Keycloak returns to the OAuth callback, which hands tokens to
   * `/login`, which follows `next`. `prompt=login` makes Keycloak ask for the
   * password even when it holds a browser session.
   */
  buildEnrollUrl(email: string, next = '/dashboard/account?mfa=enrolled'): string {
    const keycloakUrl = this.config.get<string>('keycloak.publicUrl');
    const publicApiUrl = this.config.get<string>('publicApiUrl');
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard/account?mfa=enrolled';
    // `mfaEnroll` tells the OAuth callback that this round trip ends an
    // enrolment, so it records the new factor even if the dashboard page that
    // would otherwise notice it is never opened.
    const state = Buffer.from(
      JSON.stringify({ redirectTo: `/login?next=${encodeURIComponent(safeNext)}`, mfaEnroll: true }),
    ).toString('base64url');
    const params = new URLSearchParams({
      client_id: this.keycloak.getPlatformOAuthClientId(),
      response_type: 'code',
      scope: 'openid email profile',
      redirect_uri: `${publicApiUrl}/api/auth/oauth/callback`,
      state,
      kc_action: CONFIGURE_TOTP,
      prompt: 'login',
      login_hint: email,
    });
    return `${keycloakUrl}/realms/master/protocol/openid-connect/auth?${params.toString()}`;
  }

  private async reauthenticate(email: string, password: string, code: string): Promise<boolean> {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const clientId = this.config.get<string>('keycloak.adminClientId');
    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: clientId!,
      username: email,
      password,
      totp: code,
    });
    try {
      await firstValueFrom(
        this.http.post(`${keycloakUrl}/realms/master/protocol/openid-connect/token`, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /** The Keycloak admin account the API itself signs in with must never need a code. */
  private async isServiceAccount(userId: string): Promise<boolean> {
    const adminUser = (this.config.get<string>('keycloak.adminUser') || '').toLowerCase();
    if (!adminUser) return false;
    const username = await this.keycloak.getPlatformUsername(userId).catch(() => null);
    return !!username && username.toLowerCase() === adminUser;
  }

  private async setMirror(userId: string, enrolled: boolean): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { mfaEnrolledAt: enrolled ? new Date() : null },
    });
  }

  private notify(to: string, change: 'enabled' | 'disabled') {
    const title =
      change === 'enabled'
        ? 'Two-factor authentication was turned on'
        : 'Two-factor authentication was turned off';
    const body =
      change === 'enabled'
        ? 'An authenticator app was added to your basefyio account. Signing in now asks for a code from it.'
        : 'The authenticator was removed from your basefyio account. Signing in no longer asks for a code.';
    const html = `<h2>${title}</h2><p>${body}</p><p>If this was not you, change your password now and contact support.</p>`;
    this.email.sendRawHtml(to, `[basefyio] ${title}`, html).catch(() => undefined);
  }
}
