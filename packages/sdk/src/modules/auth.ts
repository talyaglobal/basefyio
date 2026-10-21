import type { BasefyioFetchClient } from '../lib/fetch.js';
import type {
  BasefyioResponse,
  AuthTokens,
  SignUpCredentials,
  SignInCredentials,
  User,
  Session,
  AuthChangeEvent,
  AuthChangeListener,
  VerifyEmailResult,
  ForgotPasswordResult,
  ResetPasswordResult,
  MagicLinkResult,
  MagicLinkVerifyResult,
  ChangeEmailResult,
  ConfirmChangeEmailResult,
  ReauthResult,
  ReauthVerifyResult,
  InviteUserResult,
  OAuthRedirectResult,
  OAuthProvider,
  BasefyioError,
} from '../lib/types.js';

// ── Multi-factor authentication (TOTP) ─────────────────────

/**
 * Returned by signIn instead of tokens when the account has an enrolled
 * authenticator app, or when the project requires one to be enrolled first.
 */
export interface MfaChallenge {
  challengeId: string;
  /** 'totp' — a code from the authenticator app; 'recovery' — a one-time recovery code. */
  methods: Array<'totp' | 'recovery'>;
  /** Seconds until the challenge expires and the person must sign in again. */
  expiresIn: number;
  /** No factor yet but the project requires one: call enrollMfa({ challengeId }) next. */
  enrollmentRequired: boolean;
}

/**
 * The signIn result. `data`/`error` behave exactly as before; `mfa` is set
 * (and `data` is null) when a second step is needed.
 */
export type SignInResponse = BasefyioResponse<AuthTokens> & { mfa: MfaChallenge | null };

/** Password sign-in; `totp` is for accounts whose authenticator lives in the hosted login. */
export type SignInWithTotp = SignInCredentials & { totp?: string };

export interface MfaEnrollment {
  /** Base32 secret, in case the app wants to show it for manual entry. */
  secret: string;
  /** Render this as a QR code for the authenticator app. */
  otpauthUrl: string;
  issuer: string;
  account: string;
  algorithm: string;
  digits: number;
  period: number;
}

export interface MfaEnrollmentResult {
  enabled: true;
  /** Shown once. Each works a single time in place of an authenticator code. */
  recoveryCodes: string[];
  // Present when enrollment completed a sign-in challenge: a session was started.
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  userId?: string;
  emailVerified?: boolean;
}

export interface MfaStatus {
  enrolled: boolean;
  /** An administrator asked this user to enroll. */
  enrollmentRequired: boolean;
  recoveryCodesLeft: number;
  verifiedAt: string | null;
}

export interface AnonymousUpgradeCredentials {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
}

type MfaChallengeBody = { mfaRequired: true } & MfaChallenge;

function isMfaChallengeBody(data: unknown): data is MfaChallengeBody {
  return (
    typeof data === 'object' &&
    data !== null &&
    (data as { mfaRequired?: unknown }).mfaRequired === true &&
    typeof (data as { challengeId?: unknown }).challengeId === 'string'
  );
}

export class AuthClient {
  private http: BasefyioFetchClient;
  private session: Session | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<AuthChangeListener> = new Set();
  private autoRefresh: boolean;

  constructor(http: BasefyioFetchClient, autoRefresh = true) {
    this.http = http;
    this.autoRefresh = autoRefresh;
  }

  async signUp(credentials: SignUpCredentials): Promise<BasefyioResponse<AuthTokens>> {
    try {
      const data = await this.http.json<AuthTokens>('/rest/v1/auth/signup', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      this.setSession(data);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  /**
   * Sign in with email and password.
   *
   * When the account has an enrolled authenticator app the response carries
   * `mfa` instead of `data`: keep the `challengeId`, ask for the code and call
   * `verifyMfa(challengeId, code)` to finish. Code that only reads `data` and
   * `error` keeps working: it sees a sign-in that did not produce a session.
   */
  async signIn(credentials: SignInWithTotp): Promise<SignInResponse> {
    try {
      const data = await this.http.json<AuthTokens | MfaChallengeBody>('/rest/v1/auth/signin', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      if (isMfaChallengeBody(data)) {
        const { mfaRequired: _required, ...mfa } = data;
        return {
          data: null,
          error: { message: 'Multi-factor authentication required', code: 'mfa_required' },
          mfa,
        };
      }
      this.setSession(data);
      return { data, error: null, mfa: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err), mfa: null };
    }
  }

  /**
   * Second step of sign-in: trade the challenge from signIn and the
   * authenticator code — or, with `{ recovery: true }`, a recovery code — for
   * a session.
   */
  async verifyMfa(
    challengeId: string,
    code: string,
    options?: { recovery?: boolean },
  ): Promise<BasefyioResponse<AuthTokens>> {
    try {
      const body = options?.recovery ? { challengeId, recoveryCode: code } : { challengeId, code };
      const data = await this.http.json<AuthTokens>('/rest/v1/auth/mfa/challenge', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      this.setSession(data);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
    }
  }

  /** Whether the signed-in user has an authenticator app enrolled, and whether one is required. */
  async getMfaStatus(): Promise<BasefyioResponse<MfaStatus>> {
    try {
      const data = await this.http.json<MfaStatus>('/rest/v1/auth/mfa');
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
    }
  }

  /**
   * Start enrolling an authenticator app (TOTP) for the signed-in user. Show
   * `otpauthUrl` as a QR code, then pass the first code the app displays to
   * `verifyMfaEnrollment`. With `{ challengeId }` from a signIn whose
   * `mfa.enrollmentRequired` was true, no session is needed.
   */
  async enrollMfa(options?: { challengeId?: string }): Promise<BasefyioResponse<MfaEnrollment>> {
    try {
      const data = await this.http.json<MfaEnrollment>('/rest/v1/auth/mfa/enroll', {
        method: 'POST',
        body: JSON.stringify(options?.challengeId ? { challengeId: options.challengeId } : {}),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
    }
  }

  /** Confirm the new authenticator with its first code. Returns the recovery codes — shown once. */
  async verifyMfaEnrollment(
    code: string,
    options?: { challengeId?: string },
  ): Promise<BasefyioResponse<MfaEnrollmentResult>> {
    try {
      const data = await this.http.json<MfaEnrollmentResult>('/rest/v1/auth/mfa/verify-enrollment', {
        method: 'POST',
        body: JSON.stringify(options?.challengeId ? { code, challengeId: options.challengeId } : { code }),
      });
      if (data.accessToken && data.refreshToken) {
        this.setSession({
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          expiresIn: data.expiresIn ?? 300,
          tokenType: data.tokenType ?? 'Bearer',
          userId: data.userId,
          emailVerified: data.emailVerified,
        });
      }
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
    }
  }

  /** Turn the authenticator off. Needs a current code, or a recovery code with `{ recovery: true }`. */
  async disableMfa(code: string, options?: { recovery?: boolean }): Promise<BasefyioResponse<{ enabled: false }>> {
    try {
      const body = options?.recovery ? { recoveryCode: code } : { code };
      const data = await this.http.json<{ enabled: false }>('/rest/v1/auth/mfa/disable', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
    }
  }

  /** Replace the recovery codes; the old ones stop working. Needs a current authenticator code. */
  async regenerateRecoveryCodes(code: string): Promise<BasefyioResponse<{ recoveryCodes: string[] }>> {
    try {
      const data = await this.http.json<{ recoveryCodes: string[] }>('/rest/v1/auth/mfa/recovery-codes', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
    }
  }

  // ── Anonymous users ─────────────────────────────────────

  /**
   * Start a session without an account. The project must allow anonymous
   * sign-in. The access token carries `is_anonymous: true`, which row-level
   * policies can read; `upgradeAnonymous` later turns it into a real account
   * with the same user id.
   */
  async signInAnonymously(): Promise<BasefyioResponse<AuthTokens & { isAnonymous: true }>> {
    try {
      const data = await this.http.json<AuthTokens & { isAnonymous: true }>('/rest/v1/auth/signin/anonymous', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      this.setSession(data);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
    }
  }

  /** Give the current anonymous session an email and password. The session is replaced with a normal one. */
  async upgradeAnonymous(credentials: AnonymousUpgradeCredentials): Promise<BasefyioResponse<AuthTokens>> {
    try {
      const data = await this.http.json<AuthTokens>('/rest/v1/auth/anonymous/upgrade', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      this.setSession(data);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
    }
  }

  /** Whether the current session belongs to an anonymous user (read from the token; the server verifies). */
  isAnonymous(): boolean {
    const value = this.accessTokenClaims()?.is_anonymous;
    return value === true || value === 'true';
  }

  async signOut(): Promise<void> {
    this.clearSession();
  }

  async verifyEmail(otp: string): Promise<BasefyioResponse<VerifyEmailResult>> {
    try {
      const data = await this.http.json<VerifyEmailResult>('/rest/v1/auth/verify-email', {
        method: 'POST',
        body: JSON.stringify({ otp }),
      });
      this.emit('EMAIL_VERIFIED');
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async forgotPassword(email: string): Promise<BasefyioResponse<ForgotPasswordResult>> {
    try {
      const data = await this.http.json<ForgotPasswordResult>('/rest/v1/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async resetPassword(otp: string, newPassword: string): Promise<BasefyioResponse<ResetPasswordResult>> {
    try {
      const data = await this.http.json<ResetPasswordResult>('/rest/v1/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ otp, newPassword }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async sendMagicLink(email: string): Promise<BasefyioResponse<MagicLinkResult>> {
    try {
      const data = await this.http.json<MagicLinkResult>('/rest/v1/auth/magic-link', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async verifyMagicLink(otp: string): Promise<BasefyioResponse<MagicLinkVerifyResult>> {
    try {
      const data = await this.http.json<MagicLinkVerifyResult>('/rest/v1/auth/magic-link/verify', {
        method: 'POST',
        body: JSON.stringify({ otp }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async changeEmail(newEmail: string): Promise<BasefyioResponse<ChangeEmailResult>> {
    try {
      const data = await this.http.json<ChangeEmailResult>('/rest/v1/auth/change-email', {
        method: 'POST',
        body: JSON.stringify({ newEmail }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async confirmChangeEmail(otp: string): Promise<BasefyioResponse<ConfirmChangeEmailResult>> {
    try {
      const data = await this.http.json<ConfirmChangeEmailResult>('/rest/v1/auth/change-email/verify', {
        method: 'POST',
        body: JSON.stringify({ otp }),
      });
      this.emit('EMAIL_CHANGED');
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async requestReauth(): Promise<BasefyioResponse<ReauthResult>> {
    try {
      const data = await this.http.json<ReauthResult>('/rest/v1/auth/reauth', {
        method: 'POST',
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async verifyReauth(otp: string): Promise<BasefyioResponse<ReauthVerifyResult>> {
    try {
      const data = await this.http.json<ReauthVerifyResult>('/rest/v1/auth/reauth/verify', {
        method: 'POST',
        body: JSON.stringify({ otp }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async inviteUser(email: string): Promise<BasefyioResponse<InviteUserResult>> {
    try {
      const data = await this.http.json<InviteUserResult>('/rest/v1/auth/invite', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async signInWithProvider(
    provider: OAuthProvider | string,
    options?: { redirectTo?: string },
  ): Promise<BasefyioResponse<OAuthRedirectResult>> {
    try {
      const params = new URLSearchParams();
      if (options?.redirectTo) params.set('redirect_to', options.redirectTo);
      const qs = params.toString();
      const url = `/rest/v1/auth/signin/${provider}${qs ? `?${qs}` : ''}`;
      const data = await this.http.json<OAuthRedirectResult>(url);
      if (typeof window !== 'undefined' && data.url) {
        window.location.href = data.url;
      }
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  handleProviderCallback(): AuthTokens | null {
    if (typeof window === 'undefined') return null;
    const hash = window.location.hash.substring(1);
    if (!hash) return null;

    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const expiresIn = params.get('expires_in');

    if (!accessToken || !refreshToken) return null;

    const tokens: AuthTokens = {
      accessToken,
      refreshToken,
      expiresIn: parseInt(expiresIn || '300', 10),
      tokenType: params.get('token_type') || 'Bearer',
    };

    this.setSession(tokens);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return tokens;
  }

  async getUser(): Promise<BasefyioResponse<User>> {
    try {
      const data = await this.http.json<User>('/rest/v1/auth/me');
      if (this.session) {
        this.session.user = data;
      }
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  getSession(): Session | null {
    return this.session;
  }

  getAccessToken(): string | null {
    return this.session?.accessToken ?? null;
  }

  async refreshSession(): Promise<BasefyioResponse<AuthTokens>> {
    if (!this.session?.refreshToken) {
      return { data: null, error: { message: 'No refresh token available' } };
    }
    try {
      const data = await this.http.json<AuthTokens>('/rest/v1/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refreshToken: this.session.refreshToken }),
      });
      this.setSession(data);
      this.emit('TOKEN_REFRESHED');
      return { data, error: null };
    } catch (err: any) {
      this.clearSession();
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  setAccessToken(token: string): void {
    if (!this.session) {
      this.session = {
        user: { sub: '', email: '', preferred_username: '' },
        accessToken: token,
        refreshToken: '',
        expiresAt: 0,
      };
    } else {
      this.session.accessToken = token;
    }
  }

  onAuthStateChange(listener: AuthChangeListener): { unsubscribe: () => void } {
    this.listeners.add(listener);
    return {
      unsubscribe: () => {
        this.listeners.delete(listener);
      },
    };
  }

  // ── Internal ───────────────────────────────────────────

  private toError(err: any): BasefyioError {
    return {
      message: err?.message ?? 'Request failed',
      status: err?.status,
      code: typeof err?.code === 'string' ? err.code : undefined,
    };
  }

  /** The access token's claims, read without verification — for display decisions only. */
  private accessTokenClaims(): Record<string, unknown> | null {
    const part = this.session?.accessToken?.split('.')[1];
    if (!part) return null;
    try {
      const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
      const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
      const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  private setSession(tokens: AuthTokens): void {
    const expiresAt = Date.now() + tokens.expiresIn * 1000;
    this.session = {
      user: { sub: '', email: '', preferred_username: '' },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt,
    };

    this.emit('SIGNED_IN');
    this.scheduleRefresh(tokens.expiresIn);
    this.getUser().catch(() => {});
  }

  private clearSession(): void {
    this.session = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.emit('SIGNED_OUT');
  }

  private scheduleRefresh(expiresInSec: number): void {
    if (!this.autoRefresh) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);

    const delay = Math.max((expiresInSec - 30) * 1000, 5000);
    this.refreshTimer = setTimeout(() => this.refreshSession(), delay);
  }

  private emit(event: AuthChangeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event, this.session);
      } catch {}
    }
  }
}
