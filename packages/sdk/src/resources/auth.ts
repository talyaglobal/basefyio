import { HttpClient } from '../http';
import type { AuthSession, AuthUser, SignInParams, SignUpParams } from '../types';

export class AuthResource {
  constructor(private readonly http: HttpClient) {}

  async signIn(params: SignInParams): Promise<AuthSession> {
    const session = await this.http.post<AuthSession>('/auth/login', params);
    this.http.setToken(session.accessToken);
    return session;
  }

  async signUp(params: SignUpParams): Promise<{ message: string }> {
    return this.http.post('/auth/signup', params);
  }

  async signOut(): Promise<void> {
    await this.http.post('/auth/logout').catch(() => {});
    this.http.setToken(null);
  }

  async refresh(refreshToken: string): Promise<AuthSession> {
    const session = await this.http.post<AuthSession>('/auth/refresh', { refreshToken });
    this.http.setToken(session.accessToken);
    return session;
  }

  me(): Promise<AuthUser> {
    return this.http.get('/auth/me');
  }

  forgotPassword(email: string): Promise<{ message: string }> {
    return this.http.post('/auth/forgot-password', { email });
  }

  resetPassword(otp: string, newPassword: string): Promise<void> {
    return this.http.post('/auth/reset-password', { otp, newPassword });
  }
}
