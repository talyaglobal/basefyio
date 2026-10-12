import { Controller, Get, Param, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ProjectSdkAuthService } from './project-sdk-auth.service';

/**
 * Where the identity provider sends the browser back.
 *
 * This route cannot require an API key, and that is the whole reason it has a
 * controller of its own. The caller is a browser following a redirect issued
 * by Keycloak — it carries no headers we chose, so an apikey can never arrive.
 * The route used to sit on ProjectSdkAuthController, which is guarded, with an
 * empty `@UseGuards()` on the handler in the belief that it cleared the
 * controller's guard. It does not: Nest merges the two lists, and an empty one
 * removes nothing. So every social sign-in reached the provider, came back,
 * and died here on "Missing apikey" — the leg nobody tested, because the trip
 * out looks like success.
 *
 * Leaving it unguarded is correct rather than a concession. What authorises
 * this request is the single-use authorization code, which Keycloak will only
 * exchange for the client and redirect URI it was issued to; an apikey would
 * add nothing an attacker could not also read out of a browser bundle.
 *
 * Keeping it in its own file is deliberate too. A reader seeing a controller
 * with no guard asks why, and the answer is here — which is better than a
 * bypass flag on ApiKeyGuard that the next route could acquire by accident.
 */
@Controller('rest/v1/auth')
export class ProjectOAuthCallbackController {
  constructor(private readonly sdkAuth: ProjectSdkAuthService) {}

  @Get('callback/:projectId/:provider')
  async oauthCallback(
    @Res() res: Response,
    @Param('projectId') projectId: string,
    @Param('provider') provider: string,
    @Query('code') code: string,
    @Query('state') state: string,
  ) {
    const result = await this.sdkAuth.handleOAuthCallback(projectId, provider, code, state);

    // Only a relative path may be followed. An absolute URL here would hand
    // the tokens in the fragment to whatever host it named.
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
}
