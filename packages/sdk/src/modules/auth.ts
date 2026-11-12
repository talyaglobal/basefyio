import type { BasefyioFetchClient } from '../lib/fetch.js';
import { toBasefyioError } from '../lib/errors.js';
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
  AuthStorage,
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
  private persistence: { storage: AuthStorage; key: string } | null;
  private initialized: Promise<void>;

  /**
   * @param persistence Where to keep the session across page loads; null (the
   *   default) keeps it in memory only, as before.
   */
  constructor(
    http: BasefyioFetchClient,
    autoRefresh = true,
    persistence: { storage: AuthStorage; key: string } | null = null,
  ) {
    this.http = http;
    this.autoRefresh = autoRefresh;
    this.persistence = persistence;
    this.initialized = persistence ? this.restoreSession() : Promise.resolve();
  }

  /**
   * Resolves once a persisted session has been restored (with
   * `auth: { persistSession: true }`); immediately otherwise. Await it before
   * reading `getSession()` on page load.
   */
  ready(): Promise<void> {
    return this.initialized;
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
      return { data: null, error: this.toError(err) };
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

  /**
   * End the session: here at once, and on the server, where the refresh token
   * is revoked so it cannot mint new access tokens. `SIGNED_OUT` is emitted
   * only when there was a session to end. A failure to reach the server is
   * returned as `error`; the local session is cleared regardless.
   */
  async signOut(): Promise<{ error: BasefyioError | null }> {
    const refreshToken = this.session?.refreshToken;
    // Cleared first, so the revoke goes out with the project key alone — an
    // expired access token must not be what stops a sign-out.
    this.clearSession();
    if (!refreshToken) return { error: null };
    try {
      await this.http.json('/rest/v1/auth/signout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      });
      return { error: null };
    } catch (err: unknown) {
      const error = this.toError(err);
      // An API from before the revoke endpoint existed: the local sign-out is all there is.
      return { error: error.status === 404 ? null : error };
    }
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
      return { data: null, error: this.toError(err) };
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
      return { data: null, error: this.toError(err) };
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
      return { data: null, error: this.toError(err) };
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
      return { data: null, error: this.toError(err) };
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
      return { data: null, error: this.toError(err) };
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
      return { data: null, error: this.toError(err) };
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
      return { data: null, error: this.toError(err) };
    }
  }

  async requestReauth(): Promise<BasefyioResponse<ReauthResult>> {
    try {
      const data = await this.http.json<ReauthResult>('/rest/v1/auth/reauth', {
        method: 'POST',
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
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
      return { data: null, error: this.toError(err) };
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
      return { data: null, error: this.toError(err) };
    }
  }

  /**
   * Start an OAuth sign-in. In a browser the page is sent to the provider
   * straight away; pass `skipBrowserRedirect: true` to get `data.url` and
   * redirect yourself. Outside a browser `data.url` is all there is.
   */
  async signInWithProvider(
    provider: OAuthProvider | string,
    options?: { redirectTo?: string; skipBrowserRedirect?: boolean },
  ): Promise<BasefyioResponse<OAuthRedirectResult>> {
    try {
      const params = new URLSearchParams();
      if (options?.redirectTo) params.set('redirect_to', options.redirectTo);
      const qs = params.toString();
      const url = `/rest/v1/auth/signin/${encodeURIComponent(provider)}${qs ? `?${qs}` : ''}`;
      const data = await this.http.json<OAuthRedirectResult>(url);
      if (typeof window !== 'undefined' && data.url && !options?.skipBrowserRedirect) {
        window.location.href = data.url;
      }
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
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
        this.persist();
      }
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: this.toError(err) };
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
      // One event per refresh: TOKEN_REFRESHED (it used to be preceded by a
      // second SIGNED_IN for the same session).
      this.setSession(data, 'TOKEN_REFRESHED');
      return { data, error: null };
    } catch (err: any) {
      this.clearSession();
      return { data: null, error: this.toError(err) };
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

  private toError(err: unknown): BasefyioError {
    return toBasefyioError(err);
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

  private setSession(tokens: AuthTokens, event: AuthChangeEvent = 'SIGNED_IN'): void {
    const expiresAt = Date.now() + tokens.expiresIn * 1000;
    this.session = {
      // A refresh keeps the user already loaded; a new sign-in starts blank
      // until getUser() below fills it in.
      user:
        event === 'TOKEN_REFRESHED' && this.session
          ? this.session.user
          : { sub: '', email: '', preferred_username: '' },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt,
    };

    this.persist();
    this.emit(event);
    this.scheduleRefresh(tokens.expiresIn);
    this.getUser().catch(() => {});
  }

  /** Forget the session; SIGNED_OUT only when there was one to forget. */
  private clearSession(): void {
    const had = this.session !== null;
    this.session = null;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    this.persist();
    if (had) this.emit('SIGNED_OUT');
  }

  /** Bring back a stored session on start-up, refreshing it if it has expired. */
  private async restoreSession(): Promise<void> {
    const { storage, key } = this.persistence!;
    try {
      const raw = await storage.getItem(key);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved.accessToken === 'string' && typeof saved.refreshToken === 'string') {
        this.session = {
          user: saved.user ?? { sub: '', email: '', preferred_username: '' },
          accessToken: saved.accessToken,
          refreshToken: saved.refreshToken,
          expiresAt: Number(saved.expiresAt) || 0,
        };
        const remaining = (this.session.expiresAt - Date.now()) / 1000;
        if (remaining > 30) this.scheduleRefresh(remaining);
        else await this.refreshSession();
      }
    } catch {
      // Unreadable or corrupt storage: start signed out.
    }
    this.emit('INITIAL_SESSION');
  }

  /** Mirror the session into storage when persistence is on. Never throws. */
  private persist(): void {
    if (!this.persistence) return;
    const { storage, key } = this.persistence;
    try {
      const result = this.session
        ? storage.setItem(key, JSON.stringify(this.session))
        : storage.removeItem(key);
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Storage full or blocked: the in-memory session still works.
    }
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
