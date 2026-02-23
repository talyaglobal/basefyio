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
      const data = await this.http.json<AuthTokens>('/auth/signup', {
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
      const data = await this.http.json<AuthTokens>('/auth/login', {
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

  async getUser(): Promise<KolaybaseResponse<User>> {
    try {
      const data = await this.http.json<User>('/auth/me');
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
      const data = await this.http.json<AuthTokens>('/auth/refresh', {
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

    // Fetch user profile in background
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

    // Refresh 30 seconds before expiry
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
