import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { randomBytes } from 'crypto';
import { KeycloakAdminService } from './keycloak-admin.service';
import { PrismaService } from '../../prisma/prisma.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

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
        select: { email: true, username: true, notifySignIn: true },
      });
      if (user?.email && user.notifySignIn) {
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

  async forgotPassword(email: string) {
    const kcUser = await this.keycloak.findPlatformUserByEmail(email);
    if (!kcUser) {
      // Return success even if user doesn't exist to prevent email enumeration
      return { message: 'If that email exists, a reset link has been sent.' };
    }

    // Invalidate any previous unused tokens for this email
    await this.prisma.passwordResetToken.updateMany({
      where: { email, usedAt: null },
      data: { usedAt: new Date() },
    });

    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.passwordResetToken.create({
      data: { email, token, expiresAt },
    });

    const username = kcUser.username || email;
    await this.email.sendPasswordResetLink(email, username, token);

    this.logger.log(`Password reset link sent to ${email}`);
    return { message: 'If that email exists, a reset link has been sent.' };
  }

  async resetPassword(token: string, newPassword: string) {
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { token },
    });

    if (!resetToken) {
      throw new BadRequestException('Invalid or expired reset link.');
    }

    if (resetToken.usedAt) {
      throw new BadRequestException('This reset link has already been used.');
    }

    if (resetToken.expiresAt < new Date()) {
      throw new BadRequestException('This reset link has expired. Please request a new one.');
    }

    let kcUser: any;

    if (resetToken.realm) {
      kcUser = await this.keycloak.findUserByEmailInRealm(resetToken.realm, resetToken.email);
      if (!kcUser || !kcUser.id) {
        throw new BadRequestException('User account not found.');
      }
      await this.keycloak.resetUserPasswordInRealm(resetToken.realm, kcUser.id, newPassword);
    } else {
      kcUser = await this.keycloak.findPlatformUserByEmail(resetToken.email);
      if (!kcUser || !kcUser.id) {
        throw new BadRequestException('User account not found.');
      }
      await this.keycloak.resetPlatformUserPassword(kcUser.id, newPassword);
    }

    await this.prisma.passwordResetToken.update({
      where: { id: resetToken.id },
      data: { usedAt: new Date() },
    });

    this.logger.log(`Password successfully reset for ${resetToken.email}`);
    return { message: 'Your password has been reset. You can now sign in.' };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      githubUsername: user.githubUsername,
      notifySignIn: user.notifySignIn,
      notifyTeamInvite: user.notifyTeamInvite,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  async updateProfile(
    userId: string,
    data: {
      username?: string;
      email?: string;
      githubUsername?: string;
      avatarUrl?: string;
      notifySignIn?: boolean;
      notifyTeamInvite?: boolean;
    },
  ) {
    const updateData: Record<string, any> = {};

    if (data.username !== undefined) {
      const existing = await this.prisma.user.findFirst({
        where: { username: data.username, NOT: { id: userId } },
      });
      if (existing) throw new ConflictException('Username already taken');
      updateData.username = data.username;
    }

    if (data.email !== undefined) {
      const existing = await this.prisma.user.findFirst({
        where: { email: data.email, NOT: { id: userId } },
      });
      if (existing) throw new ConflictException('Email already registered');
      updateData.email = data.email;
    }

    if (data.githubUsername !== undefined) {
      if (data.githubUsername) {
        const existing = await this.prisma.user.findFirst({
          where: { githubUsername: data.githubUsername, NOT: { id: userId } },
        });
        if (existing) {
          throw new ConflictException(
            `GitHub account "${data.githubUsername}" is already linked to another user`,
          );
        }
      }
      updateData.githubUsername = data.githubUsername || null;
    }

    if (data.avatarUrl !== undefined) {
      updateData.avatarUrl = data.avatarUrl || null;
    }

    if (data.notifySignIn !== undefined) {
      updateData.notifySignIn = data.notifySignIn;
    }

    if (data.notifyTeamInvite !== undefined) {
      updateData.notifyTeamInvite = data.notifyTeamInvite;
    }

    const user = await this.prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    return {
      id: user.id,
      username: user.username,
      email: user.email,
      avatarUrl: user.avatarUrl,
      githubUsername: user.githubUsername,
      notifySignIn: user.notifySignIn,
      notifyTeamInvite: user.notifyTeamInvite,
      role: user.role,
      createdAt: user.createdAt,
    };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new BadRequestException('User not found');

    const keycloakUrl = this.config.get<string>('keycloak.url');
    const clientId = this.config.get<string>('keycloak.adminClientId');
    const tokenUrl = `${keycloakUrl}/realms/master/protocol/openid-connect/token`;

    const params = new URLSearchParams({
      grant_type: 'password',
      client_id: clientId!,
      username: user.username,
      password: currentPassword,
    });

    try {
      await firstValueFrom(
        this.http.post(tokenUrl, params.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        }),
      );
    } catch {
      throw new UnauthorizedException('Current password is incorrect');
    }

    await this.keycloak.resetPlatformUserPassword(userId, newPassword);
    this.logger.log(`Password changed for user ${userId}`);
    return { message: 'Password updated successfully' };
  }
}
