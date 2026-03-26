import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';

export interface TeamGitHubStatus {
  connected: boolean;
  login?: string;
  avatarUrl?: string;
  oauthConfigured: boolean;
}

export interface TeamVercelStatus {
  connected: boolean;
  user?: string;
  teamId?: string;
  oauthConfigured: boolean;
}

@Injectable()
export class TeamIntegrationsService {
  private readonly logger = new Logger(TeamIntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly http: HttpService,
  ) {}

  // ── Helpers ──────────────────────────────────────────────────

  private get appUrl(): string {
    return this.config.get<string>('appUrl') || 'http://localhost:3000';
  }

  private get publicApiUrl(): string {
    return this.config.get<string>('publicApiUrl') || 'http://localhost:4000';
  }

  private encodeState(data: Record<string, string>): string {
    return Buffer.from(JSON.stringify(data)).toString('base64url');
  }

  private decodeState(state: string): Record<string, string> {
    try {
      return JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
    } catch {
      return {};
    }
  }

  private async getTeamOrThrow(teamId: string) {
    const team = await this.prisma.team.findUnique({ where: { id: teamId } });
    if (!team) throw new NotFoundException('Team not found');
    return team;
  }

  // ── GitHub ────────────────────────────────────────────────────

  getGitHubOAuthConfigured(): boolean {
    const clientId = this.config.get<string>('oauth.githubTeamsClientId');
    return !!clientId;
  }

  async getGitHubConnectUrl(teamId: string): Promise<string> {
    const clientId = this.config.get<string>('oauth.githubTeamsClientId');
    if (!clientId) {
      throw new BadRequestException(
        'GitHub OAuth is not configured. Set GITHUB_TEAMS_CLIENT_ID and GITHUB_TEAMS_CLIENT_SECRET.',
      );
    }
    await this.getTeamOrThrow(teamId);

    const state = this.encodeState({
      teamId,
      returnUrl: `${this.appUrl}/dashboard/team`,
    });
    const callbackUrl = `${this.publicApiUrl}/api/team-integrations/github/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callbackUrl,
      scope: 'repo read:org',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  }

  async handleGitHubCallback(code: string, state: string): Promise<string> {
    const { teamId, returnUrl } = this.decodeState(state);
    const fallbackUrl = `${this.appUrl}/dashboard/team`;

    if (!teamId) {
      this.logger.error('GitHub callback: missing teamId in state');
      return `${fallbackUrl}?github_error=invalid_state`;
    }

    const clientId = this.config.get<string>('oauth.githubTeamsClientId');
    const clientSecret = this.config.get<string>('oauth.githubTeamsClientSecret');

    try {
      // Exchange code for access token
      const tokenRes = await firstValueFrom(
        this.http.post(
          'https://github.com/login/oauth/access_token',
          { client_id: clientId, client_secret: clientSecret, code },
          { headers: { Accept: 'application/json' }, timeout: 15000 },
        ),
      );

      const accessToken: string = tokenRes.data.access_token;
      if (!accessToken) {
        this.logger.error('GitHub callback: no access_token in response', tokenRes.data);
        const target = returnUrl || fallbackUrl;
        return `${target}?github_error=no_token`;
      }

      // Fetch user info
      const userRes = await firstValueFrom(
        this.http.get('https://api.github.com/user', {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'application/vnd.github+json',
          },
          timeout: 10000,
        }),
      );

      await this.prisma.team.update({
        where: { id: teamId },
        data: {
          githubOAuthToken: accessToken,
          githubOAuthLogin: userRes.data.login,
          githubOAuthAvatar: userRes.data.avatar_url,
        },
      });

      this.logger.log(`GitHub connected for team ${teamId} as ${userRes.data.login}`);
      const target = returnUrl || fallbackUrl;
      return `${target}?github_connected=1`;
    } catch (err: any) {
      const detail = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err?.message;
      this.logger.error(`GitHub OAuth callback error: ${detail}`);
      const target = returnUrl || fallbackUrl;
      return `${target}?github_error=oauth_failed`;
    }
  }

  async getGitHubStatus(teamId: string): Promise<TeamGitHubStatus> {
    const team = await this.getTeamOrThrow(teamId);
    return {
      connected: !!team.githubOAuthToken,
      login: team.githubOAuthLogin ?? undefined,
      avatarUrl: team.githubOAuthAvatar ?? undefined,
      oauthConfigured: this.getGitHubOAuthConfigured(),
    };
  }

  async disconnectGitHub(teamId: string): Promise<void> {
    await this.getTeamOrThrow(teamId);
    await this.prisma.team.update({
      where: { id: teamId },
      data: {
        githubOAuthToken: null,
        githubOAuthLogin: null,
        githubOAuthAvatar: null,
      },
    });
  }

  async listGitHubRepos(teamId: string): Promise<any[]> {
    const team = await this.getTeamOrThrow(teamId);
    if (!team.githubOAuthToken) {
      throw new BadRequestException('GitHub not connected for this team');
    }

    const allRepos: any[] = [];
    let page = 1;
    while (page <= 10) {
      const { data } = await firstValueFrom(
        this.http.get('https://api.github.com/user/repos', {
          headers: {
            Authorization: `Bearer ${team.githubOAuthToken}`,
            Accept: 'application/vnd.github+json',
          },
          params: { per_page: 100, page, sort: 'updated', type: 'all' },
          timeout: 15000,
        }),
      );
      if (!data || data.length === 0) break;
      allRepos.push(
        ...data.map((r: any) => ({
          id: r.id,
          full_name: r.full_name,
          name: r.name,
          owner: r.owner.login,
          private: r.private,
          html_url: r.html_url,
          default_branch: r.default_branch,
          description: r.description,
          updated_at: r.updated_at,
        })),
      );
      if (data.length < 100) break;
      page++;
    }
    return allRepos;
  }

  async listGitHubBranches(teamId: string, owner: string, repo: string): Promise<any[]> {
    const team = await this.getTeamOrThrow(teamId);
    if (!team.githubOAuthToken) {
      throw new BadRequestException('GitHub not connected for this team');
    }
    const { data } = await firstValueFrom(
      this.http.get(`https://api.github.com/repos/${owner}/${repo}/branches`, {
        headers: {
          Authorization: `Bearer ${team.githubOAuthToken}`,
          Accept: 'application/vnd.github+json',
        },
        params: { per_page: 100 },
        timeout: 15000,
      }),
    );
    return (data || []).map((b: any) => ({ name: b.name, protected: b.protected }));
  }

  // ── Vercel ────────────────────────────────────────────────────

  async connectVercelWithToken(teamId: string, token: string): Promise<{ connected: boolean; user: string }> {
    await this.getTeamOrThrow(teamId);

    // Validate token by fetching user info
    let username = 'unknown';
    let vercelTeamId: string | null = null;
    try {
      const userRes = await firstValueFrom(
        this.http.get('https://api.vercel.com/v2/user', {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
        }),
      );
      username =
        userRes.data?.user?.username ||
        userRes.data?.user?.name ||
        userRes.data?.user?.email ||
        'unknown';
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        throw new BadRequestException('Invalid Vercel token. Please check your token and try again.');
      }
      throw new BadRequestException(`Failed to validate Vercel token: ${err.message}`);
    }

    // Try to detect team ID from token scope
    try {
      const teamsRes = await firstValueFrom(
        this.http.get('https://api.vercel.com/v2/teams', {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 10000,
        }),
      );
      const teams = teamsRes.data?.teams || teamsRes.data?.pagination ? teamsRes.data?.teams : [];
      if (Array.isArray(teams) && teams.length === 1) {
        vercelTeamId = teams[0].id;
      }
    } catch {
      // ignore — personal token or no teams
    }

    await this.prisma.team.update({
      where: { id: teamId },
      data: {
        vercelOAuthToken: token,
        vercelOAuthTeamId: vercelTeamId,
        vercelOAuthUser: username,
      },
    });

    this.logger.log(`Vercel connected for team ${teamId} as ${username} (token-based)`);
    return { connected: true, user: username };
  }

  async getVercelStatus(teamId: string): Promise<TeamVercelStatus> {
    const team = await this.getTeamOrThrow(teamId);
    return {
      connected: !!team.vercelOAuthToken,
      user: team.vercelOAuthUser ?? undefined,
      teamId: team.vercelOAuthTeamId ?? undefined,
      oauthConfigured: true,
    };
  }

  async disconnectVercel(teamId: string): Promise<void> {
    await this.getTeamOrThrow(teamId);
    await this.prisma.team.update({
      where: { id: teamId },
      data: {
        vercelOAuthToken: null,
        vercelOAuthTeamId: null,
        vercelOAuthUser: null,
      },
    });
  }

  async listVercelProjects(teamId: string): Promise<any[]> {
    const team = await this.getTeamOrThrow(teamId);
    if (!team.vercelOAuthToken) {
      throw new BadRequestException('Vercel not connected for this team');
    }

    const params: Record<string, string> = { limit: '100' };
    if (team.vercelOAuthTeamId) params.teamId = team.vercelOAuthTeamId;

    const { data } = await firstValueFrom(
      this.http.get('https://api.vercel.com/v9/projects', {
        headers: { Authorization: `Bearer ${team.vercelOAuthToken}` },
        params,
        timeout: 15000,
      }),
    );

    return (data?.projects || []).map((p: any) => ({
      id: p.id,
      name: p.name,
      framework: p.framework || null,
      url: p.link?.deployHooks?.[0]?.url || null,
      updatedAt: p.updatedAt,
    }));
  }
}
