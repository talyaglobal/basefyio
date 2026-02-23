import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  async login(username: string, password: string) {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const clientId = this.config.get<string>('keycloak.adminClientId');

    const tokenUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/token`;

    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: clientId!,
      username,
      password,
    });

    try {
      const { data } = await firstValueFrom(
        this.http.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        tokenType: data.token_type,
      };
    } catch {
      throw new UnauthorizedException('Invalid credentials');
    }
  }

  async refresh(refreshToken: string) {
    const keycloakUrl = this.config.get<string>('keycloak.url');
    const clientId = this.config.get<string>('keycloak.adminClientId');

    const tokenUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/token`;

    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId!,
      refresh_token: refreshToken,
    });

    try {
      const { data } = await firstValueFrom(
        this.http.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }
}
