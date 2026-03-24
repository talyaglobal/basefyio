import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { GitHubService } from './github.service';
import { VercelService } from './vercel.service';

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GitHubService,
    private readonly vercel: VercelService,
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
    data: { token: string; owner: string; repo: string; branch?: string },
  ) {
    await this.getProjectWithAccess(projectId, userId);
    await this.github.validateToken(data.token);

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        githubToken: data.token,
        githubOwner: data.owner,
        githubRepo: data.repo,
        githubBranch: data.branch || 'main',
      },
    });

    this.logger.log(`GitHub connected: ${data.owner}/${data.repo} -> project ${projectId}`);
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
    data: { token: string; projectId: string; teamId?: string },
  ) {
    await this.getProjectWithAccess(projectId, userId);
    await this.vercel.validateToken(data.token);

    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        vercelToken: data.token,
        vercelProjectId: data.projectId,
        vercelTeamId: data.teamId || null,
      },
    });

    this.logger.log(`Vercel connected: ${data.projectId} -> project ${projectId}`);
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
}
