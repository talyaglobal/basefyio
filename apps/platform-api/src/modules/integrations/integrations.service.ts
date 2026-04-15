import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubService } from './github.service';
import { VercelService } from './vercel.service';
import {
  ProjectActivityKind,
  ProjectActivityService,
} from '../projects/project-activity.service';
import {
  buildPostgresUri,
  getPgbouncerClientEndpoints,
  getPostgresDirectClientEndpoints,
} from '../projects/postgres-uri.util';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubService,
    private readonly vercel: VercelService,
    private readonly activity: ProjectActivityService,
    private readonly config: ConfigService,
  ) {}

  private async getProjectWithAccess(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, status: { not: 'DELETED' } },
    });
    if (!project) throw new NotFoundException('Project not found');

    const member = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId: project.teamId, userId } },
    });
    if (!member) throw new ForbiddenException('Not a member of this team');

    return project;
  }

  // ── GitHub ──────────────────────────────────────────

  async connectGitHub(
    projectId: string,
    userId: string,
    data: { token?: string; owner: string; repo: string; branch?: string; useTeamToken?: boolean; teamId?: string },
  ) {
    const project = await this.getProjectWithAccess(projectId, userId);

    let resolvedToken = data.token || '';

    if (data.useTeamToken && data.teamId) {
      const team = await this.prisma.team.findUnique({ where: { id: data.teamId } });
      if (team?.githubOAuthToken) {
        resolvedToken = team.githubOAuthToken;
      }
    }

    if (resolvedToken) {
      await this.github.validateToken(resolvedToken);
    }

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        githubToken: resolvedToken || null,
        githubOwner: data.owner,
        githubRepo: data.repo,
        githubBranch: data.branch || 'main',
      },
    });

    this.logger.log(`GitHub connected: ${data.owner}/${data.repo} -> project ${projectId}`);

    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.INTEGRATION_GITHUB_CONNECTED,
      title: 'GitHub connected',
      detail: `${data.owner}/${data.repo} (${data.branch || 'main'})`,
      metadata: { owner: data.owner, repo: data.repo, branch: data.branch || 'main' },
    });

    return { connected: true, owner: data.owner, repo: data.repo, branch: data.branch || 'main' };
  }

  async disconnectGitHub(projectId: string, userId: string) {
    await this.getProjectWithAccess(projectId, userId);

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        githubToken: null,
        githubOwner: null,
        githubRepo: null,
        githubBranch: null,
      },
    });

    this.logger.log(`GitHub disconnected from project ${projectId}`);

    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.INTEGRATION_GITHUB_DISCONNECTED,
      title: 'GitHub disconnected',
    });

    return { connected: false };
  }

  async getGitHubStatus(projectId: string, userId: string) {
    const project = await this.getProjectWithAccess(projectId, userId);

    if (!project.githubToken || !project.githubOwner || !project.githubRepo) {
      return { connected: false };
    }

    return {
      connected: true,
      owner: project.githubOwner,
      repo: project.githubRepo,
      branch: project.githubBranch || 'main',
      repoUrl: `https://github.com/${project.githubOwner}/${project.githubRepo}`,
      token: project.githubToken,
    };
  }

  async listGitHubRepos(projectId: string, userId: string, token: string) {
    await this.getProjectWithAccess(projectId, userId);
    await this.github.validateToken(token);
    return this.github.listRepos(token);
  }

  async getGitHubCommits(projectId: string, userId: string) {
    const project = await this.getProjectWithAccess(projectId, userId);
    if (!project.githubToken || !project.githubOwner || !project.githubRepo) {
      return [];
    }
    return this.github.getCommits(
      project.githubToken,
      project.githubOwner,
      project.githubRepo,
      project.githubBranch || 'main',
    );
  }

  async getGitHubBranches(projectId: string, userId: string) {
    const project = await this.getProjectWithAccess(projectId, userId);
    if (!project.githubToken || !project.githubOwner || !project.githubRepo) {
      return [];
    }
    return this.github.getBranches(
      project.githubToken,
      project.githubOwner,
      project.githubRepo,
    );
  }

  async previewGitHubBranches(
    projectId: string,
    userId: string,
    token: string,
    owner: string,
    repo: string,
  ) {
    await this.getProjectWithAccess(projectId, userId);
    return this.github.getBranches(token, owner, repo);
  }

  // ── Vercel ──────────────────────────────────────────

  async connectVercel(
    projectId: string,
    userId: string,
    data: { token?: string; projectId: string; teamId?: string; useTeamToken?: boolean; sourceTeamId?: string },
  ) {
    const project = await this.getProjectWithAccess(projectId, userId);

    let resolvedToken = data.token || '';
    let resolvedTeamId = data.teamId;

    if (data.useTeamToken && data.sourceTeamId) {
      const team = await this.prisma.team.findUnique({ where: { id: data.sourceTeamId } });
      if (team?.vercelOAuthToken) {
        resolvedToken = team.vercelOAuthToken;
        resolvedTeamId = team.vercelOAuthTeamId || undefined;
      }
    }

    if (resolvedToken) {
      await this.vercel.validateToken(resolvedToken);
    }

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        vercelToken: resolvedToken || null,
        vercelProjectId: data.projectId,
        vercelTeamId: resolvedTeamId || null,
      },
    });

    this.logger.log(`Vercel connected: ${data.projectId} -> project ${projectId}`);

    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.INTEGRATION_VERCEL_CONNECTED,
      title: 'Vercel connected',
      detail: `Vercel project ${data.projectId}`,
      metadata: { vercelProjectId: data.projectId },
    });

    return { connected: true, projectId: data.projectId };
  }

  async disconnectVercel(projectId: string, userId: string) {
    await this.getProjectWithAccess(projectId, userId);

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        vercelToken: null,
        vercelProjectId: null,
        vercelTeamId: null,
      },
    });

    this.logger.log(`Vercel disconnected from project ${projectId}`);

    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.INTEGRATION_VERCEL_DISCONNECTED,
      title: 'Vercel disconnected',
    });

    return { connected: false };
  }

  async getVercelStatus(projectId: string, userId: string) {
    const project = await this.getProjectWithAccess(projectId, userId);

    if (!project.vercelToken || !project.vercelProjectId) {
      return { connected: false };
    }

    const projects = await this.vercel.listProjects(project.vercelToken, project.vercelTeamId);
    const vp = projects.find((p) => p.id === project.vercelProjectId);
    const projectName = vp?.name || project.vercelProjectId;

    const dashboardUrl = await this.vercel.getProjectDashboardUrl(
      project.vercelToken,
      project.vercelProjectId,
      project.vercelTeamId,
    );

    return {
      connected: true,
      projectId: project.vercelProjectId,
      projectName,
      projectUrl: vp?.url || null,
      dashboardUrl,
      token: project.vercelToken,
      teamId: project.vercelTeamId || undefined,
    };
  }

  async listVercelProjects(projectId: string, userId: string, token: string, teamId?: string) {
    await this.getProjectWithAccess(projectId, userId);
    await this.vercel.validateToken(token);
    return this.vercel.listProjects(token, teamId);
  }

  async getVercelDeployments(projectId: string, userId: string) {
    const project = await this.getProjectWithAccess(projectId, userId);
    if (!project.vercelToken || !project.vercelProjectId) {
      return [];
    }
    return this.vercel.getDeployments(
      project.vercelToken,
      project.vercelProjectId,
      project.vercelTeamId,
    );
  }

  async syncEnvToVercel(projectId: string, userId: string) {
    const project = await this.getProjectWithAccess(projectId, userId);

    if (!project.vercelToken || !project.vercelProjectId) {
      throw new BadRequestException('Vercel is not connected for this project');
    }

    const publicApiUrl =
      this.config.get<string>('publicApiUrl') || 'http://localhost:4000';
    const publicBaseUrl = publicApiUrl.replace(/\/+$/, '');

    const { host: poolerHost, port: poolerPort } = getPgbouncerClientEndpoints(this.config);
    const { host: directHost, port: directPort } = getPostgresDirectClientEndpoints(
      this.config,
      poolerHost,
      poolerPort,
    );
    const pooledUrl = buildPostgresUri(
      poolerHost,
      poolerPort,
      project.dbUser,
      project.dbPassword,
      project.dbName,
    );
    const directUrl = buildPostgresUri(
      directHost,
      directPort,
      project.dbUser,
      project.dbPassword,
      project.dbName,
    );
    const restBaseUrl = `${publicBaseUrl}/api/proxy`;

    const vars: Record<string, string> = {
      NEXT_PUBLIC_SUPABASE_URL: restBaseUrl,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: project.anonKey,
      SUPABASE_SERVICE_ROLE_KEY: project.serviceKey,
      DATABASE_URL: pooledUrl,
      DIRECT_URL: directUrl,
      PROJECT_ID: projectId,
    };

    const result = await this.vercel.upsertEnvVars(
      project.vercelToken,
      project.vercelProjectId,
      project.vercelTeamId,
      vars,
    );

    await this.activity.append(projectId, {
      userId,
      kind: ProjectActivityKind.INTEGRATION_VERCEL_CONNECTED,
      title: 'Vercel env vars synced',
      detail: `${result.created} created, ${result.updated} updated`,
    });

    return { synced: true, ...result, keys: Object.keys(vars) };
  }
}
