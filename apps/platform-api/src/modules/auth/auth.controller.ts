import { Controller, Post, Body, Get, Param, Query, Res, UseGuards, Req } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { KeycloakAdminService } from './keycloak-admin.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import {
  CurrentUser,
  JwtPayload,
} from '../../common/decorators/current-user.decorator';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly keycloak: KeycloakAdminService,
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
    });
  }

  @Post('refresh')
  async refresh(@Body('refreshToken') refreshToken: string) {
    return this.authService.refresh(refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  async me(@CurrentUser() user: JwtPayload) {
    await this.authService.ensureUserProfile(
      user.sub,
      user.email,
      user.preferred_username,
    );
    return user;
  }

  @UseGuards(JwtAuthGuard)
  @Post('change-password')
  async changePassword(
    @CurrentUser() user: JwtPayload,
    @Body() body: { currentPassword: string; newPassword: string },
  ) {
    return this.authService.changePassword(
      user.sub,
      user.email,
      body.currentPassword,
      body.newPassword,
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
