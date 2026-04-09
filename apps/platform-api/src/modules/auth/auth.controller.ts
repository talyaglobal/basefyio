import { Controller, Post, Body, Get, Param, Query, Res, UseGuards, Req, Put, Patch, UploadedFile, UseInterceptors, BadRequestException, Delete } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RootRoleGuard } from '../../common/guards/root-role.guard';
import { ManagementPermissionGuard } from '../../common/guards/management-permission.guard';
import { RequireManagementPermission } from '../../common/decorators/management-permission.decorator';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';
import { ObservabilityService } from '../observability/observability.service';
import { RequestWithTraceId } from '../../common/middleware/trace-id.middleware';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly keycloak: KeycloakAdminService,
    private readonly observability: ObservabilityService,
  ) {}

  @Post('signup')
  async signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Post('login')
  async login(@Body() dto: LoginDto, @Req() req: Request) {
    const ipAddress =
      (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
      req.ip;
    const userAgent = req.headers['user-agent'];
    return this.authService.login(dto.email, dto.password, {
      ipAddress,
      userAgent,
    }, dto.captchaAnswer);
  }

  @Get('captcha')
  async getLoginCaptcha(@Query('email') email: string) {
    return this.authService.getLoginCaptcha(email);
  }

  @Post('refresh')
  async refresh(@Body('refreshToken') refreshToken: string) {
    return this.authService.refresh(refreshToken);
  }

  @Post('logout')
  async logout(
    @Body('refreshToken') refreshToken: string,
    @Body('postLogoutRedirectUri') postLogoutRedirectUri?: string,
    @Body('idToken') idToken?: string,
  ) {
    if (!refreshToken) return { message: 'Logged out' };
    return this.authService.logout(refreshToken, postLogoutRedirectUri, idToken);
  }

  @Post('forgot-password')
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Post('reset-password')
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.password);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() user: JwtPayload) {
    await this.authService.ensureUserProfile(
      user.sub,
      user.email,
      user.preferred_username,
      {
        givenName: user.given_name,
        familyName: user.family_name,
        name: user.name,
      },
    );
    return user;
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getProfile(@CurrentUser() user: JwtPayload) {
    return this.authService.getProfile(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Put('profile')
  async updateProfile(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(user.sub, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() body: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      user.sub,
      user.email,
      body.currentPassword || '',
      body.newPassword,
      !!body.allowIdentityEdit,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('complete-forced-password-change')
  async completeForcedPasswordChange(
    @CurrentUser() user: JwtPayload,
    @Body() body: ChangePasswordDto,
  ) {
    return this.authService.completeForcedPasswordChange(user.sub, body.newPassword);
  }

  @UseGuards(JwtAuthGuard)
  @Post('avatar')
  @UseInterceptors(FileInterceptor('file', { storage: undefined }))
  async uploadAvatar(
    @CurrentUser() user: JwtPayload,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.authService.uploadAvatar(user.sub, file);
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageUsers')
  @Get('management/users')
  async managementUsers() {
    return this.authService.listManagementUsers();
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageUsers')
  @Patch('management/users/:id/role')
  async updateManagementUserRole(
    @CurrentUser() user: JwtPayload,
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @Body('role') role: string,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.authService.updateUserRoleByRoot(user.sub, id, role);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: role === 'ROOT' ? 'AUTH_ROLE_UPDATED_TO_ROOT' : 'AUTH_ROLE_UPDATED',
        resourceType: 'user',
        resourceId: id,
        severity: role === 'ROOT' ? 'CRITICAL' : 'MEDIUM',
        success: true,
        latencyMs: Date.now() - startedAt,
        afterJson: { role: result.role },
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'AUTH_ROLE_UPDATED',
        resourceType: 'user',
        resourceId: id,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
        metadataJson: { targetRole: role },
      });
      throw err;
    }
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageUsers')
  @Post('management/users/:id/reset-password')
  async resetManagementUserPassword(
    @CurrentUser() user: JwtPayload,
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @Body('newPassword') newPassword: string,
    @Body('forceChangeOnFirstLogin') forceChangeOnFirstLogin?: boolean,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.authService.resetManagementUserPasswordByRoot(
        user.sub,
        id,
        newPassword,
        !!forceChangeOnFirstLogin,
      );
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'AUTH_PASSWORD_RESET_BY_ROOT',
        resourceType: 'user',
        resourceId: id,
        severity: 'HIGH',
        success: true,
        latencyMs: Date.now() - startedAt,
        metadataJson: { forceChangeOnFirstLogin: !!forceChangeOnFirstLogin },
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'AUTH_PASSWORD_RESET_BY_ROOT',
        resourceType: 'user',
        resourceId: id,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageUsers')
  @Patch('management/users/:id/active')
  async updateManagementUserActive(
    @CurrentUser() user: JwtPayload,
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.authService.setManagementUserActiveByRoot(
        user.sub,
        id,
        !!isActive,
      );
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: !!isActive ? 'AUTH_USER_ACTIVATED' : 'AUTH_USER_DEACTIVATED',
        resourceType: 'user',
        resourceId: id,
        severity: !!isActive ? 'MEDIUM' : 'CRITICAL',
        success: true,
        latencyMs: Date.now() - startedAt,
        metadataJson: { isActive: !!isActive },
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'AUTH_USER_ACTIVE_UPDATED',
        resourceType: 'user',
        resourceId: id,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
        metadataJson: { isActive: !!isActive },
      });
      throw err;
    }
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageUsers')
  @Patch('management/users/:id/sign-in-method')
  async updateManagementUserSignInMethod(
    @CurrentUser() user: JwtPayload,
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
    @Body('method') method: 'local' | 'google' | 'github',
  ) {
    if (method !== 'local' && method !== 'google' && method !== 'github') {
      throw new BadRequestException('Invalid sign-in method');
    }
    const startedAt = Date.now();
    try {
      const result = await this.authService.setManagementUserSignInMethodByRoot(id, method);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'AUTH_SIGNIN_METHOD_UPDATED',
        resourceType: 'user',
        resourceId: id,
        severity: 'MEDIUM',
        success: true,
        latencyMs: Date.now() - startedAt,
        metadataJson: { method },
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'AUTH_SIGNIN_METHOD_UPDATED',
        resourceType: 'user',
        resourceId: id,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
        metadataJson: { method },
      });
      throw err;
    }
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageTeams')
  @Get('management/teams')
  async managementTeams() {
    return this.authService.listManagementTeams();
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canManageTeams')
  @Delete('management/teams/:id')
  async deleteManagementTeam(
    @CurrentUser() user: JwtPayload,
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.authService.deleteManagementTeamByRoot(id);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_DELETED',
        resourceType: 'team',
        resourceId: id,
        severity: 'CRITICAL',
        success: true,
        latencyMs: Date.now() - startedAt,
        metadataJson: { teamName: result.name },
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'TEAM_DELETED',
        resourceType: 'team',
        resourceId: id,
        severity: 'HIGH',
        success: false,
        latencyMs: Date.now() - startedAt,
      });
      throw err;
    }
  }

  @UseGuards(JwtAuthGuard, ManagementPermissionGuard)
  @RequireManagementPermission('canAccessManagement')
  @Get('management/my-permissions')
  async managementMyPermissions(@CurrentUser() user: JwtPayload) {
    return this.authService.getManagementPermissionsForUser(user.sub);
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Get('management/role-permissions')
  async managementRolePermissions() {
    return this.authService.getRolePermissionsByRoot();
  }

  @UseGuards(JwtAuthGuard, RootRoleGuard)
  @Patch('management/role-permissions/:role')
  async updateManagementRolePermissions(
    @Param('role') role: string,
    @Body()
    patch: {
      canAccessManagement?: boolean;
      canManageUsers?: boolean;
      canManageTeams?: boolean;
      canManagePlans?: boolean;
      canManageUserPackages?: boolean;
      canModerateFeedback?: boolean;
      canViewAuditLogs?: boolean;
      canViewRootAlerts?: boolean;
    },
  ) {
    const normalizedRole = (role || '').toUpperCase();
    if (
      normalizedRole !== 'USER' &&
      normalizedRole !== 'ADMIN' &&
      normalizedRole !== 'ROOT'
    ) {
      throw new BadRequestException('Invalid role');
    }
    return this.authService.updateRolePermissionsByRoot(
      normalizedRole as 'USER' | 'ADMIN' | 'ROOT',
      patch,
    );
  }

  @Get('oauth/providers')
  getOAuthProviders() {
    return { providers: this.keycloak.getEnabledPlatformProviders() };
  }

  @Get('oauth/callback')
  async oauthCallback(
    @Res() res: Response,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
  ) {
    const baseAppUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

    if (error || !code) {
      const msg = errorDescription || error || 'OAuth authentication failed';
      const loginUrl = `${baseAppUrl}/login?error=${encodeURIComponent(msg)}`;
      return res.redirect(loginUrl);
    }

    try {
      const result = await this.authService.handleOAuthCallback(code, state);

      const appUrl = result.redirectTo?.startsWith('http')
        ? result.redirectTo
        : `${baseAppUrl}${result.redirectTo || '/login'}`;

      const params = new URLSearchParams({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
        expires_in: String(result.expiresIn),
        token_type: result.tokenType || 'Bearer',
      });

      res.redirect(`${appUrl}#${params.toString()}`);
    } catch (err: any) {
      const loginUrl = `${baseAppUrl}/login?error=${encodeURIComponent('OAuth authentication failed')}`;
      res.redirect(loginUrl);
    }
  }

  @Get('oauth/:provider')
  getOAuthRedirect(
    @Param('provider') provider: string,
    @Query('redirect_to') redirectTo?: string,
  ) {
    return this.authService.getOAuthRedirectUrl(provider, redirectTo);
  }
}
