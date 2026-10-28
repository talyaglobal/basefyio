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
import { ProjectAnonymousAuthService } from './project-anonymous-auth.service';
import { SupabaseAuthCompatService } from './supabase-auth-compat.service';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';
import { AuthenticatedKeyOnly } from '../../common/decorators/api-key-scope.decorator';

@Controller('rest/v1/auth')
@UseGuards(ApiKeyGuard)
export class ProjectSdkAuthController {
  constructor(
    private readonly sdkAuth: ProjectSdkAuthService,
    private readonly anonymousAuth: ProjectAnonymousAuthService,
    private readonly gotrue: SupabaseAuthCompatService,
  ) {}

  /**
   * Real end-user IP: Express's answer behind the trusted proxies (`trust
   * proxy` in main.ts). The left-most X-Forwarded-For hop is whatever the
   * client chose to send, so it is not read.
   */
  private clientIp(req: Request): string | undefined {
    const ip = (req.ip || req.socket?.remoteAddress || '').trim();
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

  /**
   * Answers with tokens, or — for a user with an enrolled authenticator — with
   * `{ mfaRequired: true, challengeId }` to be completed at /mfa/challenge.
   * `totp` is for accounts whose authenticator lives in the hosted login.
   */
  @Post('signin')
  async signin(
    @Req() req: Request,
    @Body() body: { email: string; password: string; totp?: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.signin(projectId, body.email, body.password, this.clientIp(req), body.totp);
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

  /**
   * The invitation is the GoTrue one: a password-less user and a link that signs them in.
   * The older flow mailed a link to a route that never existed, so no invitation could be
   * accepted; the facade's invite is the working one, and both routes share it.
   */
  @Post('invite')
  async inviteUser(
    @Req() req: Request,
    @Body() body: { email: string },
  ) {
    const { projectId, role } = this.getPayload(req);
    if (role !== 'service') {
      throw new ForbiddenException('Invite requires service_role key');
    }
    const user = await this.gotrue.invite(projectId, { email: body?.email });
    return { message: `Invitation sent to ${body.email}`, userId: user.id };
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

  // ── Multi-factor authentication ──

  /** Second step of sign-in: the challenge plus a code (or recovery code) releases the parked tokens. */
  @Post('mfa/challenge')
  async completeMfaChallenge(
    @Req() req: Request,
    @Body() body: { challengeId: string; code?: string; recoveryCode?: string },
  ) {
    const { projectId } = this.getPayload(req);
    return this.sdkAuth.completeMfaChallenge(projectId, body?.challengeId, {
      code: body?.code,
      recoveryCode: body?.recoveryCode,
    });
  }

  @Get('mfa')
  @AuthenticatedKeyOnly()
  async mfaStatus(@Req() req: Request) {
    const payload = this.getPayload(req);
    return this.sdkAuth.mfaStatus(payload.projectId, this.requireUser(payload).userId);
  }

  /**
   * Start enrolling an authenticator app. Normally for the signed-in user; when
   * the project enforces enrollment, the sign-in challenge stands in for the
   * session (the password has already been checked).
   */
  @Post('mfa/enroll')
  async enrollMfa(@Req() req: Request, @Body() body: { challengeId?: string }) {
    const payload = this.getPayload(req);
    return this.sdkAuth.beginMfaEnrollment(payload.projectId, this.mfaActor(payload, body?.challengeId));
  }

  @Post('mfa/verify-enrollment')
  async verifyMfaEnrollment(
    @Req() req: Request,
    @Body() body: { code: string; challengeId?: string },
  ) {
    const payload = this.getPayload(req);
    return this.sdkAuth.confirmMfaEnrollment(
      payload.projectId,
      this.mfaActor(payload, body?.challengeId),
      body?.code ?? '',
    );
  }

  /** Needs the factor itself (a code or a recovery code); the service key may reset a user by id. */
  @Post('mfa/disable')
  @AuthenticatedKeyOnly()
  async disableMfa(
    @Req() req: Request,
    @Body() body: { code?: string; recoveryCode?: string; userId?: string },
  ) {
    const payload = this.getPayload(req);
    if (payload.role === 'service' && body?.userId) {
      return this.sdkAuth.disableMfa(payload.projectId, body.userId, { force: true });
    }
    const { userId } = this.requireUser(payload);
    return this.sdkAuth.disableMfa(payload.projectId, userId, {
      code: body?.code,
      recoveryCode: body?.recoveryCode,
    });
  }

  @Post('mfa/recovery-codes')
  @AuthenticatedKeyOnly()
  async regenerateRecoveryCodes(@Req() req: Request, @Body() body: { code: string }) {
    const payload = this.getPayload(req);
    const { userId } = this.requireUser(payload);
    return this.sdkAuth.regenerateMfaRecoveryCodes(payload.projectId, userId, body?.code ?? '');
  }

  // ── Anonymous users ──

  /** A session without an account; off unless the project allows it. */
  @Post('signin/anonymous')
  async signInAnonymously(@Req() req: Request) {
    const { projectId } = this.getPayload(req);
    return this.anonymousAuth.signInAnonymously(projectId, this.clientIp(req));
  }

  /** Turn the anonymous user behind the Bearer token into an email/password account. */
  @Post('anonymous/upgrade')
  @AuthenticatedKeyOnly()
  async upgradeAnonymous(
    @Req() req: Request,
    @Body() body: { email: string; password: string; firstName?: string; lastName?: string },
  ) {
    const payload = this.getPayload(req);
    this.requireUser(payload);
    return this.anonymousAuth.upgradeAnonymous(
      payload.projectId,
      payload.jwtClaims,
      body,
      this.clientIp(req),
    );
  }

  /** The verified end user behind the request, or a clear refusal. */
  private requireUser(payload: ApiKeyPayload): { userId: string; email?: string } {
    const sub = payload.jwtClaims?.sub;
    if (typeof sub !== 'string' || !sub) {
      throw new ForbiddenException(
        "This route acts on the signed-in user. Send the user's access token as a Bearer token alongside the anon key.",
      );
    }
    const email = payload.jwtClaims?.email;
    return { userId: sub, email: typeof email === 'string' ? email : undefined };
  }

  /** A signed-in user when there is one, otherwise the enrollment challenge the body names. */
  private mfaActor(payload: ApiKeyPayload, challengeId?: string) {
    const sub = payload.jwtClaims?.sub;
    if (typeof sub === 'string' && sub) {
      const email = payload.jwtClaims?.email;
      return { userId: sub, email: typeof email === 'string' ? email : undefined };
    }
    return { challengeId };
  }

  private getPayload(req: Request): ApiKeyPayload {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new ForbiddenException('API key required');
    return payload;
  }
}
