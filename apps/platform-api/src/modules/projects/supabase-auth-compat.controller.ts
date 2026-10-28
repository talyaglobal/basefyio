import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiKeyGuard, ApiKeyPayload } from '../../common/guards/api-key.guard';
import {
  AnonKeyAllowed,
  AuthenticatedKeyOnly,
  ServiceKeyOnly,
} from '../../common/decorators/api-key-scope.decorator';
import { SupabaseAuthCompatService } from './supabase-auth-compat.service';
import { GoTrueError, GoTrueExceptionFilter } from './supabase-auth-compat.filter';

/**
 * `/api/auth/v1/*` — the GoTrue (Supabase Auth) API, so `@supabase/supabase-js`
 * and `@supabase/ssr` work against a project unchanged, with
 * `supabaseUrl = https://api.basefyio.com/api`.
 *
 * Every route takes the project's key in `apikey` (the SDK sends it) and the
 * user's token as Bearer where GoTrue does. The guard settles the project and,
 * with the anon key, verifies the Bearer; with the service key it ignores the
 * Bearer, so routes that act on a user re-read it here (`admin.signOut`, a
 * server-side `getUser`). Errors leave in GoTrue's shape through the filter.
 *
 * `GET /authorize` lives on SupabaseAuthOpenController: a browser is sent there
 * by `signInWithOAuth`, with the key in the query or no key at all.
 * Spec: docs/specs/supabase-compat-auth.md.
 */
@Controller('auth/v1')
@UseGuards(ApiKeyGuard)
@UseFilters(GoTrueExceptionFilter)
export class SupabaseAuthCompatController {
  constructor(private readonly auth: SupabaseAuthCompatService) {}

  // ── Sessions ────────────────────────────────────────────────────────────

  @Post('token')
  @AnonKeyAllowed()
  async token(
    @Req() req: Request,
    @Query('grant_type') grantType: string,
    @Body() body: Record<string, any>,
  ) {
    const { projectId } = this.payload(req);
    switch (grantType) {
      case 'password':
        return this.auth.signInWithPassword(projectId, body ?? {}, this.clientIp(req));
      case 'refresh_token':
        return this.auth.refresh(projectId, body?.refresh_token);
      case 'pkce':
        return this.auth.exchangeCode(projectId, body?.auth_code, body?.code_verifier);
      default:
        throw new GoTrueError(400, 'validation_failed', `unsupported_grant_type: ${grantType ?? ''}`);
    }
  }

  @Post('signup')
  @AnonKeyAllowed()
  async signup(
    @Req() req: Request,
    @Body() body: Record<string, any>,
    @Query('redirect_to') redirectTo?: string,
  ) {
    const { projectId } = this.payload(req);
    return this.auth.signup(projectId, body ?? {}, this.clientIp(req), redirectTo);
  }

  @Get('user')
  @AuthenticatedKeyOnly()
  async getUser(@Req() req: Request, @Headers('authorization') authorization?: string) {
    const payload = this.payload(req);
    const token = this.bearer(authorization);
    if (!token) throw new GoTrueError(401, 'no_authorization', 'This endpoint requires a Bearer token');
    await this.requireUser(payload, authorization);
    return this.auth.getUser(payload.projectId, token);
  }

  @Put('user')
  @AuthenticatedKeyOnly()
  async updateUser(
    @Req() req: Request,
    @Body() body: Record<string, any>,
    @Headers('authorization') authorization?: string,
    @Query('redirect_to') redirectTo?: string,
  ) {
    const payload = this.payload(req);
    const user = await this.requireUser(payload, authorization);
    return this.auth.updateUser(payload.projectId, user.userId, body ?? {}, redirectTo);
  }

  @Post('logout')
  @AuthenticatedKeyOnly()
  @HttpCode(204)
  async logout(
    @Req() req: Request,
    @Query('scope') scope?: string,
    @Headers('authorization') authorization?: string,
  ): Promise<void> {
    const payload = this.payload(req);
    const user = await this.requireUser(payload, authorization);
    await this.auth.logout(payload.projectId, user.claims, scope);
  }

  // ── One-time links ──────────────────────────────────────────────────────

  @Post('recover')
  @AnonKeyAllowed()
  async recover(
    @Req() req: Request,
    @Body() body: Record<string, any>,
    @Query('redirect_to') redirectTo?: string,
  ) {
    await this.auth.recover(this.payload(req).projectId, body ?? {}, redirectTo);
    return {};
  }

  @Post('otp')
  @AnonKeyAllowed()
  async otp(
    @Req() req: Request,
    @Body() body: Record<string, any>,
    @Query('redirect_to') redirectTo?: string,
  ) {
    await this.auth.sendOtp(this.payload(req).projectId, body ?? {}, redirectTo);
    return {};
  }

  @Post('resend')
  @AnonKeyAllowed()
  async resend(
    @Req() req: Request,
    @Body() body: Record<string, any>,
    @Query('redirect_to') redirectTo?: string,
  ) {
    await this.auth.resend(this.payload(req).projectId, body ?? {}, redirectTo);
    return {};
  }

  @Post('verify')
  @AnonKeyAllowed()
  async verify(@Req() req: Request, @Body() body: Record<string, any>) {
    return this.auth.verify(this.payload(req).projectId, body ?? {});
  }

  /** The mailed link; the anon key rides in `?apikey=` because a link cannot set headers. */
  @Get('verify')
  @AnonKeyAllowed()
  async verifyLink(
    @Req() req: Request,
    @Res() res: Response,
    @Query('token') token?: string,
    @Query('type') type?: string,
    @Query('redirect_to') redirectTo?: string,
  ) {
    const location = await this.auth.verifyRedirect(this.payload(req).projectId, { token, type, redirect_to: redirectTo });
    res.redirect(303, location);
  }

  // ── Discovery ───────────────────────────────────────────────────────────

  @Get('settings')
  @AnonKeyAllowed()
  settings(@Req() req: Request) {
    return this.auth.settings(this.payload(req).projectId);
  }

  @Get('health')
  @AnonKeyAllowed()
  health() {
    return { version: 'basefyio', name: 'GoTrue', description: 'GoTrue-compatible authentication over the project realm' };
  }

  /** The realm's signing keys, for `supabase.auth.getClaims()`. */
  @Get('.well-known/jwks.json')
  @AnonKeyAllowed()
  async jwks(@Req() req: Request, @Res() res: Response) {
    const keys = await this.auth.jwks(this.payload(req).projectId);
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.json(keys);
  }

  // ── Multi-factor authentication ─────────────────────────────────────────

  @Post('factors')
  @AuthenticatedKeyOnly()
  async enrollFactor(@Req() req: Request, @Body() body: Record<string, any>, @Headers('authorization') authorization?: string) {
    const payload = this.payload(req);
    const user = await this.requireUser(payload, authorization);
    return this.auth.enrollFactor(payload.projectId, user, body ?? {});
  }

  @Post('factors/:factorId/challenge')
  @AuthenticatedKeyOnly()
  async challengeFactor(@Req() req: Request, @Param('factorId') factorId: string, @Headers('authorization') authorization?: string) {
    const payload = this.payload(req);
    const user = await this.requireUser(payload, authorization);
    return this.auth.challengeFactor(payload.projectId, user, factorId);
  }

  @Post('factors/:factorId/verify')
  @AuthenticatedKeyOnly()
  async verifyFactor(
    @Req() req: Request,
    @Param('factorId') factorId: string,
    @Body() body: Record<string, any>,
    @Headers('authorization') authorization?: string,
  ) {
    const payload = this.payload(req);
    const user = await this.requireUser(payload, authorization);
    return this.auth.verifyFactor(payload.projectId, user, factorId, body ?? {});
  }

  @Delete('factors/:factorId')
  @AuthenticatedKeyOnly()
  async unenrollFactor(@Req() req: Request, @Param('factorId') factorId: string, @Headers('authorization') authorization?: string) {
    const payload = this.payload(req);
    const user = await this.requireUser(payload, authorization);
    return this.auth.unenrollFactor(payload.projectId, user.claims, factorId);
  }

  // ── Admin (service key) ─────────────────────────────────────────────────

  @Get('admin/users')
  @ServiceKeyOnly()
  async listUsers(
    @Req() req: Request,
    @Res() res: Response,
    @Query('page') page?: string,
    @Query('per_page') perPage?: string,
  ) {
    const { projectId } = this.payload(req);
    const p = Math.max(1, parseInt(page || '1', 10) || 1);
    // Capped: each user is a full representation, and the SDK pages anyway.
    const n = Math.min(100, Math.max(1, parseInt(perPage || '50', 10) || 50));
    const { users, total } = await this.auth.listUsers(projectId, p, n);
    const last = Math.max(1, Math.ceil(total / n));
    const base = `${req.protocol}://${req.get('host')}${req.baseUrl}${req.path}`;
    // gotrue-js reads the page number from the first `=` of the URL, so `page` goes first.
    const pageUrl = (x: number) => `<${base}?page=${x}&per_page=${n}>`;
    const links = [...(p < last ? [`${pageUrl(p + 1)}; rel="next"`] : []), `${pageUrl(last)}; rel="last"`];
    res.setHeader('X-Total-Count', String(total));
    res.setHeader('Link', links.join(', '));
    res.json({ users, aud: 'authenticated' });
  }

  @Post('admin/users')
  @ServiceKeyOnly()
  async createUser(@Req() req: Request, @Body() body: Record<string, any>) {
    return this.auth.adminCreateUser(this.payload(req).projectId, body ?? {});
  }

  @Get('admin/users/:userId')
  @ServiceKeyOnly()
  async getUserById(@Req() req: Request, @Param('userId') userId: string) {
    return this.auth.adminGetUser(this.payload(req).projectId, userId);
  }

  @Put('admin/users/:userId')
  @ServiceKeyOnly()
  async updateUserById(@Req() req: Request, @Param('userId') userId: string, @Body() body: Record<string, any>) {
    return this.auth.adminUpdateUser(this.payload(req).projectId, userId, body ?? {});
  }

  @Delete('admin/users/:userId')
  @ServiceKeyOnly()
  async deleteUserById(@Req() req: Request, @Param('userId') userId: string) {
    await this.auth.adminDeleteUser(this.payload(req).projectId, userId);
    return {};
  }

  /** The link and code of a mail the caller sends itself. */
  @Post('admin/generate_link')
  @ServiceKeyOnly()
  async generateLink(@Req() req: Request, @Body() body: Record<string, any>, @Query('redirect_to') redirectTo?: string) {
    return this.auth.generateLink(this.payload(req).projectId, body ?? {}, redirectTo);
  }

  @Post('invite')
  @ServiceKeyOnly()
  async invite(@Req() req: Request, @Body() body: Record<string, any>, @Query('redirect_to') redirectTo?: string) {
    return this.auth.invite(this.payload(req).projectId, body ?? {}, redirectTo);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────

  private payload(req: Request): ApiKeyPayload {
    const payload = (req as any).apiKeyPayload as ApiKeyPayload | undefined;
    if (!payload) throw new GoTrueError(401, 'no_api_key', 'No API key found in request');
    return payload;
  }

  private bearer(authorization?: string): string | undefined {
    const token = authorization?.replace(/^bearer /i, '').trim();
    return token && token.split('.').length === 3 ? token : undefined;
  }

  /**
   * The end user a route acts on. With the anon key the guard verified the Bearer; with the
   * service key it did not look at it (the key alone is admin), so the token is verified here —
   * what `admin.signOut(jwt)` and a server-side `getUser(jwt)` rely on.
   */
  private async requireUser(
    payload: ApiKeyPayload,
    authorization?: string,
  ): Promise<{ userId: string; email?: string; claims: Record<string, unknown> }> {
    let claims = payload.jwtClaims;
    if (!claims && payload.role === 'service') {
      const verified = await this.auth.userFromBearer(payload.projectId, authorization);
      if (!verified && this.bearer(authorization)) {
        throw new GoTrueError(401, 'bad_jwt', 'invalid JWT: unable to parse or verify signature');
      }
      claims = verified ?? undefined;
    }
    const sub = claims?.sub;
    if (typeof sub !== 'string' || !sub) {
      throw new GoTrueError(401, 'no_authorization', 'This endpoint requires a Bearer token');
    }
    const email = claims!.email;
    return { userId: sub, email: typeof email === 'string' ? email : undefined, claims: claims! };
  }

  private clientIp(req: Request): string | undefined {
    const ip = (req.ip || req.socket?.remoteAddress || '').trim();
    return ip || undefined;
  }
}
