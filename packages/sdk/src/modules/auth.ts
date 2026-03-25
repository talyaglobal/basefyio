import type { KolaybaseFetchClient } from '../lib/fetch.js';
import type {
  KolaybaseResponse,
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
} from '../lib/types.js';

export class AuthClient {
  private http: KolaybaseFetchClient;
  private session: Session | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners: Set<AuthChangeListener> = new Set();
  private autoRefresh: boolean;

  constructor(http: KolaybaseFetchClient, autoRefresh = true) {
    this.http = http;
    this.autoRefresh = autoRefresh;
  }

  async signUp(credentials: SignUpCredentials): Promise<KolaybaseResponse<AuthTokens>> {
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

  async signIn(credentials: SignInCredentials): Promise<KolaybaseResponse<AuthTokens>> {
    try {
      const data = await this.http.json<AuthTokens>('/rest/v1/auth/signin', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      this.setSession(data);
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async signOut(): Promise<void> {
    this.clearSession();
  }

  async verifyEmail(otp: string): Promise<KolaybaseResponse<VerifyEmailResult>> {
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

  async forgotPassword(email: string): Promise<KolaybaseResponse<ForgotPasswordResult>> {
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

  async resetPassword(otp: string, newPassword: string): Promise<KolaybaseResponse<ResetPasswordResult>> {
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

  async sendMagicLink(email: string): Promise<KolaybaseResponse<MagicLinkResult>> {
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

  async verifyMagicLink(otp: string): Promise<KolaybaseResponse<MagicLinkVerifyResult>> {
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

  async changeEmail(newEmail: string): Promise<KolaybaseResponse<ChangeEmailResult>> {
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

  async confirmChangeEmail(otp: string): Promise<KolaybaseResponse<ConfirmChangeEmailResult>> {
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

  async requestReauth(): Promise<KolaybaseResponse<ReauthResult>> {
    try {
      const data = await this.http.json<ReauthResult>('/rest/v1/auth/reauth', {
        method: 'POST',
      });
      return { data, error: null };
    } catch (err: any) {
      return { data: null, error: { message: err.message, status: err.status } };
    }
  }

  async verifyReauth(otp: string): Promise<KolaybaseResponse<ReauthVerifyResult>> {
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

  async inviteUser(email: string): Promise<KolaybaseResponse<InviteUserResult>> {
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
    provider: OAuthProvider,
    options?: { redirectTo?: string },
  ): Promise<KolaybaseResponse<OAuthRedirectResult>> {
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

  async getUser(): Promise<KolaybaseResponse<User>> {
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

  async refreshSession(): Promise<KolaybaseResponse<AuthTokens>> {
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
