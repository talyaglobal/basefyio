import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { KeycloakAdminService } from './keycloak-admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly http: HttpService,
    private readonly keycloak: KeycloakAdminService,
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async signup(data: {
    username: string;
    email: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }) {
    const existingUser = await this.keycloak.findPlatformUserByUsername(data.username);
    if (existingUser) {
      throw new ConflictException('Username already taken');
    }

    const existingEmail = await this.keycloak.findPlatformUserByEmail(data.email);
    if (existingEmail) {
      throw new ConflictException('Email already registered');
    }

    let keycloakId: string;
    try {
      keycloakId = await this.keycloak.createPlatformUser(data);
    } catch (err: any) {
      throw new InternalServerErrorException(`Failed to create account: ${err.message}`);
    }

    const user = await this.prisma.user.create({
      data: {
        id: keycloakId,
        username: data.username,
        email: data.email,
        role: 'USER',
      },
    });

    const team = await this.prisma.team.create({
      data: {
        name: `${data.username}'s Team`,
        slug: `personal-${data.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
        personalForUserId: user.id,
        members: { create: { userId: user.id, role: 'OWNER' } },
      },
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { activeTeamId: team.id },
    });

    this.email.sendWelcome(data.email, data.username).catch(() => {});

    return this.login(data.username, data.password);
  }

  async ensureUserProfile(sub: string, email: string, username: string) {
    const existing = await this.prisma.user.findUnique({ where: { id: sub } });
    if (existing) return existing;

    try {
      const safeUsername = username || `user-${sub.slice(0, 8)}`;
      const safeEmail = email || `${sub.slice(0, 8)}@kolaybase.local`;

      const user = await this.prisma.user.create({
        data: { id: sub, username: safeUsername, email: safeEmail, role: 'USER' },
      });

      const slug = `personal-${safeUsername.toLowerCase().replace(/[^a-z0-9]/g, '')}-${sub.slice(0, 8)}`;

      const team = await this.prisma.team.create({
        data: {
          name: `${safeUsername}'s Team`,
          slug,
          personalForUserId: user.id,
          members: { create: { userId: user.id, role: 'OWNER' } },
        },
      });

      await this.prisma.user.update({
        where: { id: user.id },
        data: { activeTeamId: team.id },
      });

      return user;
    } catch (err: any) {
      const fallback = await this.prisma.user.findUnique({ where: { id: sub } });
      if (fallback) return fallback;
      throw err;
    }
  }

  async login(
    username: string,
    password: string,
    meta?: { ipAddress?: string; userAgent?: string },
  ) {
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

      const user = await this.prisma.user.findFirst({
        where: { OR: [{ username }, { email: username }] },
        select: { email: true, username: true },
      });
      if (user?.email) {
        this.email
          .sendSignInNotification(user.email, user.username, meta)
          .catch(() => {});
      }

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
