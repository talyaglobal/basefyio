import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProjectsService } from './projects.service';
import { ProjectAuthConfigService } from './project-auth-config.service';
import { KeycloakAdminService } from '../auth/keycloak-admin.service';
import { JwtOrApiKeyGuard } from '../../common/guards/jwt-or-apikey.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from './project-activity.service';

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

/** Build a Keycloak passwordPolicy string from structured flags. */
function buildPasswordPolicy(p: {
  minLength?: number;
  requireUppercase?: boolean;
  requireLowercase?: boolean;
  requireDigits?: boolean;
  requireSpecial?: boolean;
  historyCount?: number;
  expiryDays?: number;
}): string {
  const parts: string[] = [];
  if (p.minLength && p.minLength > 0) parts.push(`length(${p.minLength})`);
  if (p.requireUppercase) parts.push('upperCase(1)');
  if (p.requireLowercase) parts.push('lowerCase(1)');
  if (p.requireDigits) parts.push('digits(1)');
  if (p.requireSpecial) parts.push('specialChars(1)');
  if (p.historyCount && p.historyCount > 0) parts.push(`passwordHistory(${p.historyCount})`);
  if (p.expiryDays && p.expiryDays > 0) parts.push(`forceExpiredPasswordChange(${p.expiryDays})`);
  return parts.join(' and ');
}

/** Parse a Keycloak passwordPolicy string back into structured flags. */
function parsePasswordPolicy(s: string) {
  const str = s || '';
  const num = (re: RegExp) => {
    const m = re.exec(str);
    return m ? parseInt(m[1], 10) : 0;
  };
  return {
    minLength: num(/length\((\d+)\)/),
    requireUppercase: /upperCase\(/.test(str),
    requireLowercase: /lowerCase\(/.test(str),
    requireDigits: /digits\(/.test(str),
    requireSpecial: /specialChars\(/.test(str),
    historyCount: num(/passwordHistory\((\d+)\)/),
    expiryDays: num(/forceExpiredPasswordChange\((\d+)\)/),
  };
}

@Controller('projects/:projectId/auth')
@UseGuards(JwtOrApiKeyGuard)
export class ProjectAuthController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly keycloak: KeycloakAdminService,
    private readonly authConfigService: ProjectAuthConfigService,
    private readonly configService: ConfigService,
    private readonly activity: ProjectActivityService,
  ) {}

  @Get()
  async getRealmInfo(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.keycloak.getRealmInfo(project.keycloakRealm);
  }

  @Get('users')
  async listUsers(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.keycloak.listUsers(project.keycloakRealm);
  }

  @Get('users/:userId')
  async getUser(
    @Param('projectId') projectId: string,
    @Param('userId') userId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const realm = project.keycloakRealm;
    const [detail, providers, sessions] = await Promise.all([
      this.keycloak.getRealmUserById(realm, userId),
      this.keycloak.listUserFederatedIdentities(realm, userId).catch((): string[] => []),
      this.keycloak.listUserSessions(realm, userId).catch((): any[] => []),
    ]);
    if (!detail) throw new BadRequestException('User not found');
    // "Email" is always an available login method; linked OAuth providers add to it.
    const sessTimes = (sessions as any[]).map((s) => s.lastAccess || s.start || 0);
    const lastSignIn = sessTimes.length ? Math.max(...sessTimes) || null : null;
    return { ...detail, providers: ['email', ...providers], sessions, lastSignIn, sessionCount: sessions.length };
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
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `MFA enrollment ${enabled ? 'required' : 'cleared'}: ${userId}`,
    });
    return result;
  }

  // ── MFA ──
  @Get('mfa')
  async listMfaUsers(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    return this.keycloak.listMfaUsers(project.keycloakRealm);
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

  // ── Policies (brute-force + password) ──
  @Get('policies')
  async getPolicies(
    @Param('projectId') projectId: string,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const p = await this.keycloak.getRealmPolicies(project.keycloakRealm);
    return { ...p, password: parsePasswordPolicy(p.passwordPolicy) };
  }

  @Put('policies')
  async updatePolicies(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, any>,
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const update: Record<string, any> = {};
    for (const k of [
      'bruteForceProtected',
      'permanentLockout',
      'failureFactor',
      'waitIncrementSeconds',
      'maxFailureWaitSeconds',
    ]) {
      if (body[k] !== undefined) update[k] = body[k];
    }
    if (body.password) update.passwordPolicy = buildPasswordPolicy(body.password);
    await this.keycloak.updateRealmPolicies(project.keycloakRealm, update);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_CONFIG_UPDATED,
      title: 'Authentication policies updated',
    });
    const p = await this.keycloak.getRealmPolicies(project.keycloakRealm);
    return { ...p, password: parsePasswordPolicy(p.passwordPolicy) };
  }

  @Post('users')
  async createUser(
    @Param('projectId') projectId: string,
    @Body() body: { email: string; password: string; firstName?: string; lastName?: string },
    @CurrentUser() user?: JwtPayload,
  ) {
    const project = await this.projectsService.findOne(projectId, user?.sub);
    const email = body.email?.trim();
    if (!email) {
      throw new BadRequestException('Email is required');
    }
    // Enforce one account per email in the project's auth realm (the SDK signup
    // path already does this; the dashboard "Add User" path did not, which let
    // duplicate emails accumulate).
    const existing = await this.keycloak.findUserInRealm(project.keycloakRealm, email);
    if (existing) {
      throw new ConflictException('A user with this email already exists in this project');
    }
    const created = await this.keycloak.createUser(project.keycloakRealm, { ...body, email });
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_CREATED,
      title: `Auth user created: ${body.email}`,
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
    await this.keycloak.updateRealmUser(project.keycloakRealm, userId, body);
    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_USER_UPDATED,
      title: `Auth user updated: ${userId}`,
      detail: Object.keys(body).join(', '),
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

  @Put('config')
  async updateConfig(
    @Param('projectId') projectId: string,
    @Body() body: Record<string, any>,
    @CurrentUser() user?: JwtPayload,
  ) {
    await this.projectsService.findOne(projectId, user?.sub);
    return this.authConfigService.update(projectId, body, user?.sub);
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
    const exists = await this.keycloak.realmExists(realmName);
    if (exists) {
      return { message: 'Realm is healthy, no repair needed', realm: realmName };
    }

    await this.keycloak.createRealm(realmName);
    await this.keycloak.createClients(realmName);

    await this.activity.append(projectId, {
      userId: user?.sub,
      kind: ProjectActivityKind.AUTH_CONFIG_UPDATED,
      title: 'Authentication realm repaired',
      detail: `Realm "${realmName}" was re-provisioned`,
    });

    return { message: 'Realm repaired successfully', realm: realmName };
  }
}
