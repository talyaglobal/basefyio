import { Controller, Get, Headers, Query, Req, Res, UseFilters } from '@nestjs/common';
import { Request, Response } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { SupabaseAuthCompatService } from './supabase-auth-compat.service';
import { GoTrueError, GoTrueExceptionFilter } from './supabase-auth-compat.filter';

/**
 * `GET /api/auth/v1/authorize` — where `signInWithOAuth` sends the browser.
 *
 * No guard, on purpose and in its own file (the reasoning in
 * project-oauth-callback.controller.ts applies). The browser arrives by
 * navigation, so the only key it can carry is one in the query string; an app
 * whose `supabaseUrl` is `https://api.basefyio.com/api/p/<projectId>` carries
 * none at all, and names the project through the path instead (main.ts turns
 * that prefix into the `x-bf-project` header). The project is taken from one
 * of those two and nothing else — never from `redirect_to` or the Referer,
 * which anyone can set.
 */
@Controller('auth/v1')
@UseFilters(GoTrueExceptionFilter)
export class SupabaseAuthOpenController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: SupabaseAuthCompatService,
  ) {}

  @Get('authorize')
  async authorize(
    @Req() req: Request,
    @Res() res: Response,
    @Query('provider') provider?: string,
    @Query('redirect_to') redirectTo?: string,
    @Query('code_challenge') codeChallenge?: string,
    @Query('code_challenge_method') codeChallengeMethod?: string,
    @Query('apikey') queryKey?: string,
    @Headers('apikey') headerKey?: string,
    @Headers('x-bf-project') projectHeader?: string,
  ) {
    const projectId = await this.resolveProject(headerKey || queryKey, projectHeader);
    const url = await this.auth.authorizeUrl(projectId, {
      provider,
      redirect_to: redirectTo,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
    });
    res.redirect(302, url);
  }

  private async resolveProject(apiKey: string | undefined, projectHeader: string | undefined): Promise<string> {
    if (apiKey) {
      // Only the anon key: the service key must never travel in a URL, and a browser is
      // the only caller here.
      const project = await this.prisma.project.findFirst({
        where: { anonKey: apiKey, status: { in: ['ACTIVE', 'PAUSED'] } },
        select: { id: true },
      });
      if (!project) throw new GoTrueError(401, 'no_api_key', 'Invalid API key');
      return project.id;
    }
    if (projectHeader) {
      const project = await this.prisma.project.findFirst({
        where: { id: projectHeader, status: { in: ['ACTIVE', 'PAUSED'] } },
        select: { id: true },
      });
      if (!project) throw new GoTrueError(404, 'not_found', 'Project not found');
      return project.id;
    }
    throw new GoTrueError(401, 'no_api_key', 'No API key found in request');
  }
}
