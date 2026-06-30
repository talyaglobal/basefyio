import { Controller, Post, Body, Get, Param, Query, Res, UseGuards, Req, Put, Patch, UploadedFile, UseInterceptors, BadRequestException, Delete, HttpCode, HttpStatus, Inject } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyResetTokenDto } from './dto/verify-reset-token.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { VerifySignupOtpDto } from './dto/verify-signup-otp.dto';
import { ResendSignupOtpDto } from './dto/resend-signup-otp.dto';
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
import { RateLimitGuard, RateLimit } from '../../common/guards/rate-limit.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly keycloak: KeycloakAdminService,
    private readonly observability: ObservabilityService,
  ) {}

  @Post('signup')
  @UseGuards(RateLimitGuard)
  @RateLimit(5, 60) // 5 requests per minute per IP
  async signup(@Body() dto: SignupDto) {
    return this.authService.initiateSignup(dto);
  }

  @Post('signup/verify-otp')
  async verifySignupOtp(@Body() dto: VerifySignupOtpDto) {
    return this.authService.verifySignupOtp(dto.email, dto.otp);
  }

  @Post('signup/resend-otp')
  async resendSignupOtp(@Body() dto: ResendSignupOtpDto) {
    return this.authService.resendSignupOtp(dto.email);
  }

  @Post('login')
  @UseGuards(RateLimitGuard)
  @RateLimit(10, 60) // 10 login attempts per minute per IP
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
  @UseGuards(RateLimitGuard)
  @RateLimit(30, 60) // 30 refresh requests per minute per IP
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
  @UseGuards(RateLimitGuard)
  @RateLimit(3, 60) // 3 requests per minute per IP
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email);
  }

  @Post('reset-password/verify')
  @HttpCode(HttpStatus.OK)
  async verifyResetToken(@Body() dto: VerifyResetTokenDto) {
    return this.authService.verifyResetToken(dto.token);
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
  async managementUsers(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('q') q?: string,
  ) {
    const p = page != null && page.trim() !== '' ? Number(page) : 1;
    const ps = pageSize != null && pageSize.trim() !== '' ? Number(pageSize) : 20;
    return this.authService.listManagementUsersPage({
      page: Number.isFinite(p) && p > 0 ? p : 1,
      pageSize: Number.isFinite(ps) && ps > 0 ? ps : 20,
      q: q?.trim() || undefined,
    });
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
  @Post('management/users/:id/unlock')
  async unlockManagementUser(
    @CurrentUser() user: JwtPayload,
    @Req() req: RequestWithTraceId,
    @Param('id') id: string,
  ) {
    const startedAt = Date.now();
    try {
      const result = await this.authService.unlockManagementUserAccount(id);
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'AUTH_USER_UNLOCKED',
        resourceType: 'user',
        resourceId: id,
        severity: 'MEDIUM',
        success: true,
        latencyMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      await this.observability.captureRootAction({
        traceId: req.traceId || 'unknown',
        actorUserId: user.sub,
        action: 'AUTH_USER_UNLOCKED',
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
        action: isActive ? 'AUTH_USER_ACTIVATED' : 'AUTH_USER_DEACTIVATED',
        resourceType: 'user',
        resourceId: id,
        severity: isActive ? 'MEDIUM' : 'CRITICAL',
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

  /**
   * CLI browser-based login — step 1 (legacy redirect).
   * Stores state in Redis and redirects the browser to the admin-ui
   * /cli-authorize page (branded login + grant screen, no raw Keycloak UI).
   */
  @Get('cli-login')
  async cliLogin(
    @Res() res: Response,
    @Query('port') portStr: string,
    @Query('nonce') nonce: string,
  ) {
    const port = parseInt(portStr, 10);
    if (!nonce || isNaN(port)) {
      return (res as any).status(400).json({ message: 'port and nonce are required' });
    }
    const authorizeUrl = await this.authService.startCliLogin(port, nonce);
    return res.redirect(authorizeUrl);
  }

  /**
   * CLI browser-based login — step 1 (JSON).
   * Returns the state ID so the CLI can build the authorize URL itself and
   * open the browser directly to app.basefyio.com (avoids Safe Browsing
   * warnings on the API domain).
   */
  @Post('cli-login-state')
  async cliLoginState(
    @Body() body: { port: number; nonce: string },
  ) {
    const { port, nonce } = body;
    if (!nonce || !port || isNaN(port)) {
      throw new BadRequestException('port and nonce are required');
    }
    const authorizeUrl = await this.authService.startCliLogin(port, nonce);
    // Extract cli_state param from the URL
    const url = new URL(authorizeUrl);
    const cliState = url.searchParams.get('cli_state');
    return { cliState, authorizeUrl };
  }

  /**
   * CLI browser-based login — step 2a (info).
   * Returns the loopback port for the given CLI state, so the frontend can
   * build the deny redirect without consuming the state.
   */
  @Get('cli-state')
  @UseGuards(JwtAuthGuard)
  async getCliState(@Query('state') stateId: string) {
    if (!stateId) throw new BadRequestException('state is required');
    const port = await this.authService.getCliStatePort(stateId);
    return { port };
  }

  /**
   * CLI browser-based login — step 2b (grant).
   * The user clicked Allow on /cli-authorize. Consumes the state, wraps the
   * user's current tokens in a one-time exchange code, and returns it to the
   * frontend so it can redirect the loopback server.
   */
  @Post('cli-authorize')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  async cliAuthorize(
    @Body('state') stateId: string,
    @Body('refreshToken') refreshToken: string,
    @Req() req: Request,
  ) {
    if (!stateId || !refreshToken) {
      throw new BadRequestException('state and refreshToken are required');
    }
    // Extract the raw access token from the Authorization header
    const accessToken = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return this.authService.authorizeCliAccess(stateId, accessToken, refreshToken);
  }

  /**
   * CLI browser-based login — step 3.
   * Exchanges the one-time code (received at the loopback server) for real tokens.
   * Returns 404 for any failure to avoid leaking state.
   */
  @Post('cli/exchange')
  @HttpCode(HttpStatus.OK)
  async cliExchange(
    @Body('code') code: string,
    @Body('nonce') nonce: string,
  ) {
    if (!code || !nonce) {
      // Return 404, not 400, to avoid distinguishing error types
      return this.authService.exchangeCliCode('', '');
    }
    return this.authService.exchangeCliCode(code, nonce);
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

      // If this was a CLI flow, redirect the error to the loopback so the CLI doesn't hang
      if (state) {
        const cliState = await this.authService.resolveCliState(state);
        if (cliState) {
          return res.redirect(`http://127.0.0.1:${cliState.port}/callback?error=${encodeURIComponent(msg)}`);
        }
      }

      const loginUrl = `${baseAppUrl}/login?error=${encodeURIComponent(msg)}`;
      return res.redirect(loginUrl);
    }

    try {
      const result = await this.authService.handleOAuthCallback(code, state);

      // CLI flow: redirect browser to the loopback server with the exchange code
      if ((result as any).cliRedirectUrl) {
        return res.redirect((result as any).cliRedirectUrl);
      }

      // Standard web flow: embed tokens in the fragment so the frontend can read them.
      // SECURITY: Only allow relative paths or same-origin redirects to prevent open redirect token theft.
      let redirectPath = result.redirectTo || '/login';
      if (redirectPath.startsWith('http')) {
        try {
          const redirectUrl = new URL(redirectPath);
          const appOrigin = new URL(baseAppUrl);
          if (redirectUrl.origin !== appOrigin.origin) {
            redirectPath = '/login'; // Block external redirect
          }
        } catch {
          redirectPath = '/login';
        }
      } else if (redirectPath.startsWith('//')) {
        redirectPath = '/login'; // Block protocol-relative URLs
      }
      const appUrl = redirectPath.startsWith('http')
        ? redirectPath
        : `${baseAppUrl}${redirectPath}`;

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
