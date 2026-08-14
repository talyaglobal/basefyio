import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Req,
  Res,
  Query,
  Headers,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ProjectSdkAuthService } from './project-sdk-auth.service';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';

@Controller('rest/v1/auth')
@UseGuards(ApiKeyGuard)
export class ProjectSdkAuthController {
  constructor(private readonly sdkAuth: ProjectSdkAuthService) {}

  /** Real end-user IP from the proxy chain (first X-Forwarded-For hop). */
  private clientIp(req: Request): string | undefined {
    const xff = req.headers['x-forwarded-for'];
    const raw = Array.isArray(xff) ? xff[0] : xff;
    const ip = (raw ? raw.split(',')[0] : req.ip || req.socket?.remoteAddress || '').trim();
    return ip || undefined;
  }

  @Post('signup')
  async signup(
    @Req() req: Request,
    @Body() body: { email: string; password: string; firstName?: string; lastName?: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.signup(projectId, body, this.clientIp(req));
  }

  @Post('signin')
  async signin(
    @Req() req: Request,
    @Body() body: { email: string; password: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.signin(projectId, body.email, body.password, this.clientIp(req));
  }

  @Post('verify-email')
  async verifyEmail(
    @Req() req: Request,
    @Body() body: { otp: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.verifyEmail(projectId, body.otp);
  }

  /**
   * Target of the "Verify Email" button in the signup mail. A person opens this
   * in a browser, so it answers with a page rather than the JSON the SDK routes
   * return, and the key rides in the query string because a link cannot set
   * headers (the guard only honours the anon key there).
   */
  @Get('verify-email-callback')
  async verifyEmailCallback(
    @Req() req: Request,
    @Query('otp') otp: string,
    @Res() res: Response,
  ) {
    const { projectId } = this.getPayload(req);
    try {
      await this.sdkAuth.verifyEmail(projectId, otp);
      res.type('html').send(
        this.resultPage(
          'Email verified',
          'Your address is confirmed. You can close this tab and sign in.',
          true,
        ),
      );
    } catch (err: any) {
      res
        .status(400)
        .type('html')
        .send(
          this.resultPage(
            'Verification failed',
            err?.message || 'This link is no longer valid. Request a new one and try again.',
            false,
          ),
        );
    }
  }

  /** Minimal self-contained confirmation page — no assets to fetch. */
  private resultPage(title: string, detail: string, ok: boolean): string {
    const accent = ok ? '#0d9488' : '#dc2626';
    const mark = ok ? '&#10003;' : '&#33;';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;background:#f8fafc;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;">
  <div style="max-width:420px;margin:12vh auto;padding:32px;background:#fff;border-radius:16px;
              box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center;">
    <div style="width:56px;height:56px;margin:0 auto 20px;border-radius:50%;
                background:${accent}1a;color:${accent};font-size:28px;line-height:56px;">${mark}</div>
    <h1 style="margin:0 0 10px;font-size:20px;color:#0f172a;">${title}</h1>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#475569;">${detail}</p>
  </div>
</body></html>`;
  }

  @Post('forgot-password')
  async forgotPassword(
    @Req() req: Request,
    @Body() body: { email: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.forgotPassword(projectId, body.email);
  }

  @Post('reset-password')
  async resetPassword(
    @Req() req: Request,
    @Body() body: { otp: string; newPassword: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.resetPassword(projectId, body.otp, body.newPassword);
  }

  @Post('magic-link')
  async sendMagicLink(
    @Req() req: Request,
    @Body() body: { email: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.sendMagicLink(projectId, body.email);
  }

  @Post('magic-link/verify')
  async verifyMagicLink(
    @Req() req: Request,
    @Body() body: { otp: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.verifyMagicLink(projectId, body.otp);
  }

  @Get('magic-link-callback')
  async magicLinkCallback(
    @Req() req: Request,
    @Query('otp') otp: string,
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.verifyMagicLink(projectId, otp);
  }

  @Post('change-email')
  async changeEmail(
    @Req() req: Request,
    @Body() body: { newEmail: string },
    @Headers('authorization') auth?: string,
  ) {
    const { projectId } = this.getPayload(req);
    const token = auth?.replace('Bearer ', '');
    if (!token) throw new ForbiddenException('Missing Authorization header');
    return this.sdkAuth.requestChangeEmail(projectId, token, body.newEmail);
  }

  @Post('change-email/verify')
  async confirmChangeEmail(
    @Req() req: Request,
    @Body() body: { otp: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.confirmChangeEmail(projectId, body.otp);
  }

  @Get('change-email-callback')
  async changeEmailCallback(
    @Req() req: Request,
    @Query('otp') otp: string,
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.confirmChangeEmail(projectId, otp);
  }

  @Post('reauth')
  async requestReauth(
    @Req() req: Request,
    @Headers('authorization') auth?: string,
  ) {
    const { projectId } = this.getPayload(req);
    const token = auth?.replace('Bearer ', '');
    if (!token) throw new ForbiddenException('Missing Authorization header');
    return this.sdkAuth.requestReauth(projectId, token);
  }

  @Post('reauth/verify')
  async verifyReauth(
    @Req() req: Request,
    @Body() body: { otp: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.verifyReauth(projectId, body.otp);
  }

  @Post('invite')
  async inviteUser(
    @Req() req: Request,
    @Body() body: { email: string },
  ) {
    const { projectId, role } = this.getPayload(req);
    if (role !== 'service') {
      throw new ForbiddenException('Invite requires service_role key');
    }
    return this.sdkAuth.inviteUser(projectId, body.email);
  }

  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Body() body: { refreshToken: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.refresh(projectId, body.refreshToken);
  }

  @Get('me')
  async me(
    @Req() req: Request,
    @Headers('authorization') auth?: string,
  ) {
    const { projectId } = this.getPayload(req);
    const token = auth?.replace('Bearer ', '');
    if (!token) throw new ForbiddenException('Missing Authorization header');
    return this.sdkAuth.me(projectId, token);
  }

  @Get('signin/:provider')
  async signinWithProvider(
    @Req() req: Request,
    @Param('provider') provider: string,
    @Query('redirect_to') redirectTo?: string,
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.getOAuthRedirectUrl(projectId, provider, redirectTo);
  }

  @UseGuards()
  @Get('callback/:projectId/:provider')
  async oauthCallback(
    @Res() res: Response,
    @Param('projectId') projectId: string,
    @Param('provider') provider: string,
    @Query('code') code: string,
    @Query('state') state: string,
  ) {
    const result = await this.sdkAuth.handleOAuthCallback(projectId, provider, code, state);

    // SECURITY: Only allow relative paths to prevent open redirect token theft.
    // Absolute URLs (including http://localhost) are rejected — the OAuth flow
    // should redirect back to the same app via a relative path.
    let safeRedirect = result.redirectTo || '/';
    if (
      !safeRedirect.startsWith('/') ||
      safeRedirect.startsWith('//') ||
      safeRedirect.includes('://') ||
      safeRedirect.includes('\\')
    ) {
      safeRedirect = '/';
    }

    const params = new URLSearchParams({
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_in: String(result.expiresIn),
      token_type: result.tokenType || 'Bearer',
      provider,
    });
    res.redirect(`${safeRedirect}#${params.toString()}`);
  }

  private getPayload(req: Request): ApiKeyPayload {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new ForbiddenException('API key required');
    return payload;
  }
}
